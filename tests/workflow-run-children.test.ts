import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type AuditEvent,
  type JsonValue,
  type StorePage,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import { ref, child, parent, start, children } from "./support/workflow-children";
import { clientInstanceId } from "./support/access-instance";
import {
  hangingAt,
  publishedDefinitions,
  runSchema,
  type WorkflowFixture
} from "./support/workflow-instance";
import { readyChildWorkflows } from "./support/workflow-children-instance";
import { readyWorkflows, stepRunsOf } from "./support/workflow-runs";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const ready = (
  definitions = publishedDefinitions(),
  options: { now?: () => Date; duration?: number } = {}
) =>
  readyChildWorkflows(
    (fixture) => {
      open = fixture;
    },
    definitions,
    options
  );
describe("Workflow child runs", () => {
  it("waits without a step job, wakes after restart and returns the whole child output with lineage", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent());
    const t = await ready(definitions);
    const started = await start(t);
    const worker = t.worker();
    await worker.runDue();
    await worker.runDue();
    const [waiting] = (await stepRunsOf(t, started.id)).filter((s) => s.stepId === "child");
    expect(waiting).toMatchObject({ status: "waiting", operationRunId: expect.any(String) });
    const [spawned] = await children(t, started.id);
    expect(spawned).toMatchObject({
      parentRunId: started.id,
      parentStepRunId: waiting?.id,
      rootRunId: started.id,
      depth: 1,
      trigger: "parent",
      startedBy: { id: t.root.id }
    });
    expect(
      (
        await t.stores.jobs.listOverview({ clientInstanceId, filters: {}, page: { limit: 100 } })
      ).filter((j) => j.subject === waiting?.id && ["queued", "running"].includes(j.status))
    ).toEqual([]);
    await worker.stop();
    const done = await t.finish(started.id, t.worker());
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: "done" });
    expect(JSON.parse(done.outputPreview?.text ?? "null")).toEqual({ result: { value: "7" } });
    expect(await children(t, started.id)).toHaveLength(1);
    const api = (
      await t.expectOk(t.root.id, "workflows.get_run", {
        params: { runId: spawned?.id ?? "missing" }
      })
    ).json();
    expect(api).toMatchObject({ rootRunId: started.id, parentRunId: started.id, depth: 1 });
  });

  it("recovers a child start whose parent attempt died before settling, with one child and one call", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent());
    const t = await ready(definitions);
    const started = await start(t);
    const dying = hangingAt(t.workflows.jobHandlers, 4);
    const worker = t.worker(dying.handlers);
    let reached = false;
    const arrived = dying.reached.then(() => {
      reached = true;
    });
    for (let pass = 0; pass < 20 && !reached; pass++)
      await Promise.race([worker.runDue(), arrived]);
    expect(reached).toBe(true);
    expect(await children(t, started.id)).toHaveLength(1);
    await worker.stop();
    expect((await t.finish(started.id, t.worker())).status).toBe("done");
    expect(await children(t, started.id)).toHaveLength(1);
    expect(t.executed).toHaveLength(1);
  });

  it("runs the child as its own principal and checks the parent's right again at start", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child("child", "child-account"));
    definitions.publish(parent());
    const t = await ready(definitions);
    const principal = await t.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "child-account"
    });
    await t.allow({ kind: "service_principal", id: principal.id }, "connection.use");
    const started = await start(t);
    expect((await t.finish(started.id)).status).toBe("done");
    expect((await children(t, started.id))[0]?.principal.id).toBe(principal.id);
    const grants = await t.stores.access.listGrants({ clientInstanceId });
    for (const grant of grants.filter(
      (g) => g.holderId === t.principal.id && g.action === "workflow.use"
    ))
      await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
    const denied = await t.finish((await start(t)).id);
    expect(denied).toMatchObject({ status: "failed", error: { code: "FORBIDDEN" } });
    expect(await children(t, denied.id)).toEqual([]);
  });

  it("bounds child depth to root, child and grandchild even if published edges changed", async () => {
    const definitions = publishedDefinitions();
    for (let n = 0; n < 4; n++) {
      const value = parent(n === 3 ? "leaf" : `level-${n + 1}`);
      definitions.publish({ ...value, id: `level-${n}` });
    }
    definitions.publish(child("leaf"));
    const t = await ready(definitions);
    const root = await start(t, "level-0");
    const failed = await t.finish(root.id);
    expect(failed).toMatchObject({ status: "failed", error: { code: "depth_limit" } });
    const [first] = await children(t, root.id);
    const [second] = await children(t, first?.id ?? "");
    expect(second).toMatchObject({ depth: 2, rootRunId: root.id });
    expect(await children(t, second?.id ?? "")).toHaveLength(0);
  });

  it("cancels every open descendant, audits each once and starts no more items", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent("child", 600));
    const t = await ready(definitions);
    t.setBehaviour((_operation, input) =>
      Promise.resolve<JsonValue>(
        z.object({ text: z.string() }).parse(input).text === "items"
          ? { items: Array.from({ length: 600 }, (_, i) => String(i)) }
          : { value: "1" }
      )
    );
    const started = await start(t);
    const worker = t.worker();
    for (let n = 0; n < 4; n++) await worker.runDue();
    expect(await children(t, started.id)).toHaveLength(4);
    await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: started.id } });
    for (let n = 0; n < 3; n++) await worker.runDue();
    expect((await children(t, started.id)).map((r) => r.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled"
    ]);
    await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: started.id } });
    const cancelledChildren = await children(t, started.id);
    const audit: AuditEvent[] = [];
    for (let after: StorePage["after"]; ;) {
      const page = await t.stores.audit.listAuditEvents({
        clientInstanceId,
        type: "workflow_run.cancelled",
        page: { limit: 2, ...(after ? { after } : {}) }
      });
      audit.push(...page);
      const last = page.at(-1);
      if (!last) break;
      after = [last.createdAt, last.id];
    }
    const childAudit = audit.filter((event) =>
      cancelledChildren.some((run) => run.id === event.subject)
    );
    expect(childAudit).toHaveLength(cancelledChildren.length);
    for (const run of cancelledChildren) {
      const events = childAudit.filter((event) => event.subject === run.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        status: "success",
        correlationId: run.correlationId,
        metadata: {
          workflow: run.workflow,
          definitionRevisionId: run.definitionRevisionId,
          parentRunId: started.id
        }
      });
    }
  });

  it("ends a waiting parent at its deadline and cascades cancellation", async () => {
    let now = Date.now();
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent());
    const t = await ready(definitions, { now: () => new Date(now), duration: 10_000 });
    const started = await start(t);
    const worker = t.worker();
    await worker.runDue();
    await worker.runDue();
    now += 11_000;
    expect((await t.finish(started.id, worker)).status).toBe("limit_reached");
    expect((await children(t, started.id))[0]?.status).toBe("limit_reached");
  });

  it("runs 600 children with three steps each, concurrency four, and continues past a failed child", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent("child", 600));
    const t = await ready(definitions);
    let openMax = 0;
    t.setBehaviour(async (_operation, input): Promise<JsonValue> => {
      if (z.object({ text: z.string() }).parse(input).text === "items")
        return { items: Array.from({ length: 600 }, (_, i) => String(i)) };
      const value = z.object({ text: z.string() }).parse(input).text;
      if (value === "412") throw new Error("Item failed");
      return { value };
    });
    const started = await start(t);
    const worker = t.worker();
    for (let pass = 0; pass < 2_000; pass++) {
      await worker.runDue();
      const runs = await children(t, started.id);
      openMax = Math.max(
        openMax,
        runs.filter((r) => ["queued", "running", "waiting"].includes(r.status)).length
      );
      const root = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id });
      if (root?.finishedAt) break;
    }
    const done = runSchema.parse(
      (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: started.id } })).json()
    );
    expect(done.status).toBe("done");
    expect(JSON.parse(done.outputPreview?.text ?? "null")).toEqual({
      result: { total: 600, done: 599, failed: 1 }
    });
    expect(openMax).toBe(4);
    const runs = await children(t, started.id);
    expect(runs).toHaveLength(600);
    expect(runs.every((r) => r.stepRunCount <= 3)).toBe(true);
    expect(runs.find((r) => r.itemIndex === 599)).toBeDefined();
  }, 300_000);
});

async function assets() {
  const t = await readyWorkflows(
    (f) => {
      open = f;
    },
    { definitions: "assets" }
  );
  t.setBehaviour((_operation, input) =>
    Promise.resolve({ value: z.object({ text: z.string() }).parse(input).text })
  );
  return t;
}
async function put(
  t: WorkflowFixture,
  manifest: WorkflowManifest,
  expectedRevision: number | null = null
) {
  const response = await t.expectOk(t.root.id, "assets.put", {
    params: { kind: "workflow", name: manifest.id },
    payload: { expectedRevision, config: { name: manifest.id, manifest } }
  });
  return z.object({ revision: z.number() }).parse(response.json()).revision;
}
async function publish(t: WorkflowFixture, workflow: string, revision = 1) {
  return t.call(t.root.id, "assets.publish", {
    params: { kind: "workflow", name: workflow },
    payload: { revision }
  });
}

describe("child Workflow contracts and publish checks", () => {
  it("refuses an unpublished child, bad mapped input, and dataset contracts at save", async () => {
    const t = await assets();
    const save = (manifest: WorkflowManifest) =>
      t.call(t.root.id, "assets.put", {
        params: { kind: "workflow", name: manifest.id },
        payload: { expectedRevision: null, config: { name: manifest.id, manifest } }
      });
    expect((await save(parent())).json()).toMatchObject({
      error: { details: { reason: "child_unpublished" } }
    });
    await put(t, child());
    expect((await publish(t, "child")).statusCode).toBe(200);
    const bad = parent();
    const call = bad.steps[1];
    if (call?.type !== "workflow") throw new Error("Missing child step");
    call.input = { value: { value: 7 } };
    expect((await save(bad)).json()).toMatchObject({
      error: { details: { reason: "child_input_invalid" } }
    });
    call.input = {};
    expect((await save(bad)).json()).toMatchObject({
      error: { details: { reason: "child_input_invalid" } }
    });
    const strict = child();
    strict.outputs = {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false
    };
    await put(t, strict, 1);
    expect((await publish(t, "child", 2)).statusCode).toBe(200);
    const wrongOutput = parent();
    const result = wrongOutput.steps.at(-1);
    if (result?.type !== "output") throw new Error("Missing output");
    result.input = { result: ref("child", "missing") };
    expect((await save(wrongOutput)).json()).toMatchObject({
      error: { details: { reason: "child_output_invalid" } }
    });
    expect(
      (
        await save({
          ...child("dataset-child"),
          outputs: { type: "object", properties: { rows: { type: "dataset" } } }
        })
      ).json()
    ).toMatchObject({ error: { details: { reason: "not_supported_yet" } } });
  });

  it("refuses a missing parent trigger and missing workflow.use, and refuses a cycle through published revisions", async () => {
    const t = await assets();
    const noParent = child();
    const trigger = noParent.steps[0];
    if (trigger?.type !== "trigger") throw new Error("Missing trigger");
    trigger.triggers = [{ kind: "manual" }];
    await put(t, noParent);
    expect((await publish(t, "child")).statusCode).toBe(200);
    await put(t, parent());
    expect((await publish(t, "parent")).json()).toMatchObject({
      error: { details: { reason: "no_parent_trigger" } }
    });
    await put(t, child(), 1);
    expect((await publish(t, "child", 2)).statusCode).toBe(200);
    expect((await publish(t, "parent")).json()).toMatchObject({
      error: { details: { reason: "child_use_forbidden", action: "workflow.use" } }
    });
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    expect((await publish(t, "parent")).statusCode).toBe(200);
    await put(t, { ...parent("parent"), id: "child" }, 2);
    expect((await publish(t, "child", 3)).json()).toMatchObject({
      error: { details: { reason: "workflow_cycle" } }
    });
    // The refused revision is still a draft; the old child remains live.
    expect((await t.finish((await start(t)).id)).status).toBe("done");
  });

  it("runs a published child in test mode, retaining its revision and the root tester", async () => {
    const t = await assets();
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    await put(t, child());
    expect((await publish(t, "child")).statusCode).toBe(200);
    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "workflow",
      name: "child"
    });
    await put(t, parent());
    const tested = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.test", {
          params: { workflow: "parent" },
          payload: { input: {} }
        })
      ).json()
    );
    expect((await t.finish(tested.id)).status).toBe("done");
    expect((await children(t, tested.id))[0]).toMatchObject({
      mode: "test",
      definitionRevisionId: asset?.publishedRevisionId,
      startedBy: { id: t.root.id }
    });
  });

  it("refuses starts of a parent-only Workflow by a person, agent, App and schedule", async () => {
    const t = await assets();
    await put(t, child());
    expect((await publish(t, "child")).statusCode).toBe(200);
    const response = await t.call(t.root.id, "workflows.start", {
      params: { workflow: "child" },
      payload: { input: { value: "7" } }
    });
    expect(response.json()).toMatchObject({ error: { details: { reason: "no_manual_trigger" } } });
    const { agentOrigin, appOrigin } = await import("./support/connection-operations");
    for (const origin of [
      agentOrigin("workflow.child.start"),
      appOrigin,
      { kind: "schedule" as const, scheduleId: "test" }
    ]) {
      const outcome = await t.invoke(
        t.root,
        "workflow.child.start",
        { value: "7" },
        { origin, effect: "changing", idempotencyKey: `parent-only-${origin.kind}` }
      );
      expect(["failed", "denied"]).toContain(outcome.result.status);
    }
    expect(await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: "child" })).toEqual(
      []
    );
  });
});

describe("concurrent Workflow publication", () => {
  it("refuses one of two publishes that together would create a cycle", async () => {
    const t = await assets();
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    for (const name of ["left", "right"]) {
      await put(t, {
        ...child(name),
        steps: [
          {
            id: "start",
            name: "Start",
            type: "trigger",
            triggers: [{ kind: "parent" }, { kind: "manual" }]
          },
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      });
      expect((await publish(t, name)).statusCode).toBe(200);
    }
    await put(t, { ...parent("right"), id: "left" }, 1);
    await put(t, { ...parent("left"), id: "right" }, 1);
    const responses = await Promise.all([publish(t, "left", 2), publish(t, "right", 2)]);
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(responses.find((r) => r.statusCode !== 200)?.json()).toMatchObject({
      error: { details: { reason: "workflow_cycle" } }
    });
  });
});

describe("a child that ends before its parent's wait commits", () => {
  it("cannot consume the only wake and leave the parent waiting", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent());
    const t = await ready(definitions);
    const started = await start(t);
    const dying = hangingAt(t.workflows.jobHandlers, 4);
    const first = t.worker(dying.handlers);
    let reached = false;
    const arrived = dying.reached.then(() => {
      reached = true;
    });
    for (let pass = 0; pass < 20 && !reached; pass++) await Promise.race([first.runDue(), arrived]);
    expect(reached).toBe(true);
    const ended = await t.finish(started.id, t.worker());
    await first.stop();
    expect(ended.status).toBe("done");
    expect(await children(t, started.id)).toHaveLength(1);
  });
});

describe("test-run confirmation and independent starts", () => {
  it("retains the root tester's confirmation across a child and grandchild", async () => {
    const t = await assets();
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    for (const action of ["workflow.write", "workflow.use", "connection.use"])
      await t.allow({ kind: "user", id: t.kai.id }, action);
    await put(t, child("leaf"));
    expect((await publish(t, "leaf")).statusCode).toBe(200);
    await put(t, { ...parent("leaf"), id: "child" });
    expect((await publish(t, "child")).statusCode).toBe(200);
    await put(t, parent());
    t.state.centralSettings = [
      { operation: "workflow.child.start", value: "confirm" },
      { operation: "workflow.leaf.start", value: "confirm" }
    ];
    const tested = runSchema.parse(
      (
        await t.expectOk(t.kai.id, "workflows.test", {
          params: { workflow: "parent" },
          payload: { input: {} }
        })
      ).json()
    );
    expect((await t.finish(tested.id)).status).toBe("done");
    const [middle] = await children(t, tested.id);
    const [leaf] = await children(t, middle?.id ?? "missing");
    expect(leaf).toMatchObject({ mode: "test", depth: 2, startedBy: { id: t.kai.id } });
  });

  it("bounds a child test's operation by both the tester and the child's principal", async () => {
    const t = await assets();
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    for (const action of ["workflow.write", "workflow.use"])
      await t.allow({ kind: "user", id: t.kai.id }, action);
    await put(t, child());
    expect((await publish(t, "child")).statusCode).toBe(200);
    await put(t, parent());
    const tested = runSchema.parse(
      (
        await t.expectOk(t.kai.id, "workflows.test", {
          params: { workflow: "parent" },
          payload: { input: {} }
        })
      ).json()
    );
    expect(await t.finish(tested.id)).toMatchObject({
      status: "failed",
      error: { code: "tester_missing_right" }
    });
    expect(t.executed).toHaveLength(0);
  });

  it("starts an independent root through the registered operation and replays its result once", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent());
    const t = await ready(definitions);
    const first = await t.invoke(
      t.root,
      "workflow.parent.start",
      {},
      { effect: "changing", idempotencyKey: "ordinary-start" }
    );
    const second = await t.invoke(
      t.root,
      "workflow.parent.start",
      {},
      { effect: "changing", idempotencyKey: "ordinary-start" }
    );
    expect(first.result.status).toBe("done");
    expect(second.result).toEqual(first.result);
    const [run] = await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: "parent" });
    expect(run).toMatchObject({ depth: 0, rootRunId: run?.id });
    expect(run?.parentRunId).toBeUndefined();
  });
});

describe("descendant ownership and recovery", () => {
  it("cancels a grandchild as well as its direct child", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child("leaf"));
    definitions.publish({ ...parent("leaf"), id: "child" });
    definitions.publish(parent());
    const t = await ready(definitions);
    const started = await start(t);
    const worker = t.worker();
    for (let pass = 0; pass < 4; pass++) await worker.runDue();
    const [middle] = await children(t, started.id);
    const [leaf] = await children(t, middle?.id ?? "missing");
    expect(leaf?.depth).toBe(2);
    await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: started.id } });
    expect((await children(t, started.id))[0]?.status).toBe("cancelled");
    expect((await children(t, middle?.id ?? "missing"))[0]?.status).toBe("cancelled");
  });

  it("recovers an interrupted independent start before rechecking a disabled run principal", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent());
    const t = await ready(definitions);
    // Losing the outcome after the root commits must not create another root on replay.
    vi.spyOn(t.operationCalls.deps.runs, "finish").mockResolvedValueOnce(undefined);
    const first = await t.invoke(
      t.root,
      "workflow.parent.start",
      {},
      { effect: "changing", idempotencyKey: "lost-outcome" }
    );
    const call = await t.stores.operationRuns.findByIdempotencyKey({
      clientInstanceId,
      actor: { kind: "user", id: t.root.id },
      idempotencyKey: "lost-outcome"
    });
    if (!call) throw new Error("Missing operation");
    expect(call.status).toBe("running");
    await t.stores.operationRuns.markInterrupted({ clientInstanceId, id: call.id });
    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: t.principal.id,
      status: "disabled"
    });
    const recovered = await t.invoke(
      t.root,
      "workflow.parent.start",
      {},
      { effect: "changing", idempotencyKey: "lost-outcome" }
    );
    expect(recovered.result).toEqual(first.result);
    expect(recovered.result.status).toBe("done");
    expect(
      await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: "parent" })
    ).toHaveLength(1);
  });
});

describe("a deadline while every step waits", () => {
  it("wakes from its timer and cancels descendants without a runnable step", async () => {
    const definitions = publishedDefinitions();
    const sub = child();
    const trigger = sub.steps[0];
    if (!trigger) throw new Error("Missing trigger");
    sub.steps = [
      trigger,
      {
        id: "sandbox",
        name: "Waiting code",
        type: "code",
        file: "steps/wait.py",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        input: {}
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ];
    definitions.publish(sub);
    definitions.publish(parent());
    const t = await readyWorkflows(
      (f) => {
        open = f;
      },
      {
        definitions: definitions.source,
        limits: { maxDurationMs: 10_000 },
        codeRunner: { timeoutSeconds: 30 },
        stepFiles: { readStepFile: async () => Buffer.from('print("{}")') }
      }
    );
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    const started = await start(t);
    const worker = t.worker();
    for (let pass = 0; pass < 4; pass++) await worker.runDue();
    const [spawned] = await children(t, started.id);
    expect(
      (await stepRunsOf(t, spawned?.id ?? "missing")).find((s) => s.stepId === "sandbox")?.status
    ).toBe("waiting");
    const root = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id });
    if (!root) throw new Error("Missing root");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(root.deadlineAt) - Date.now()) + 50)
    );
    await worker.runDue();
    expect(await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id })).toMatchObject(
      { status: "limit_reached" }
    );
    expect((await children(t, started.id))[0]?.status).toBe("cancelled");
  });
});
