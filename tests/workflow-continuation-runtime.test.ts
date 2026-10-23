import { afterEach, expect, it, vi } from "vitest";
import type { JsonValue, WorkflowManifest, WorkflowStep } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import {
  NOTE,
  notifyClients,
  readyWorkflows,
  start,
  stepRunsOf,
  writesOf
} from "./support/workflow-runs";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { withTestSql } from "./support/test-sql";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
  vi.restoreAllMocks();
});
const ref = (step: string, path: string) => ({ ref: { step, path } });

// Shapes from the round-four verifier: a budget-five dataset loop, a parent waiting on
// that child, and an onItemFailure loop whose first item fails before the first handoff.
function continuing(id = "notify-clients", budget = 5, cursor = false) {
  const base = notifyClients({
    continueAsNew: { position: "offset", ...(cursor ? { cursor: "id" } : {}) },
    onItemFailure: "continue"
  });
  return {
    ...base,
    id,
    limits: { stepRuns: budget },
    inputs: {
      type: "object",
      properties: { note: { type: "string" }, offset: { type: cursor ? "string" : "integer" } },
      required: ["note"]
    },
    steps: base.steps.map((step) =>
      step.id === "start"
        ? { ...step, triggers: [{ kind: "manual" }, { kind: "parent" }] }
        : step.id === "clients"
          ? {
              ...step,
              dataset: { at: "clients" },
              ...(cursor ? { input: { text: ref("start", "input.offset") } } : {})
            }
          : step
    )
  };
}
function parent(child = "child-can", prefix: WorkflowStep[] = []): WorkflowManifest {
  return {
    id: "parent",
    name: "Parent",
    runAs: "workflow-runner",
    inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      ...prefix,
      {
        id: "kid",
        name: "Child",
        type: "workflow",
        workflow: child,
        input: { note: ref("start", "input.note") }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { sent: ref("kid", "sent"), failed: ref("kid", "failed") }
      }
    ]
  };
}
async function ready(...manifests: unknown[]) {
  const definitions = publishedDefinitions();
  for (const manifest of manifests) definitions.publish(manifest);
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    {
      definitions: definitions.source,
      datasetObjects: new MemoryObjectStorage()
    }
  );
  await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
  return { t, definitions };
}
async function chain(t: WorkflowFixture, workflow: string) {
  return (
    await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow, page: { limit: 100 } })
  ).sort((a, b) => (a.continuation?.number ?? 1) - (b.continuation?.number ?? 1));
}
async function finish(t: WorkflowFixture, workflow: string) {
  const worker = t.worker();
  for (let pass = 0; pass < 150; pass++) {
    await worker.runDue();
    const runs = await chain(t, workflow);
    if (runs.some((run) => ["done", "failed", "limit_reached", "cancelled"].includes(run.status)))
      return runs;
  }
  throw new Error(`Chain did not end: ${JSON.stringify(await chain(t, workflow))}`);
}
function failFirst(t: WorkflowFixture) {
  t.setBehaviour((operation, input) =>
    operation === "echo"
      ? Promise.resolve({
          clients: [{ id: "client-anna" }, { id: "client-bert" }, { id: "client-cleo" }]
        })
      : JSON.stringify(input).includes("client-anna")
        ? Promise.reject(new Error("down"))
        : Promise.resolve({ received: input })
  );
}

it.each([5])(
  "carries all loop totals and later-step counts after first-item failure at budget %s",
  async (budget) => {
    const { t } = await ready(continuing("notify-clients", budget));
    failFirst(t);
    await start(t);
    const runs = await finish(t, "notify-clients");
    const last = runs.at(-1);
    expect(last?.status).toBe("done");
    if (!last) throw new Error("Missing last run");
    expect(await t.stores.workflowRuns.readRunOutput({ clientInstanceId, id: last.id })).toEqual({
      value: { sent: 2, failed: 1 }
    });
    const loop = (await stepRunsOf(t, last.id)).find((step) => step.stepId === "each_client");
    expect(JSON.parse(loop?.outputPreview?.text ?? "null")).toMatchObject({
      total: 3,
      done: 2,
      failed: 1
    });
    expect(last.failedItemCount).toBe(1);
    const listed = await t.expectOk(t.root.id, "workflows.list_runs", {
      params: { workflow: "notify-clients" }
    });
    expect(listed.json().items).toContainEqual(
      expect.objectContaining({
        id: last.id,
        status: "done",
        failedItemCount: 1
      })
    );
    const workflows = await t.expectOk(t.root.id, "workflows.list");
    expect(workflows.json().items).toContainEqual(
      expect.objectContaining({
        id: "notify-clients",
        lastRun: expect.objectContaining({ id: last.id, failedItemCount: 1 })
      })
    );
    expect(writesOf(t)).toHaveLength(3);
    if (budget === 5) expect(runs.length).toBeGreaterThan(1);
  }
);

it.each([false, true])(
  "finishes a continuing child's dataset chain once and reports its whole total to the parent (failure=%s)",
  async (failure) => {
    const { t } = await ready(continuing("child-can"), parent());
    if (failure) failFirst(t);
    await start(t, t.root.id, "parent");
    const parents = await finish(t, "parent");
    expect(parents).toHaveLength(1);
    const run = parents[0];
    if (!run) throw new Error("Missing parent");
    expect(run.status).toBe("done");
    const detail = await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: run.id } });
    expect(detail.json().failedDescendantCount).toBe(failure ? 1 : 0);
    expect(
      await t.stores.workflowNotices.failureCount({ clientInstanceId, rootRunId: run.id })
    ).toBe(failure ? 1 : 0);

    expect((await chain(t, "child-can")).map((part) => part.status)).toEqual([
      "continued",
      "continued",
      "done"
    ]);
    expect(writesOf(t)).toHaveLength(3);
    expect(new Set(writesOf(t).map((write) => JSON.stringify(write))).size).toBe(3);
    expect(await t.stores.workflowRuns.readRunOutput({ clientInstanceId, id: run.id })).toEqual({
      value: { sent: failure ? 2 : 3, failed: failure ? 1 : 0 }
    });
  }
);

it("carries counts across cursor pages without replaying an old page", async () => {
  const { t } = await ready(continuing("notify-clients", 7, true));
  t.setBehaviour((operation, input) => {
    const text = JSON.stringify(input);
    return Promise.resolve<JsonValue>(
      operation === "echo"
        ? {
            clients: text.includes('"text":""')
              ? [{ id: "a" }, { id: "b" }]
              : text.includes('"text":"b"')
                ? [{ id: "c" }]
                : []
          }
        : { received: input }
    );
  });
  await t.expectOk(t.root.id, "workflows.start", {
    params: { workflow: "notify-clients" },
    payload: { input: { note: NOTE, offset: "" } }
  });
  const runs = await finish(t, "notify-clients");
  const last = runs.at(-1);
  expect(runs.map((run) => run.status)).toEqual(["continued", "continued", "done"]);
  if (!last) throw new Error("Missing final page");
  expect(await t.stores.workflowRuns.readRunOutput({ clientInstanceId, id: last.id })).toEqual({
    value: { sent: 3, failed: 0 }
  });
  expect(writesOf(t)).toHaveLength(3);
});

it("records an opening refusal as continuation_invalid after one write without retrying the step", async () => {
  const { t, definitions } = await ready(continuing());
  const read = definitions.source.read;
  let expired = false;
  vi.spyOn(definitions.source, "read").mockImplementation(async (id) => {
    if (!expired && writesOf(t).length === 1) {
      expired = true;
      // Refuse the carried dataset during open, after prepare has accepted the revision.
      await withTestSql(async (sql) => {
        await sql`update workflow_run_datasets set state = 'deleted'`;
      });
    }
    return read(id);
  });
  await start(t);
  const runs = await finish(t, "notify-clients");
  expect(expired).toBe(true);
  expect(runs.map((run) => run.status)).toEqual(["continued", "failed"]);
  expect(runs[1]?.error).toEqual({
    code: "continuation_invalid",
    message: "The successor could not open (NOT_FOUND)"
  });
  expect(writesOf(t)).toHaveLength(1);
  const first = runs[0];
  if (!first) throw new Error("Missing first history");
  const steps = await stepRunsOf(t, first.id);
  expect(steps.find((step) => step.stepId === "send")).toMatchObject({
    status: "done",
    attempt: 1
  });
});

it("keeps a dataset explicitly handed down by a parent readable throughout the child chain", async () => {
  const base = continuing("child-can", 4);
  const child = {
    ...base,
    inputs: {
      ...base.inputs,
      properties: { ...base.inputs.properties, rows: { type: "dataset", row: { type: "object" } } },
      required: ["note", "rows"]
    },
    steps: base.steps
      .filter((step) => step.id !== "clients")
      .map((step) =>
        step.id === "each_client" ? { ...step, items: { step: "start", path: "input.rows" } } : step
      )
  };
  const outer = parent("child-can", [
    {
      id: "rows",
      name: "Rows",
      type: "operation",
      operation: "connection.crm.echo",
      input: { text: { value: NOTE } },
      dataset: { at: "clients" }
    }
  ]);
  outer.steps = outer.steps.map((step) =>
    step.id === "kid" && step.type === "workflow"
      ? { ...step, input: { note: ref("start", "input.note"), rows: ref("rows", "clients") } }
      : step
  );
  const { t } = await ready(child, outer);
  await start(t, t.root.id, "parent");
  const parents = await finish(t, "parent");
  expect(parents[0]?.status, JSON.stringify(parents[0])).toBe("done");
  const run = parents[0];
  if (!run) throw new Error("Missing parent");
  expect(await t.stores.workflowRuns.readRunOutput({ clientInstanceId, id: run.id })).toEqual({
    value: { sent: 3, failed: 0 }
  });
  expect(writesOf(t)).toHaveLength(3);
});

it.each(["sibling", "another chain"])(
  "a successor cannot read a %s dataset that its parent never handed it",
  async (owner) => {
    const producer = {
      ...notifyClients(),
      id: "producer",
      outputs: {
        type: "object",
        properties: { rows: { type: "dataset", row: { type: "object" } } }
      },
      steps: [
        {
          id: "start",
          name: "Start",
          type: "trigger",
          triggers: [{ kind: "manual" }, { kind: "parent" }]
        },
        {
          id: "rows",
          name: "Rows",
          type: "operation",
          operation: "connection.crm.echo",
          input: { text: { value: NOTE } },
          dataset: { at: "clients" }
        },
        { id: "result", name: "Result", type: "output", input: { rows: ref("rows", "clients") } }
      ]
    };
    const base = continuing("child-can");
    const outer = parent(
      "child-can",
      owner === "sibling"
        ? [
            {
              id: "producer",
              name: "Sibling",
              type: "workflow",
              workflow: "producer",
              input: { note: ref("start", "input.note") }
            }
          ]
        : []
    );
    const { t, definitions } = await ready(producer, base, outer);
    if (owner === "another chain")
      expect((await t.finish((await start(t, t.root.id, "producer")).id)).status).toBe("done");
    await start(t, t.root.id, "parent");
    const read = definitions.source.read;
    let forged = false;
    vi.spyOn(definitions.source, "read").mockImplementation(async (id) => {
      if (id === "child-can" && !forged && writesOf(t).length === 1) {
        const source = (await chain(t, "producer"))[0];
        if (!source) throw new Error("Missing dataset owner");
        const output = await t.stores.workflowRuns.readRunOutput({
          clientInstanceId,
          id: source.id
        });
        if (
          !output ||
          typeof output.value !== "object" ||
          output.value === null ||
          Array.isArray(output.value)
        )
          throw new Error("Missing dataset reference");
        const [record] = await t.stores.workflowRunDatasets.listForRun({
          clientInstanceId,
          runId: source.id,
          limit: 10
        });
        const outerRun = (await chain(t, "parent"))[0];
        const predecessor = (await chain(t, "child-can"))[0];
        if (!record || !outerRun || !predecessor) throw new Error("Missing access subjects");
        expect(
          await t.stores.workflowRunDatasets.canRead({
            clientInstanceId,
            id: record.id,
            runId: outerRun.id
          })
        ).toBe(owner === "sibling");
        expect(
          await t.stores.workflowRunDatasets.canRead({
            clientInstanceId,
            id: record.id,
            runId: predecessor.id
          })
        ).toBe(false);
        // A revised Workflow knows the reference but receives no grant by knowing its id.
        const rows = output.value.rows;
        definitions.publish({
          ...base,
          steps: base.steps.map((step) =>
            step.id === "result" ? { ...step, input: { rows: { value: rows } } } : step
          )
        });
        forged = true;
      }
      return read(id);
    });
    await finish(t, "parent");
    const kids = await chain(t, "child-can");
    expect(forged).toBe(true);
    expect(kids.slice(0, -1).every((run) => run.status === "continued")).toBe(true);
    expect(kids.at(-1)).toMatchObject({ status: "failed", error: { code: "FORBIDDEN" } });
    expect(writesOf(t)).toHaveLength(3);
  }
);

it("reports the same failure totals without continuation", async () => {
  const base = notifyClients({ onItemFailure: "continue" });
  const { t } = await ready({
    ...base,
    limits: { stepRuns: 20_000 },
    steps: base.steps.map((step) =>
      step.id === "clients" ? { ...step, dataset: { at: "clients" } } : step
    )
  });
  failFirst(t);
  await start(t);
  const runs = await finish(t, "notify-clients");
  expect(runs).toHaveLength(1);
  const final = runs[0];
  if (!final) throw new Error("Missing unsplit run");
  expect(final.status).toBe("done");
  expect(await t.stores.workflowRuns.readRunOutput({ clientInstanceId, id: final.id })).toEqual({
    value: { sent: 2, failed: 1 }
  });
});
