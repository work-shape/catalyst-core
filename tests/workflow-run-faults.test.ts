import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createPlatformId,
  workflowStepIdempotencyKey,
  type JsonValue,
  type WorkflowManifest
} from "@vivd-catalyst/core";
import { parseWorkflowManifest } from "@vivd-catalyst/workflows";
import { clientInstanceId } from "./support/access-instance";
import {
  hangingAt,
  publishedDefinitions,
  runSchema,
  type workflowFixture,
  type WorkflowFixture
} from "./support/workflow-instance";
import {
  CLIENTS,
  NOTE,
  notifyClients,
  readyWorkflows,
  start,
  stepRunsOf,
  writesOf
} from "./support/workflow-runs";

// What a Workflow Run does when something around it gives way: its worker stops or dies
// inside a call, its principal loses its right in the middle of a loop, a limit or a cancel
// cuts it off. And what it never does: call an operation that answers a secret.

let open: WorkflowFixture | undefined;
/** Calls a test left hanging. They are let go when the test ends, so nothing outlives it. */
const hanging: (() => void)[] = [];
afterEach(async () => {
  for (const letGo of hanging.splice(0)) letGo();
  await open?.instance.close();
  open = undefined;
});

const ready = (options: Parameters<typeof workflowFixture>[0] = {}) =>
  readyWorkflows((fixture) => {
    open = fixture;
  }, options);

const answer = (operation: string, input: JsonValue): JsonValue =>
  operation === "echo" ? { clients: CLIENTS } : { received: input };

/**
 * A Connection whose first call of one operation does not answer until the test lets it go.
 * `entered` resolves when that call is with the outside system.
 */
function holdingFirst(t: WorkflowFixture, held: "echo" | "write") {
  let first = true;
  let entered: () => void = () => undefined;
  let letGo: () => void = () => undefined;
  const inCall = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  hanging.push(letGo);
  // A call may take as long as a Connection lets any call take.
  t.state.limits = { ...t.state.limits, callTimeoutMs: 30_000 };
  t.setBehaviour((operation, input) => {
    if (operation !== held || !first) return Promise.resolve(answer(operation, input));
    first = false;
    entered();
    return gate.then(() => answer(operation, input));
  });
  return { inCall, letGo };
}

/** Runs passes of a worker until the held call is with the outside system. */
async function reach(t: WorkflowFixture, inCall: Promise<void>) {
  const worker = t.worker();
  let there = false;
  const arrived = inCall.then(() => {
    there = true;
  });
  for (let pass = 0; pass < 20 && !there; pass++) {
    const running = worker.runDue();
    await Promise.race([running, arrived]);
  }
  expect(there).toBe(true);
  return worker;
}

const twoSteps = [
  {
    id: "confirm",
    name: "Confirm",
    type: "operation",
    operation: "connection.crm.echo",
    input: { text: { ref: { step: "send", path: "received.client" } } }
  }
];

describe("a worker that stops inside a call", () => {
  it("fails nothing: a reading call is made again by the next worker and the run finishes", async () => {
    const t = await ready();
    const held = holdingFirst(t, "echo");
    const started = await start(t);
    const worker = await reach(t, held.inCall);
    await worker.stop();

    const stopped = runSchema.parse(
      (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: started.id } })).json()
    );
    expect(stopped.status).toBe("running");
    expect(stopped.error).toBeUndefined();
    expect(
      (await stepRunsOf(t, started.id)).map((stepRun) => [stepRun.key, stepRun.status])
    ).toEqual([
      ["start", "done"],
      ["clients", "running"]
    ]);

    const run = await t.finish(started.id, t.worker());
    expect(run.status).toBe("done");
    expect(run.error).toBeUndefined();
    // The read was cut with its worker and made again; nothing was changed twice.
    expect(t.executed.filter((call) => call.operation === "echo")).toHaveLength(2);
    expect(writesOf(t)).toHaveLength(3);
  }, 60_000);

  it("lets a changing call end, and the next worker is answered what it answered", async () => {
    const t = await ready();
    const held = holdingFirst(t, "write");
    const started = await start(t);
    const worker = await reach(t, held.inCall);
    // The stop arrives while the call is with the outside system, which then answers.
    const stopping = worker.stop();
    // The worker has asked its jobs to end by now. The call is not cut: it goes on.
    await new Promise((resolve) => setTimeout(resolve, 300));
    held.letGo();
    await stopping;

    const run = await t.finish(started.id, t.worker());
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 3, failed: 0 });
    // The outside system saw each client once.
    expect(writesOf(t)).toEqual(CLIENTS.map((client) => ({ client: client.id, note: NOTE })));
    const changing = (await t.runs()).filter(
      (call) => call.origin.kind === "workflow" && call.effect === "changing"
    );
    expect(changing.map((call) => call.status)).toEqual(["done", "done", "done"]);
  }, 60_000);
});

describe("a changing call whose first attempt left no outcome", () => {
  /** The step run of the first item, queued, and a first call under its key that still runs. */
  async function firstCallRunning(t: WorkflowFixture, runId: string, startedAt: Date) {
    const worker = t.worker();
    for (let pass = 0; pass < 3; pass++) await worker.runDue();
    const listed = (await stepRunsOf(t, runId)).find(
      (candidate) => candidate.key === "each_client[0].send"
    );
    const stepRun = listed
      ? await t.stores.workflowRuns.getStepRun({ clientInstanceId, id: listed.id })
      : undefined;
    if (!stepRun) throw new Error("The loop did not start its first item");
    const first = await t.stores.operationRuns.create({
      id: createPlatformId<"OperationRunId">("oprun"),
      clientInstanceId,
      operation: "connection.crm.write",
      effect: "changing",
      actor: { kind: "service_principal", id: t.principal.id, label: t.principal.displayLabel },
      workspaceId: undefined,
      origin: { kind: "workflow", workflowRunId: runId, stepRunId: stepRun.id },
      conversationId: undefined,
      idempotencyKey: workflowStepIdempotencyKey(stepRun.id),
      inputHash: "the-hash-of-the-first-call",
      correlationId: "corr_first_call",
      startedAt: startedAt.toISOString()
    });
    if (!first) throw new Error("The first call could not be recorded");
    return { worker, stepRun, first };
  }

  it("ends the step and the run as operation_interrupted once nobody can write its outcome, and never calls again", async () => {
    const t = await ready({ limits: { operationOutcomeWaitMs: 400 } });
    const started = await start(t);
    // The worker of the first attempt died in the call: its Operation Run runs for ever.
    const { worker, stepRun, first } = await firstCallRunning(t, started.id, new Date());

    const run = await t.finish(started.id, worker);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "operation_interrupted", stepRunId: stepRun.id });
    // The outside system was not called a second time, under this key or another.
    expect(writesOf(t)).toEqual([]);
    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.find((candidate) => candidate.id === stepRun.id)).toMatchObject({
      status: "failed",
      attempt: 1,
      operationRunId: first.id,
      error: { code: "operation_interrupted" }
    });
    expect(stepRuns.map((candidate) => candidate.key)).not.toContain("each_client[1].send");
    expect(await t.stores.operationRuns.get({ clientInstanceId, id: first.id })).toMatchObject({
      status: "failed",
      error: { code: "interrupted" }
    });
  });

  it("waits while the first call may still end, with the id of its Operation Run on the step run", async () => {
    const t = await ready({ limits: { operationOutcomeWaitMs: 1_500 } });
    const started = await start(t);
    const { worker, stepRun, first } = await firstCallRunning(t, started.id, new Date());

    const pass = worker.runDue();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Half a second in, the step waits: nothing failed and nothing was called.
    const waiting = (await stepRunsOf(t, started.id)).find(
      (candidate) => candidate.id === stepRun.id
    );
    expect(waiting).toMatchObject({ status: "running", operationRunId: first.id });
    expect(waiting?.error).toBeUndefined();
    expect(writesOf(t)).toEqual([]);
    await pass;
    expect((await t.finish(started.id, worker)).error?.code).toBe("operation_interrupted");
  });

  it("counts the wait from the start of the first call, so a call cut off long ago ends at once", async () => {
    const t = await ready();
    const started = await start(t);
    const longAgo = new Date(Date.now() - 60 * 60 * 1_000);
    const { worker } = await firstCallRunning(t, started.id, longAgo);
    const before = Date.now();
    const run = await t.finish(started.id, worker);
    expect(run.error?.code).toBe("operation_interrupted");
    expect(Date.now() - before).toBeLessThan(5_000);
  });
});

describe("an operation that answers or takes a secret", () => {
  const withStep = (operation: string, input: Record<string, unknown>) => {
    const definition = notifyClients();
    const [trigger, , , result] = definition.steps;
    return {
      ...definition,
      steps: [
        trigger,
        { id: "secret", name: "Secret", type: "operation", operation, input },
        { ...result, input: {} }
      ]
    };
  };

  it("is no step of a Workflow: the start refuses the definition by name", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(withStep("api_credentials.create", {}));
    const t = await ready({ definitions: definitions.source });
    const refused = await t.expectRefused(
      t.root.id,
      "workflows.start",
      { params: { workflow: "notify-clients" }, payload: { input: { note: NOTE } } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(refused.details).toMatchObject({
      reason: "operation_secret",
      issues: [{ code: "operation_secret", path: "steps.secret.operation" }]
    });
    expect(
      await t.stores.audit.listAuditEvents({ clientInstanceId, type: "workflow_run.started" })
    ).toEqual([]);
  });

  it("fails a step whose input holds a secret before anything is called or kept", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(
      withStep("users.create", {
        displayLabel: { value: "Made by a Workflow" },
        passwordSignIn: { value: { password: "a-Secret-of-16-chars" } }
      })
    );
    const t = await ready({ definitions: definitions.source });
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("secret_input");
    const calls = (await t.runs()).filter((call) => call.origin.kind === "workflow");
    expect(calls).toEqual([]);
  });
});

describe("a loop that continues past a failed item", () => {
  async function continuing(inner: unknown[] = [], limits = {}) {
    const definitions = publishedDefinitions();
    definitions.publish(notifyClients({ onItemFailure: "continue" }, inner));
    return ready({ definitions: definitions.source, limits });
  }

  it("stops where the principal was disabled, and fails the run with that reason", async () => {
    const t = await continuing();
    t.setBehaviour(async (operation, input) => {
      if (operation === "write") {
        await t.stores.apiAccess.updateServicePrincipal({
          clientInstanceId,
          servicePrincipalId: t.principal.id,
          status: "disabled"
        });
      }
      return answer(operation, input);
    });
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("principal_inactive");
    expect(writesOf(t)).toHaveLength(1);
    expect((await stepRunsOf(t, run.id)).map((stepRun) => [stepRun.key, stepRun.status])).toEqual([
      ["start", "done"],
      ["clients", "done"],
      ["each_client", "failed"],
      ["each_client[0].send", "done"],
      ["each_client[1].send", "failed"]
    ]);
    const [ended] = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.ended"
    });
    expect(ended).toMatchObject({
      status: "failed",
      metadata: { errorCode: "principal_inactive" }
    });
  });

  it("stops where the principal lost its right, and names the right", async () => {
    const t = await continuing();
    t.setBehaviour(async (operation, input) => {
      if (operation === "write") {
        const grants = await t.stores.access.listGrants({ clientInstanceId });
        for (const grant of grants.filter((held) => held.holderId === t.principal.id)) {
          await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
        }
      }
      return answer(operation, input);
    });
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "FORBIDDEN", action: "connection.use" });
    // The sentence names who lacks the right: the run's principal, and no person.
    expect(run.error?.message).toBe(
      "The service principal 'workflow-runner', which the Workflow runs as, does not hold the right 'connection.use' to call 'connection.crm.write'. An administrator can grant it to the principal"
    );
    expect(run.error?.message).not.toContain("person");
    expect(writesOf(t)).toHaveLength(1);
    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.at(-1)).toMatchObject({
      key: "each_client[1].send",
      status: "failed",
      error: { code: "FORBIDDEN", action: "connection.use" }
    });
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")?.status).toBe("failed");
  });

  it("stops where the instance's policy refuses the operation, and does not end done", async () => {
    const t = await continuing();
    // The policy asks for a confirmation nobody is there to give: every item would be refused.
    t.state.centralSettings = [{ operation: "connection.crm.write", value: "confirm" }];
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("POLICY_DENIED");
    expect(writesOf(t)).toEqual([]);
    const stepRuns = await stepRunsOf(t, run.id);
    // The first item was refused, and no second one was asked.
    expect(stepRuns.filter((stepRun) => stepRun.iteration !== undefined)).toHaveLength(1);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")?.status).toBe("failed");
    const [ended] = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.ended"
    });
    expect(ended).toMatchObject({ status: "failed", metadata: { errorCode: "POLICY_DENIED" } });
  });

  it("still continues past an item whose own call failed", async () => {
    const t = await continuing();
    t.setBehaviour((operation, input) =>
      JSON.stringify(input).includes("client-bert")
        ? Promise.reject(new Error("The outside system is down"))
        : Promise.resolve(answer(operation, input))
    );
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 2, failed: 1 });
  });

  it("counts an item a limit cut off between two of its steps as neither done nor failed", async () => {
    // Six step runs: the three before the items, both steps of the first, one of the second.
    const t = await continuing(twoSteps, { maxStepRuns: 6 });
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("limit_reached");
    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.map((stepRun) => [stepRun.key, stepRun.status])).toEqual([
      ["start", "done"],
      ["clients", "done"],
      ["each_client", "cancelled"],
      ["each_client[0].send", "done"],
      ["each_client[0].confirm", "done"],
      ["each_client[1].send", "done"]
    ]);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")).toMatchObject({
      loop: { total: 3, done: 1, failed: 0, running: 0 },
      bodyCounts: {
        send: { total: 3, done: 2, failed: 0, running: 0 },
        confirm: { total: 3, done: 1, failed: 0, running: 0 }
      }
    });
  });
});

describe("a definition another release stored", () => {
  /** `notify-clients` changed after it was checked: nothing checks it on its way to the engine. */
  const manifest = (change: (definition: WorkflowManifest) => WorkflowManifest) => {
    const definitions = publishedDefinitions();
    const checked = parseWorkflowManifest(notifyClients());
    if (!checked.ok) throw new Error("The fixture definition cannot be run");
    definitions.hold(change(checked.manifest), "rev-unchecked");
    return definitions.source;
  };
  const withLoop = (fields: { collect?: { step: string; path: string } }) =>
    manifest((base) => ({
      ...base,
      steps: base.steps.map((step) => (step.type === "loop" ? { ...step, ...fields } : step))
    }));

  const cases: [string, () => ReturnType<typeof manifest>][] = [
    ["collect", () => withLoop({ collect: { step: "send", path: "" } })],
    [
      "parent",
      () =>
        manifest((base) => ({
          ...base,
          steps: base.steps.map((step) =>
            step.type === "trigger"
              ? { ...step, triggers: [{ kind: "manual" }, { kind: "parent" }] }
              : step
          )
        }))
    ]
  ];

  it.each(cases)(
    "fails with not_supported_yet where a run reaches '%s', which this engine does not run",
    async (_what, definitions) => {
      const t = await ready({ definitions: definitions() });
      const run = await t.finish((await start(t)).id);
      expect([run.status, run.error?.code]).toEqual(["failed", "not_supported_yet"]);
      expect(writesOf(t)).toEqual([]);
    }
  );
});

describe("what the store keeps of a run", () => {
  it("reads a run without its definition, which a step reads on its own", async () => {
    const t = await ready();
    const started = await start(t);
    const ref = { clientInstanceId, id: started.id };
    const read = await t.stores.workflowRuns.readRun(ref);
    if (!read) throw new Error("The started run cannot be read");
    const locked = await t.stores.workflowRuns.lockRun({ clientInstanceId, id: read.id });
    const [listed] = await t.stores.workflowRuns.listRuns({
      clientInstanceId,
      workflow: "notify-clients"
    });
    for (const run of [locked, read, listed]) {
      expect(run).toMatchObject({ id: started.id });
      expect(run).not.toHaveProperty("definition");
    }
    expect((await t.stores.workflowRuns.readRunDefinition(ref))?.id).toBe("notify-clients");
  });

  it("holds one step run per path of a run, whoever asks for a second", async () => {
    const t = await ready();
    const started = await start(t);
    const run = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id });
    if (!run) throw new Error("The started run cannot be read");
    const second = () =>
      t.stores.workflowRuns.createStepRun({
        id: createPlatformId<"WorkflowStepRunId">("wfs"),
        clientInstanceId,
        runId: run.id,
        stepId: "start",
        stepType: "trigger",
        key: "start",
        createdAt: new Date().toISOString()
      });
    // The trigger's step run exists since the start.
    await expect(second()).rejects.toSatisfy(
      (error) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message.includes("workflow_step_runs_key_idx")
    );
    expect((await stepRunsOf(t, started.id)).map((stepRun) => stepRun.key)).toEqual(["start"]);
  });
});

describe("a cancel while the worker of a step is gone", () => {
  it("records what the step's call did once its step run is taken up again", async () => {
    const t = await ready();
    const started = await start(t);
    // The worker dies after the first item's call answered and before the step is written:
    // three steps with two transactions each, then the claim, then the write.
    const dying = hangingAt(t.workflows.jobHandlers, 8);
    const dead = t.worker(dying.handlers);
    let reached = false;
    const arrived = dying.reached.then(() => {
      reached = true;
    });
    for (let pass = 0; pass < 20 && !reached; pass++) {
      await Promise.race([dead.runDue(), arrived]);
    }
    expect(writesOf(t)).toHaveLength(1);

    await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: started.id } });
    await dead.stop();
    const next = t.worker();
    await next.runDue();
    await next.runDue();

    const stepRun = (await stepRunsOf(t, started.id)).find(
      (candidate) => candidate.key === "each_client[0].send"
    );
    // The call happened, and the step run says so.
    expect(stepRun).toMatchObject({ status: "done", effect: "changing" });
    const [call] = (await t.runs()).filter((made) => made.effect === "changing");
    expect(stepRun?.operationRunId).toBe(call?.id);
    expect(writesOf(t)).toHaveLength(1);
  }, 60_000);

  it("records it as well where the run ran out of its time while the worker was gone", async () => {
    let late = 0;
    const t = await ready({ now: () => new Date(Date.now() + late) });
    const started = await start(t);
    const dying = hangingAt(t.workflows.jobHandlers, 8);
    const dead = t.worker(dying.handlers);
    let reached = false;
    const arrived = dying.reached.then(() => {
      reached = true;
    });
    for (let pass = 0; pass < 20 && !reached; pass++) {
      await Promise.race([dead.runDue(), arrived]);
    }
    expect(writesOf(t)).toHaveLength(1);
    await dead.stop();
    // Thirteen hours on, the run is past the twelve it may take.
    late = 13 * 60 * 60 * 1_000;
    const run = await t.finish(started.id, t.worker());

    expect(run.status).toBe("limit_reached");
    expect(run.error?.code).toBe("duration_limit");
    const stepRun = (await stepRunsOf(t, started.id)).find(
      (candidate) => candidate.key === "each_client[0].send"
    );
    // The step did not run again, and it does not read as if its call had never been made.
    expect(stepRun).toMatchObject({ status: "done", effect: "changing" });
    const [call] = (await t.runs()).filter((made) => made.effect === "changing");
    expect(stepRun?.operationRunId).toBe(call?.id);
    expect(writesOf(t)).toHaveLength(1);
  }, 60_000);
});

describe("the read of a run the caller is denied", () => {
  it("answers a run that exists as it answers one that does not, under the only deny there is", async () => {
    const t = await ready();
    const started = await start(t);
    // A right on a Workflow is held for the instance: it is granted in no Namespace and on
    // no single asset, as an allow or as a deny. So no deny tells one Workflow from another.
    await t.createNamespace("notify-");
    const scoped = await t.call(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "workflow.read",
        effect: "deny",
        scopeKind: "namespace",
        namespace: "notify-"
      }
    });
    expect(scoped.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { reason: "action_not_grantable" } }
    });

    for (const action of ["workflow.read", "workflow.write"]) {
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: t.kai.id,
        action,
        effect: "deny",
        scopeKind: "instance",
        grantedBy: t.admin.id
      });
    }
    for (const operation of [
      "workflows.get_run",
      "workflows.list_step_runs",
      "workflows.cancel_run"
    ] as const) {
      const existing = await t.call(t.kai.id, operation, { params: { runId: started.id } });
      const unknown = await t.call(t.kai.id, operation, { params: { runId: "wfr_none" } });
      const code = (response: typeof existing) =>
        z.object({ error: z.object({ code: z.string() }) }).parse(response.json()).error.code;
      expect([operation, existing.statusCode, code(existing)]).toEqual([
        operation,
        403,
        "FORBIDDEN"
      ]);
      expect([unknown.statusCode, code(unknown)]).toEqual([403, "FORBIDDEN"]);
    }
  });
});
