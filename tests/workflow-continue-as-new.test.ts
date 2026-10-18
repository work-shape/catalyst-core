import type { JsonValue } from "@work-shape/catalyst-core";
import { afterEach, describe, expect, it } from "vitest";

import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows, start, writesOf } from "./support/workflow-runs";
import { MemoryObjectStorage } from "./support/memory-object-storage";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

function definition(after?: number) {
  return {
    ...notifyClients({ continueAsNew: { position: "offset", ...(after ? { after } : {}) } }),
    labels: { customer: { value: "Acme" } },
    onFailure: "notify" as const,
    limits: { stepRuns: 20_000 },
    inputs: {
      type: "object",
      properties: { note: { type: "string" }, offset: { type: "integer" } },
      required: ["note"]
    },
    steps: notifyClients({
      continueAsNew: { position: "offset", ...(after ? { after } : {}) }
    }).steps.map((step) => (step.id === "clients" ? { ...step, dataset: { at: "clients" } } : step))
  };
}

it("reads continueAsNew as a product-owned loop contract and refuses malformed positions", () => {
  const parsed = parseWorkflowManifest(definition());
  expect(parsed).toMatchObject({ ok: true });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  for (const continueAsNew of [
    { position: "" },
    { position: 7 },
    { position: "offset", after: 0 },
    true
  ]) {
    expect(parseWorkflowManifest(notifyClients({ continueAsNew }))).toMatchObject({ ok: false });
  }
});

async function ready(manifest: unknown = definition(2), options: { now?: () => Date } = {}) {
  const definitions = publishedDefinitions();
  definitions.publish(manifest);
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: definitions.source, datasetObjects: new MemoryObjectStorage(), ...options }
  );
  return { t, definitions };
}
const runs = async (t: WorkflowFixture) =>
  t.stores.workflowRuns.listRuns({
    clientInstanceId,
    workflow: "notify-clients",
    page: { limit: 100 }
  });

async function finishChain(t: WorkflowFixture) {
  const worker = t.worker();
  for (let pass = 0; pass < 100; pass++) {
    await worker.runDue();
    const chain = await runs(t);
    if (chain.some((run) => run.status === "done" || run.status === "failed")) return chain;
  }
  throw new Error("The continuation chain did not end");
}

describe("continue-as-new", () => {
  it("carries labels, input, datasets and onFailure onto a newly published revision without repeating an item", async () => {
    const { t, definitions } = await ready();
    const firstRevision = (await start(t)).definitionRevisionId;
    const worker = t.worker();
    let changedRevision = "";
    for (let pass = 0; pass < 10; pass++) {
      await worker.runDue();
      if (writesOf(t).length === 1) {
        changedRevision = definitions.publish({
          ...definition(2),
          description: "Republished between histories",
          onFailure: undefined
        });
        break;
      }
    }
    const chain = await finishChain(t);
    const first = chain.find((run) => run.continuation?.number === 1);
    const next = chain.find((run) => run.continuation?.number === 2);
    expect(first).toMatchObject({
      status: "continued",
      definitionRevisionId: firstRevision,
      labels: { customer: "Acme" }
    });
    expect(next).toMatchObject({
      status: "done",
      definitionRevisionId: changedRevision,
      labels: { customer: "Acme" },
      continuation: { rootRunId: first?.id, previousRunId: first?.id, number: 2 }
    });
    expect(chain.reduce((sum, run) => sum + run.stepRunCount, 0)).toBe(10); // 3 items + 3 fixed steps per history + final output.
    expect(writesOf(t)).toEqual(
      ["client-anna", "client-bert", "client-cleo"].map((client) => ({
        client,
        note: "Quarterly figures are ready"
      }))
    );
    if (!next) throw new Error("Missing successor");
    expect(
      await t.stores.workflowRuns.readRunInput({ clientInstanceId, id: next.id })
    ).toMatchObject({ offset: 2 });
    expect(
      await t.stores.workflowRuns.readRunDefinition({ clientInstanceId, id: next.id })
    ).toMatchObject({ onFailure: "notify" });
    const wire = await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: next.id } });
    expect(wire.json()).toMatchObject({ continuation: next.continuation, labels: next.labels });
  });

  it("records a failed successor on its published revision and names the incompatible input field", async () => {
    const { t, definitions } = await ready();
    await start(t);
    const worker = t.worker();
    for (let pass = 0; pass < 10; pass++) {
      await worker.runDue();
      if (writesOf(t).length === 1) break;
    }
    const revision = definitions.publish({
      ...definition(),
      inputs: {
        type: "object",
        properties: { note: { type: "string" }, offset: { type: "string" } },
        required: ["offset"]
      }
    });
    const chain = await finishChain(t);
    expect(chain.find((run) => run.continuation?.number === 2)).toMatchObject({
      status: "failed",
      definitionRevisionId: revision,
      error: {
        code: "continuation_invalid",
        message: "The successor input does not fit at '/offset'"
      }
    });
    expect(chain.find((run) => run.continuation?.number === 1)?.status).toBe("continued");
    expect(writesOf(t)).toHaveLength(2);
  });

  it("drains concurrent admitted items before the checkpoint and preserves item order without duplicate calls", async () => {
    const manifest = definition(2);
    manifest.steps = manifest.steps.map((step) =>
      step.id === "each_client" ? { ...step, concurrency: 3 } : step
    );
    const { t } = await ready(manifest);
    await start(t);
    const chain = await finishChain(t);
    expect(chain.map((run) => run.status).sort()).toEqual(["continued", "done"]);
    expect(writesOf(t)).toHaveLength(3);
    expect(new Set(writesOf(t).map((write) => JSON.stringify(write))).size).toBe(3);
  });

  it("continues at the duration boundary after the current item, without losing that item's call", async () => {
    let moment = Date.now();
    const manifest = { ...definition(), limits: { duration: "1m", stepRuns: 20_000 } };
    const { t } = await ready(manifest, { now: () => new Date(moment) });
    let written = 0;
    t.setBehaviour((operation, input) => {
      if (operation === "echo")
        return Promise.resolve<JsonValue>({ clients: [{ id: "1" }, { id: "2" }] });
      if (++written === 1) moment += 60_001;
      return Promise.resolve<JsonValue>({ received: input });
    });
    await start(t);
    const chain = await finishChain(t);
    expect(chain.find((run) => run.continuation?.number === 1)?.status).toBe("continued");
    expect(chain.find((run) => run.continuation?.number === 2)?.status).toBe("done");
    expect(written).toBe(2);
  });

  it("checkpoints a nested loop frontier without repeating the completed steps of its outer item", async () => {
    const manifest = definition();
    const before = {
      id: "before",
      name: "Before inner",
      type: "operation",
      operation: "connection.crm.write",
      input: { client: { ref: { step: "each_client", path: "id" } }, phase: { value: "before" } }
    };
    const inner = {
      id: "inner",
      name: "Inner",
      type: "loop",
      items: { step: "clients", path: "clients" },
      steps: [
        {
          id: "pair",
          name: "Write pair",
          type: "operation",
          operation: "connection.crm.write",
          input: {
            client: { ref: { step: "each_client", path: "id" } },
            inner: { ref: { step: "inner", path: "id" } }
          }
        }
      ]
    };
    manifest.steps = manifest.steps.map((step) =>
      step.id === "each_client" ? { ...step, steps: [before, inner] } : step
    );
    const { t } = await ready({ ...manifest, limits: { stepRuns: 10 } });
    await start(t);
    const chain = await finishChain(t);
    expect(chain.some((run) => run.status === "done")).toBe(true);
    expect(chain.every((run) => run.status === "continued" || run.status === "done")).toBe(true);
    expect(writesOf(t)).toHaveLength(12);
    expect(new Set(writesOf(t).map((write) => JSON.stringify(write))).size).toBe(12);
  });

  it("check 112: continues a 50,000-row dataset at 20,000 step runs into three histories, with exactly one step per row plus fixed steps", async () => {
    const { t } = await ready(definition());
    let calls = 0;
    t.setBehaviour((operation, input) =>
      Promise.resolve<JsonValue>(
        operation === "echo"
          ? { clients: Array.from({ length: 50_000 }, (_, index) => ({ id: String(index) })) }
          : (calls++, { received: input })
      )
    );
    const started = await t.expectOk(t.root.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: "Check 112" }, key: "2026-10-18" }
    });
    expect(started.statusCode).toBe(200);
    const worker = t.worker();
    let ended = false;
    for (let pass = 0; pass < 50_020; pass++) {
      await worker.runDue();
      if (calls === 50_000) {
        await worker.runDue();
        await worker.runDue();
        ended = true;
        break;
      }
    }
    expect(ended).toBe(true);
    const chain = (await runs(t)).sort(
      (a, b) => (a.continuation?.number ?? 1) - (b.continuation?.number ?? 1)
    );
    expect(chain.map((run) => run.status)).toEqual(["continued", "continued", "done"]);
    expect(chain.map((run) => run.stepRunCount)).toEqual([20_000, 20_000, 10_010]);
    expect(chain.reduce((sum, run) => sum + run.stepRunCount, 0)).toBe(50_010);
    expect(chain.map((run) => `${run.runKey}/${run.continuation?.number}`)).toEqual([
      "2026-10-18/1",
      "2026-10-18/2",
      "2026-10-18/3"
    ]);
    for (let index = 1; index < chain.length; index++) {
      const next = chain[index];
      const prior = chain[index - 1];
      if (!next || !prior?.finishedAt) throw new Error("Missing completed history");
      expect(Date.parse(next.createdAt) - Date.parse(prior.finishedAt)).toBeLessThan(60_000);
    }
    expect(calls).toBe(50_000);
  }, 300_000);
});
