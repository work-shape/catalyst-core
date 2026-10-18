import { deferred, eventually } from "./support/assertions";
import { withTestSql } from "./support/test-sql";
import type { JsonValue } from "@work-shape/catalyst-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows, start, writesOf } from "./support/workflow-runs";
import { MemoryObjectStorage } from "./support/memory-object-storage";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
  vi.restoreAllMocks();
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
          ...Object.fromEntries(
            Object.entries(definition(2)).filter(([field]) => field !== "onFailure")
          ),
          description: "Republished between histories"
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
    expect(first?.continuation?.successorRunId).toBe(next.id);
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

  it.each(
    [1, 3, 8].flatMap((concurrency) => [7, 10, 12, 16].map((budget) => ({ concurrency, budget })))
  )(
    "checkpoints nested items once at outer concurrency $concurrency and budget $budget",
    async ({ concurrency, budget }) => {
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
        step.id === "each_client" ? { ...step, concurrency, steps: [before, inner] } : step
      );
      const { t } = await ready({ ...manifest, limits: { stepRuns: budget } });
      await start(t);
      const chain = await finishChain(t);
      expect(chain.some((run) => run.status === "done")).toBe(true);
      expect(chain.every((run) => run.status === "continued" || run.status === "done")).toBe(true);
      expect(writesOf(t)).toHaveLength(12);
      expect(new Set(writesOf(t).map((write) => JSON.stringify(write))).size).toBe(12);
    }
  );

  it("carries a last-key cursor through declared input and continues nonempty pages until the source is empty", async () => {
    const manifest = definition();
    const steps = manifest.steps.map((step) => {
      if (step.id === "clients")
        return { ...step, input: { text: { ref: { step: "start", path: "input.offset" } } } };
      if (step.id === "each_client")
        return { ...step, continueAsNew: { position: "offset", cursor: "id" } };
      return step;
    });
    const { t } = await ready({
      ...manifest,
      steps,
      inputs: {
        type: "object",
        properties: { note: { type: "string" }, offset: { type: "string" } },
        required: ["offset"]
      }
    });
    const cursors: string[] = [];
    t.setBehaviour((operation, input) => {
      if (operation !== "echo") return Promise.resolve<JsonValue>({ received: input });
      const cursor =
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        typeof input.text === "string"
          ? input.text
          : "invalid";
      cursors.push(cursor);
      return Promise.resolve<JsonValue>({
        clients: cursor === "" ? [{ id: "a" }, { id: "b" }] : cursor === "b" ? [{ id: "c" }] : []
      });
    });
    await t.expectOk(t.root.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: "Cursor", offset: "" } }
    });
    const chain = await finishChain(t);
    expect(chain.map((run) => run.status).sort()).toEqual(["continued", "continued", "done"]);
    expect(cursors).toEqual(["", "b", "c"]);
    expect(writesOf(t)).toHaveLength(3);
  });

  it("persists three bounded histories across the real store with exactly one call per dataset row", async () => {
    const objects = new MemoryObjectStorage();
    const reads = vi.spyOn(objects, "get");
    const definitions = publishedDefinitions();
    definitions.publish({ ...definition(), limits: { stepRuns: 20 } });
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: definitions.source, datasetObjects: objects }
    );
    let calls = 0;
    t.setBehaviour((operation, input) =>
      Promise.resolve<JsonValue>(
        operation === "echo"
          ? { clients: Array.from({ length: 50 }, (_, index) => ({ id: String(index) })) }
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
    for (let pass = 0; pass < 100; pass++) {
      await worker.runDue();
      if (calls === 50) {
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
    expect(chain.map((run) => run.stepRunCount)).toEqual([20, 20, 20]);
    expect(chain.reduce((sum, run) => sum + run.stepRunCount, 0)).toBe(60);
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
    expect(calls).toBe(50);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

it.each([1, 2])("cancels the live Lauf by member %i's id", async (member) => {
  const { t } = await ready(definition(1));
  await start(t);
  const worker = t.worker();
  let chain = await runs(t);
  for (let pass = 0; pass < 30 && chain.length < 3; pass++) {
    await worker.runDue();
    chain = await runs(t);
  }
  const prior = chain.find((run) => run.continuation?.number === member);
  const live = chain.find((run) => run.continuation?.number === 3);
  if (!prior || !live) throw new Error("Missing continued members");
  const calls = writesOf(t).length;
  const response = await t.expectOk(t.root.id, "workflows.cancel_run", {
    params: { runId: prior.id }
  });
  expect(response.json()).toMatchObject({ id: live.id, status: "cancelled" });
  await worker.runDue();
  expect(writesOf(t)).toHaveLength(calls);
  expect((await runs(t)).find((run) => run.id === live.id)?.status).toBe("cancelled");
});

it("a cancel pending during handoff wins before the successor claims its trigger", async () => {
  const { t, definitions } = await ready(definition(1));
  const first = await start(t);
  const atHandoff = deferred<void>();
  const release = deferred<void>();
  const read = definitions.source.read;
  let held = false;
  vi.spyOn(definitions.source, "read").mockImplementation(async (id) => {
    // Continuation reads its revision inside the settlement transaction, with the root held.
    if (!held && writesOf(t).length === 1) {
      held = true;
      atHandoff.resolve();
      await release.promise;
    }
    return read(id);
  });
  const worker = t.worker();
  let pending: Promise<unknown> | undefined;
  let cancelling: ReturnType<typeof t.call> | undefined;
  try {
    for (let pass = 0; pass < 20 && !held; pass++) {
      pending = worker.runDue();
      await Promise.race([pending, atHandoff.promise]);
    }
    expect(held).toBe(true);
    cancelling = t.call(t.root.id, "workflows.cancel_run", { params: { runId: first.id } });
    await withTestSql(async (sql) => {
      await eventually(async () => {
        const [row] = await sql<{ waiting: boolean }[]>`
          select exists(select 1 from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid()
              and cardinality(pg_blocking_pids(pid)) > 0
              and query ilike '%workflow_runs%for update%') as waiting`;
        expect(row?.waiting).toBe(true);
      });
    });
    release.resolve();
    await pending;
    const response = await cancelling;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "cancelled", continuation: { number: 2 } });
    await worker.runDue();
    expect(writesOf(t)).toHaveLength(1);
    const chain = await runs(t);
    expect(chain.map((run) => run.status).sort()).toEqual(["cancelled", "continued"]);
    const successor = chain.find((run) => run.status === "cancelled");
    expect(successor?.startedAt).toBeUndefined();
  } finally {
    release.resolve();
    await pending;
    await cancelling;
  }
});

it("fails a cursor Lauf clearly when its source ignores the carried cursor", async () => {
  const manifest = definition();
  const { t } = await ready({
    ...manifest,
    inputs: {
      type: "object",
      properties: { note: { type: "string" }, offset: { type: "string" } },
      required: ["offset"]
    },
    steps: manifest.steps.map((step) =>
      step.id === "each_client"
        ? { ...step, continueAsNew: { position: "offset", cursor: "id" } }
        : step
    )
  });
  await t.expectOk(t.root.id, "workflows.start", {
    params: { workflow: "notify-clients" },
    payload: { input: { note: "Ignored cursor", offset: "" } }
  });
  const chain = await finishChain(t);
  expect(chain.map((run) => run.status).sort()).toEqual(["continued", "failed"]);
  expect(chain.find((run) => run.status === "failed")?.error).toMatchObject({
    code: "continuation_no_progress",
    message: "The continuation cursor did not advance"
  });
});
