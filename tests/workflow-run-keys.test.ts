import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_RUN_KEY_MAX_LENGTH,
  connectionCallError,
  type JsonValue,
  type PlatformStores,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { child, children, ref } from "./support/workflow-children";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { readyChildWorkflows } from "./support/workflow-children-instance";

// EW-13k: the run key. Among the runs of a Workflow that are open or `done` a key exists once;
// a start with it starts nothing and answers that run. Spec: Run key; acceptance WF 44.

let open: WorkflowFixture | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await open?.instance.close();
  open = undefined;
});

const ready = (definitions = publishedDefinitions(), options: { now?: () => Date } = {}) =>
  readyChildWorkflows(
    (fixture) => {
      open = fixture;
    },
    definitions,
    options
  );

const keyedRunSchema = runSchema.extend({ runKey: z.string().optional() });
const stepRunsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      stepId: z.string(),
      status: z.string(),
      linkedRunId: z.string().optional(),
      outputPreview: z.object({ text: z.string() }).optional()
    })
  )
});

/** A Workflow a person starts with a value, which it echoes back as its result. */
function echo(id = "echo", name = id): WorkflowManifest {
  return {
    ...child(id),
    name,
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      ...child(id).steps.slice(1)
    ]
  };
}

/** A parent whose `workflow` step starts `child` under a key, once or per client. */
function keyedParent(key: unknown[], clients?: true) {
  const call = {
    id: "child",
    name: "Child",
    type: "workflow" as const,
    workflow: "child",
    input: { value: clients ? ref("each", "") : { value: "7" } },
    key
  };
  return {
    id: "parent",
    name: "Parent",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      ...(clients
        ? [
            {
              id: "items",
              name: "Items",
              type: "operation",
              operation: "connection.crm.echo",
              input: { text: { value: "items" } }
            },
            {
              id: "each",
              name: "Each",
              type: "loop",
              items: { step: "items", path: "items" },
              concurrency: 3,
              onItemFailure: "continue",
              steps: [call]
            }
          ]
        : [call]),
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { result: ref(clients ? "each" : "child", "") }
      }
    ]
  };
}

async function startWith(t: WorkflowFixture, workflow: string, value: string, key?: string) {
  const response = await t.expectOk(t.root.id, "workflows.start", {
    params: { workflow },
    payload: { input: { value }, ...(key === undefined ? {} : { key }) }
  });
  return keyedRunSchema.parse(response.json());
}

async function startParent(t: WorkflowFixture) {
  const response = await t.expectOk(t.root.id, "workflows.start", {
    params: { workflow: "parent" },
    payload: { input: {} }
  });
  return keyedRunSchema.parse(response.json());
}

async function runsOf(t: WorkflowFixture, workflow: string, query: Record<string, string> = {}) {
  const response = await t.expectOk(t.root.id, "workflows.list_runs", {
    params: { workflow },
    query
  });
  return z.object({ items: z.array(keyedRunSchema) }).parse(response.json()).items;
}

async function stepRuns(t: WorkflowFixture, runId: string) {
  const response = await t.expectOk(t.root.id, "workflows.list_step_runs", {
    params: { runId },
    query: { limit: 200 }
  });
  return stepRunsSchema.parse(response.json()).items;
}

/** Echoes a value, fails for the values in `failing`, and counts the calls per value. */
function echoing(t: WorkflowFixture, clients: readonly string[] = []) {
  const failing = new Set<string>();
  const calls = new Map<string, number>();
  t.setBehaviour((_operation, input): Promise<JsonValue> => {
    const text = z.object({ text: z.string() }).parse(input).text;
    if (text === "items") return Promise.resolve({ items: [...clients] });
    calls.set(text, (calls.get(text) ?? 0) + 1);
    // A refusal and not an outage: a reading call that fails for now is made again later.
    if (failing.has(text)) return Promise.reject(connectionCallError("upstream_conflict"));
    return Promise.resolve({ value: text });
  });
  return { failing, calls };
}

describe("Workflow run keys", () => {
  it("answers the run that holds a key, also once it is done, and gives a failed run's key to a new run on the published revision", async () => {
    const definitions = publishedDefinitions();
    const first = definitions.publish(echo());
    const t = await ready(definitions);
    const { failing } = echoing(t);

    const opened = await startWith(t, "echo", "a", "2026-09/1402");
    expect(opened.runKey).toBe("2026-09/1402");
    // While the run is open, and once it is done, the key answers it and starts nothing.
    expect((await startWith(t, "echo", "b", "2026-09/1402")).id).toBe(opened.id);
    expect((await t.finish(opened.id)).status).toBe("done");
    const again = await startWith(t, "echo", "c", "2026-09/1402");
    expect(again).toMatchObject({ id: opened.id, status: "done", definitionRevisionId: first });
    expect(JSON.parse(again.outputPreview?.text ?? "null")).toEqual({ value: "a" });

    failing.add("x");
    const broken = await startWith(t, "echo", "x", "2026-09/1403");
    expect((await t.finish(broken.id)).status).toBe("failed");
    const second = definitions.publish(echo("echo", "Echo, republished"));
    expect(second).not.toBe(first);
    failing.clear();
    const retried = await startWith(t, "echo", "x", "2026-09/1403");
    expect(retried.id).not.toBe(broken.id);
    expect(retried).toMatchObject({ runKey: "2026-09/1403", definitionRevisionId: second });
    expect((await t.finish(retried.id)).status).toBe("done");
    // The done run keeps the revision it ran on.
    expect((await startWith(t, "echo", "a", "2026-09/1402")).definitionRevisionId).toBe(first);

    const runs = await runsOf(t, "echo");
    expect(runs).toHaveLength(3);
    // A started event per run that started, and none for a start that was answered.
    const started = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.started",
      page: { limit: 50 }
    });
    expect(started).toHaveLength(3);
    for (const event of started) expect(JSON.stringify(event)).not.toContain("2026-09/");
  });

  it("makes one run of two starts with one key whose transactions overlap", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(echo());
    const t = await ready(definitions);
    echoing(t);
    // The first start writes its run and holds its transaction open; the second start's
    // insert then waits on the key's index in its own transaction until the first commits.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted: () => void = () => undefined;
    const written = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    let creates = 0;
    const original = t.stores.transaction.bind(t.stores);
    vi.spyOn(t.stores, "transaction").mockImplementation(
      <T>(work: (tx: PlatformStores) => Promise<T>) =>
        original((tx) =>
          work({
            ...tx,
            workflowRuns: {
              ...tx.workflowRuns,
              async createRun(run) {
                const number = ++creates;
                const created = await tx.workflowRuns.createRun(run);
                if (number === 1) {
                  inserted();
                  await held;
                }
                return created;
              }
            }
          })
        )
    );
    const one = startWith(t, "echo", "a", "same");
    await written;
    let secondAnswered = false;
    const two = startWith(t, "echo", "b", "same").then((run) => {
      secondAnswered = true;
      return run;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(creates).toBe(2);
    expect(secondAnswered).toBe(false);
    release();
    const [a, b] = await Promise.all([one, two]);
    expect(b.id).toBe(a.id);
    vi.restoreAllMocks();
    expect(await runsOf(t, "echo")).toHaveLength(1);
    // Many at once, with no hold: still one run.
    const many = await Promise.all(
      Array.from({ length: 8 }, (_, n) => startWith(t, "echo", String(n), "many"))
    );
    expect(new Set(many.map((run) => run.id)).size).toBe(1);
    expect(await runsOf(t, "echo", { key: "many" })).toHaveLength(1);
  });

  it("filters the runs list by key, exactly or by a prefix taken literally", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(echo());
    const t = await ready(definitions);
    echoing(t);
    for (const key of ["2026-09/1", "2026-09/2", "2026-10/1", "a_b", "axb"]) {
      await startWith(t, "echo", "v", key);
    }
    await startWith(t, "echo", "v");
    expect((await runsOf(t, "echo", { key: "2026-09/1" })).map((run) => run.runKey)).toEqual([
      "2026-09/1"
    ]);
    expect(
      (await runsOf(t, "echo", { keyPrefix: "2026-09/" })).map((run) => run.runKey).sort()
    ).toEqual(["2026-09/1", "2026-09/2"]);
    expect((await runsOf(t, "echo", { keyPrefix: "a_" })).map((run) => run.runKey)).toEqual([
      "a_b"
    ]);
    expect(await runsOf(t, "echo")).toHaveLength(6);
  });

  it("refuses a key that is empty or longer than its bound, and an input named key", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(echo());
    const t = await ready(definitions);
    for (const key of ["", "k".repeat(WORKFLOW_RUN_KEY_MAX_LENGTH + 1)]) {
      const refused = await t.call(t.root.id, "workflows.start", {
        params: { workflow: "echo" },
        payload: { input: { value: "a" }, key }
      });
      expect(refused.statusCode).toBe(422);
    }
    expect(await runsOf(t, "echo")).toHaveLength(0);
    const declared = echo("declares-key");
    declared.inputs = { type: "object", properties: { key: { type: "string" } } };
    const result = parseWorkflowManifest(declared);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("inputs.properties.key");
  });

  it("starts an independent run through workflow.<id>.start with a key beside its inputs", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(echo());
    const t = await ready(definitions);
    echoing(t);
    const first = await t.invoke(
      t.root,
      "workflow.echo.start",
      { value: "a", key: "by-operation" },
      { effect: "changing", idempotencyKey: "one" }
    );
    const second = await t.invoke(
      t.root,
      "workflow.echo.start",
      { value: "b", key: "by-operation" },
      { effect: "changing", idempotencyKey: "two" }
    );
    const answered = z.object({ status: z.literal("done"), output: z.object({ id: z.string() }) });
    const one = answered.parse(first.result);
    // The second call is its own Operation Run, and it is answered the run of the first.
    expect(answered.parse(second.result).output.id).toBe(one.output.id);
    const runs = await runsOf(t, "echo");
    expect(runs.map((run) => [run.id, run.runKey])).toEqual([[one.output.id, "by-operation"]]);
  });
});

describe("Workflow run keys on a workflow step", () => {
  it("accepts a key on a workflow step and refuses one that names no step", () => {
    expect(parseWorkflowManifest(keyedParent([{ value: "2026-09" }, { value: "1" }])).ok).toBe(
      true
    );
    const result = parseWorkflowManifest(keyedParent([ref("nowhere", "")]));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("nowhere");
  });

  it("runs only the failed child when a parent is started again for a month ten days later, and receives every result (WF 44)", async () => {
    const clients = ["c1", "c2", "c3", "c4", "c5", "c6"];
    let now = Date.now();
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(keyedParent([{ value: "2026-09" }, ref("each", "")], true));
    const t = await ready(definitions, { now: () => new Date(now) });
    const { failing, calls } = echoing(t, clients);
    failing.add("c4");

    const first = await startParent(t);
    const ended = await t.finish(first.id, undefined, 400);
    expect(JSON.parse(ended.outputPreview?.text ?? "null")).toEqual({
      result: { total: 6, done: 5, failed: 1 }
    });
    const owned = await children(t, first.id);
    expect(owned.map((run) => run.runKey).sort()).toEqual(clients.map((c) => `2026-09/${c}`));

    now += 10 * 24 * 60 * 60 * 1000;
    failing.clear();
    calls.clear();
    const second = await startParent(t);
    const done = await t.finish(second.id, undefined, 400);
    expect(done.status).toBe("done");
    expect(JSON.parse(done.outputPreview?.text ?? "null")).toEqual({
      result: { total: 6, done: 6, failed: 0 }
    });
    // One child ran, for the client that failed; the five done ones answered at once.
    expect([...calls.entries()]).toEqual([["c4", 1]]);
    const rerun = await children(t, second.id);
    expect(rerun.map((run) => run.runKey)).toEqual(["2026-09/c4"]);
    const steps = (await stepRuns(t, second.id)).filter((step) => step.stepId === "child");
    expect(steps).toHaveLength(6);
    const doneChildren = owned.filter((run) => run.status === "done").map((run) => run.id);
    expect(steps.flatMap((step) => (step.linkedRunId ? [step.linkedRunId] : [])).sort()).toEqual(
      [...doneChildren].sort()
    );
    for (const step of steps) {
      expect(step.status).toBe("done");
      expect(JSON.parse(step.outputPreview?.text ?? "null")).toEqual({
        value: expect.stringMatching(/^c[1-6]$/u)
      });
    }
  }, 120_000);

  it("waits for an open run it is linked to, and cancelling its parent leaves that run going", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(keyedParent([{ value: "2026-09" }, { value: "1402" }]));
    const t = await ready(definitions);
    echoing(t);
    const parents = [await startParent(t), await startParent(t), await startParent(t)];
    const worker = t.worker();
    await worker.runDue();
    await worker.runDue();
    const owned = (
      await Promise.all(parents.map(async (run) => ({ run, children: await children(t, run.id) })))
    ).filter((entry) => entry.children.length > 0);
    expect(owned).toHaveLength(1);
    const keyed = owned[0]?.children[0];
    expect(keyed?.runKey).toBe("2026-09/1402");
    const linked = [];
    for (const run of parents) {
      const [step] = (await stepRuns(t, run.id)).filter((s) => s.stepId === "child");
      if (step?.linkedRunId !== undefined) linked.push({ run, step });
    }
    expect(linked.map(({ step }) => step.linkedRunId)).toEqual([keyed?.id, keyed?.id]);
    expect(linked.map(({ step }) => step.status)).toEqual(["waiting", "waiting"]);

    const [cancelled, waiting] = linked;
    await t.expectOk(t.root.id, "workflows.cancel_run", {
      params: { runId: cancelled?.run.id ?? "missing" }
    });
    const after = await t.stores.workflowRuns.readRun({ clientInstanceId, id: keyed?.id ?? "" });
    expect(["queued", "running", "waiting"]).toContain(after?.status);

    const results = await Promise.all(
      [owned[0]?.run, waiting?.run].map((run) => t.finish(run?.id ?? "missing", worker))
    );
    for (const result of results) {
      expect(result.status).toBe("done");
      expect(JSON.parse(result.outputPreview?.text ?? "null")).toEqual({ result: { value: "7" } });
    }
    expect((await t.finish(keyed?.id ?? "missing", worker)).status).toBe("done");
    // A parent started after the run is done is answered by it at once.
    const late = await startParent(t);
    expect((await t.finish(late.id, worker)).status).toBe("done");
    expect(await children(t, late.id)).toHaveLength(0);
  });

  it("fails the step with run_key_invalid where the joined key is longer than its bound", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(
      keyedParent([{ value: "k".repeat(WORKFLOW_RUN_KEY_MAX_LENGTH) }, { value: "x" }])
    );
    const t = await ready(definitions);
    echoing(t);
    const run = await startParent(t);
    expect(await t.finish(run.id)).toMatchObject({
      status: "failed",
      error: { code: "run_key_invalid" }
    });
    expect(await children(t, run.id)).toHaveLength(0);
  });
});
