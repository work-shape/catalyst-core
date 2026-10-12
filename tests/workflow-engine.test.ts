import { afterEach, describe, expect, it } from "vitest";
import { createPlatformId, type JsonValue, type OperationOrigin } from "@vivd-catalyst/core";
import { clientInstanceId } from "./support/access-instance";
import {
  hangingAt,
  runSchema,
  stepRunsSchema,
  workflowFixture,
  type WorkflowFixture
} from "./support/workflow-instance";

// A published Workflow started by hand and run to its end on the job executor. Every test
// goes through the API for the start, the cancel and the reads, and through a job worker for
// the steps. The Workflow is the fixture folder `notify-clients`: it reads a list from the
// Connection `crm` and makes one changing call per item of it.

const NOTE = "Quarterly figures are ready";
const CLIENTS = [{ id: "client-anna" }, { id: "client-bert" }, { id: "client-cleo" }];

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

/** An instance whose Connection answers three clients and whose principal may use it. */
async function ready(options: Parameters<typeof workflowFixture>[0] = {}) {
  const t = await workflowFixture(options);
  open = t;
  await t.seedCrm();
  t.setBehaviour((operation, input) =>
    Promise.resolve<JsonValue>(operation === "echo" ? { clients: CLIENTS } : { received: input })
  );
  t.state.centralSettings = [{ operation: "connection.crm.write", value: "allow" }];
  await t.allow({ kind: "service_principal", id: t.principal.id }, "connection.use");
  return t;
}

async function start(t: WorkflowFixture, userId = t.root.id, workflow = "notify-clients") {
  const response = await t.expectOk(userId, "workflows.start", {
    params: { workflow },
    payload: { input: { note: NOTE } }
  });
  return runSchema.parse(response.json());
}

async function stepRunsOf(t: WorkflowFixture, runId: string) {
  const response = await t.expectOk(t.root.id, "workflows.list_step_runs", { params: { runId } });
  return stepRunsSchema.parse(response.json()).items;
}

const writesOf = (t: WorkflowFixture) =>
  t.executed.filter((call) => call.operation === "write").map((call) => call.input);

describe("a Workflow Run from the manual start to its end", () => {
  it("runs each step once, the steps of a loop once per item, and ends with its result", async () => {
    const t = await ready();
    const started = await start(t);
    expect(started).toMatchObject({
      workflow: "notify-clients",
      status: "queued",
      principal: { id: t.principal.id, displayLabel: "workflow-runner" },
      startedBy: { kind: "user", id: t.root.id }
    });

    const run = await t.finish(started.id);
    expect(run.status).toBe("done");
    expect(run.error).toBeUndefined();
    expect(run.stepRunCount).toBe(7);
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({
      sent: CLIENTS.map((client) => ({ received: { client: client.id, note: NOTE } }))
    });

    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.map((stepRun) => [stepRun.key, stepRun.status, stepRun.attempt])).toEqual([
      ["start", "done", 1],
      ["clients", "done", 1],
      ["each_client", "done", 1],
      ["each_client[0].send", "done", 1],
      ["each_client[1].send", "done", 1],
      ["each_client[2].send", "done", 1],
      ["result", "done", 1]
    ]);
    expect(t.executed.map((call) => call.operation)).toEqual(["echo", "write", "write", "write"]);
    expect(writesOf(t)).toEqual(CLIENTS.map((client) => ({ client: client.id, note: NOTE })));
    // A step run of a loop's item says which item, by the field the loop names as its label,
    // and the loop's own step run says how far its items are.
    expect(stepRuns.flatMap((stepRun) => (stepRun.iteration ? [stepRun.iteration] : []))).toEqual(
      CLIENTS.map((client, index) => ({ index, label: client.id }))
    );
    expect(
      stepRuns.flatMap((stepRun) => (stepRun.loop ? [[stepRun.key, stepRun.loop]] : []))
    ).toEqual([["each_client", { total: 3, done: 3, failed: 0, running: 0 }]]);
  });

  it("makes every call as the run's principal, from the origin of its step run and with the step run's id as the key of a changing call", async () => {
    const t = await ready();
    const run = await t.finish((await start(t, t.root.id)).id);
    const stepRuns = await stepRunsOf(t, run.id);
    const calls = (await t.runs()).filter((call) => call.origin.kind === "workflow");

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.actor).toMatchObject({ kind: "service_principal", id: t.principal.id });
      expect(call.status).toBe("done");
      const stepRun = stepRuns.find((candidate) => candidate.operationRunId === call.id);
      expect(call.origin).toEqual({
        kind: "workflow",
        workflowRunId: run.id,
        stepRunId: stepRun?.id
      });
      // The key the contract gives the changing call of a step run.
      expect(call.idempotencyKey).toBe(
        call.effect === "changing" ? `workflow_step:${stepRun?.id}` : undefined
      );
    }
    const keys = calls.flatMap((call) => (call.idempotencyKey ? [call.idempotencyKey] : []));
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps no input and shows of an output only a cut preview", async () => {
    const t = await ready();
    t.setBehaviour((operation) =>
      Promise.resolve<JsonValue>(
        operation === "echo" ? { clients: [CLIENTS[0] ?? null] } : { text: "x".repeat(900) }
      )
    );
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("done");
    const read = await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: run.id } });
    expect(read.body).not.toContain(NOTE);
    expect(read.json()).not.toHaveProperty("input");
    expect(read.json()).not.toHaveProperty("definition");

    t.setBehaviour((operation) =>
      Promise.resolve<JsonValue>(
        operation === "echo" ? { clients: CLIENTS } : { text: "x".repeat(900) }
      )
    );
    const long = await t.finish((await start(t)).id);
    expect(long.outputPreview?.truncated).toBe(true);
    expect(long.outputPreview?.text).toHaveLength(2_000);
  });
});

describe("a Workflow Run across a worker that dies", () => {
  // Each attempt of a step opens two transactions: the claim and the write of how it went.
  // The steps before the loop's items take six, so the second item's write is the tenth.
  const SECOND_ITEM_CLAIM = 9;
  const SECOND_ITEM_WRITE = 10;

  async function dieAt(t: WorkflowFixture, runId: string, transaction: number) {
    const dying = hangingAt(t.workflows.jobHandlers, transaction);
    const first = t.worker(dying.handlers);
    let reached = false;
    const arrived = dying.reached.then(() => {
      reached = true;
    });
    for (let pass = 0; pass < 20 && !reached; pass++) {
      const running = first.runDue();
      await Promise.race([running, arrived]);
      // The pass of the attempt that hangs ends only when its worker stops.
      if (!reached) await running;
    }
    expect(reached).toBe(true);
    await first.stop();
    return t.finish(runId, t.worker());
  }

  it("resumes after the second changing call of a loop without a fourth call or a duplicate", async () => {
    const t = await ready();
    const started = await start(t);
    const dead = dieAt(t, started.id, SECOND_ITEM_WRITE);
    const run = await dead;

    expect(run.status).toBe("done");
    // The second item's call ran before the worker died. The step ran again and was
    // answered with what that call answered: the outside system saw three calls, not four.
    expect(writesOf(t)).toEqual(CLIENTS.map((client) => ({ client: client.id, note: NOTE })));
    expect(t.executed.filter((call) => call.operation === "echo")).toHaveLength(1);

    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.map((stepRun) => stepRun.key)).toEqual([
      "start",
      "clients",
      "each_client",
      "each_client[0].send",
      "each_client[1].send",
      "each_client[2].send",
      "result"
    ]);
    expect(stepRuns.every((stepRun) => stepRun.status === "done")).toBe(true);
    const changing = (await t.runs()).filter(
      (call) => call.origin.kind === "workflow" && call.effect === "changing"
    );
    expect(changing).toHaveLength(3);
    expect(new Set(changing.map((call) => call.idempotencyKey)).size).toBe(3);
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({
      sent: CLIENTS.map((client) => ({ received: { client: client.id, note: NOTE } }))
    });
  });

  it("resumes a step the worker died before, and repeats no step that had ended", async () => {
    const t = await ready();
    const started = await start(t);
    const run = await dieAt(t, started.id, SECOND_ITEM_CLAIM);

    expect(run.status).toBe("done");
    expect(run.stepRunCount).toBe(7);
    expect(t.executed.map((call) => call.operation)).toEqual(["echo", "write", "write", "write"]);
    expect(writesOf(t)).toEqual(CLIENTS.map((client) => ({ client: client.id, note: NOTE })));
  });
});

describe("cancelling a Workflow Run", () => {
  it("starts no further step, ends the run as cancelled and leaves an ended run as it is", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.use");
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.read");
    const started = await start(t, t.kai.id);
    const jobs = t.worker();
    // One pass runs the trigger and queues the step after it.
    await jobs.runDue();

    // Lena neither started the run nor may she write the Workflow.
    await t.expectRefused(
      t.lena.id,
      "workflows.cancel_run",
      { params: { runId: started.id } },
      t.forbidden("workflow.write", "no_grant")
    );
    const cancelled = runSchema.parse(
      (await t.expectOk(t.kai.id, "workflows.cancel_run", { params: { runId: started.id } })).json()
    );
    expect(cancelled.status).toBe("cancelled");

    await jobs.runDue();
    await jobs.runDue();
    expect(t.executed).toEqual([]);
    expect(
      (await stepRunsOf(t, started.id)).map((stepRun) => [stepRun.key, stepRun.status])
    ).toEqual([
      ["start", "done"],
      ["clients", "cancelled"]
    ]);

    const again = runSchema.parse(
      (await t.expectOk(t.kai.id, "workflows.cancel_run", { params: { runId: started.id } })).json()
    );
    expect(again.status).toBe("cancelled");
    const audited = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.cancelled"
    });
    expect(audited).toHaveLength(1);
  });
});

describe("the limits of a Workflow Run", () => {
  it("ends as limit_reached where the run would create more step runs than it may", async () => {
    const t = await ready({ limits: { maxStepRuns: 5 } });
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("limit_reached");
    expect(run.error).toMatchObject({ code: "step_limit" });
    expect(run.stepRunCount).toBe(5);
    // Two items were sent before the limit, and nothing after it.
    expect(writesOf(t)).toHaveLength(2);
    expect((await stepRunsOf(t, run.id)).map((stepRun) => [stepRun.key, stepRun.status])).toEqual([
      ["start", "done"],
      ["clients", "done"],
      ["each_client", "cancelled"],
      ["each_client[0].send", "done"],
      ["each_client[1].send", "done"]
    ]);
  });

  it("ends as limit_reached where the run is past its time, before the next step starts", async () => {
    const t = await ready({ limits: { maxDurationMs: 0 } });
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("limit_reached");
    expect(run.error).toMatchObject({ code: "duration_limit" });
    expect(t.executed).toEqual([]);
    expect((await stepRunsOf(t, run.id)).map((stepRun) => [stepRun.key, stepRun.status])).toEqual([
      ["start", "cancelled"]
    ]);
  });

  it("fails a loop over a list longer than a loop may run", async () => {
    const t = await ready({ limits: { loopMaxItems: 2 } });
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "loop_too_long" });
    expect(writesOf(t)).toEqual([]);
  });
});

describe("an operation a Workflow Run is refused", () => {
  it("fails the step with the reason of the policy where a changing call would wait for a confirmation", async () => {
    const t = await ready();
    t.state.centralSettings = [{ operation: "connection.crm.write", value: "confirm" }];
    const run = await t.finish((await start(t)).id);

    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("POLICY_DENIED");
    expect(run.error?.message).toBe(
      "The instance's policy does not allow 'connection.crm.write' from here"
    );
    expect(writesOf(t)).toEqual([]);
    const stepRuns = await stepRunsOf(t, run.id);
    const failed = stepRuns.find((stepRun) => stepRun.key === "each_client[0].send");
    expect(failed).toMatchObject({ status: "failed", error: { code: "POLICY_DENIED" } });
    expect(run.error?.stepRunId).toBe(failed?.id);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")).toMatchObject({
      status: "failed",
      error: { code: "loop_step_failed" },
      loop: { total: 3, done: 0, failed: 1, running: 0 }
    });
    // The refusal is an Operation Run of its own, which keeps why.
    const denied = (await t.runs()).find((call) => call.id === failed?.operationRunId);
    expect(denied).toMatchObject({
      status: "denied",
      denial: { kind: "policy", operation: "connection.crm.write" }
    });
  });

  it("refuses a call the policy would hold for an approval instead of filing it", async () => {
    const t = await ready();
    t.state.centralSettings = [{ operation: "connection.crm.write", value: "approval" }];
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    expect(writesOf(t)).toEqual([]);
    expect(run.error?.code).toBe("POLICY_DENIED");
    // Nothing waits for somebody's decision: no request was filed for the call.
    const calls = (await t.runs()).filter((call) => call.origin.kind === "workflow");
    expect(calls.filter((call) => call.approvalRequestId !== undefined)).toEqual([]);
    expect(calls.map((call) => call.status).sort()).toEqual(["denied", "done"]);
  });

  it("acts with the grants of its principal and never with the starter's", async () => {
    // The starter is a superadmin and the principal holds nothing.
    const t = await workflowFixture();
    open = t;
    await t.seedCrm();
    const refused = await t.finish((await start(t, t.root.id)).id);
    expect(refused.status).toBe("failed");
    expect(refused.error?.code).toBe("FORBIDDEN");
    expect(t.executed).toEqual([]);
    const [, clients] = await stepRunsOf(t, refused.id);
    expect(clients).toMatchObject({ key: "clients", status: "failed" });

    // The starter holds the start and nothing of the Connection; the principal may use it.
    t.setBehaviour((operation, input) =>
      Promise.resolve<JsonValue>(operation === "echo" ? { clients: CLIENTS } : { received: input })
    );
    t.state.centralSettings = [{ operation: "connection.crm.write", value: "allow" }];
    await t.allow({ kind: "service_principal", id: t.principal.id }, "connection.use");
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.use");
    const allowed = await t.finish((await start(t, t.kai.id)).id);
    expect(allowed.status).toBe("done");
    expect(writesOf(t)).toHaveLength(3);
  });

  it("fails the step where the principal was disabled after the start", async () => {
    const t = await ready();
    const started = await start(t);
    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: t.principal.id,
      status: "disabled"
    });
    const run = await t.finish(started.id);
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("principal_inactive");
    expect(t.executed).toEqual([]);
  });
});

describe("a changing call that code repeats", () => {
  it("is refused without a key from a Workflow step and from a schedule alike", async () => {
    const t = await ready();
    await t.grant(t.kai.id, "connection.use", { assetId: await t.assetId("connection", "crm") });
    const origins: OperationOrigin[] = [
      {
        kind: "workflow",
        workflowRunId: createPlatformId<"WorkflowRunId">("wfr"),
        stepRunId: createPlatformId<"WorkflowStepRunId">("wfs")
      },
      { kind: "schedule", scheduleId: "sch_1" }
    ];
    for (const origin of origins) {
      await expect(
        t.invoke(t.kai, "connection.crm.write", {}, { origin, effect: "changing" })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(t.executed).toEqual([]);
  });
});

describe("the rights on the runs of a Workflow", () => {
  it("opens the start with workflow.use and the reads with workflow.read", async () => {
    const t = await ready();
    const input = { params: { workflow: "notify-clients" }, payload: { input: { note: NOTE } } };
    await t.expectRefused(
      t.kai.id,
      "workflows.start",
      input,
      t.forbidden("workflow.use", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "workflows.list_runs",
      { params: { workflow: "notify-clients" } },
      t.forbidden("workflow.read", "no_grant")
    );

    await t.allow({ kind: "user", id: t.kai.id }, "workflow.use");
    const started = await start(t, t.kai.id);
    // The right to start is not the right to read.
    for (const operation of ["workflows.get_run", "workflows.list_step_runs"] as const) {
      await t.expectRefused(
        t.kai.id,
        operation,
        { params: { runId: started.id } },
        t.forbidden("workflow.read", "no_grant")
      );
      // A run that does not exist is refused the same way: the refusal tells nothing.
      await t.expectRefused(
        t.kai.id,
        operation,
        { params: { runId: "wfr_none" } },
        t.forbidden("workflow.read", "no_grant")
      );
    }

    await t.allow({ kind: "user", id: t.lena.id }, "workflow.read");
    await t.expectOk(t.lena.id, "workflows.get_run", { params: { runId: started.id } });
    const listed = await t.expectOk(t.lena.id, "workflows.list_runs", {
      params: { workflow: "notify-clients" }
    });
    expect(listed.json()).toMatchObject({ items: [{ id: started.id }] });
    await t.expectRefused(t.lena.id, "workflows.start", input, {
      status: 403,
      code: "FORBIDDEN"
    });
    await t.expectRefused(
      t.lena.id,
      "workflows.get_run",
      { params: { runId: "wfr_none" } },
      { status: 404, code: "NOT_FOUND" }
    );
  });
});

describe("starting a Workflow that cannot run", () => {
  it("refuses an unknown Workflow, a definition this release does not execute and an input that does not fit", async () => {
    const t = await ready();
    await t.expectRefused(
      t.root.id,
      "workflows.start",
      { params: { workflow: "no-such-workflow" }, payload: {} },
      { status: 404, code: "NOT_FOUND" }
    );
    const invalid = await t.expectRefused(
      t.root.id,
      "workflows.start",
      { params: { workflow: "with-code-step" }, payload: {} },
      { status: 409, code: "CONFLICT" }
    );
    expect(invalid.details).toMatchObject({ reason: "definition_invalid" });
    expect(JSON.stringify(invalid.details)).toContain("code");
    await t.expectRefused(
      t.root.id,
      "workflows.start",
      { params: { workflow: "notify-clients" }, payload: { input: { note: 7 } } },
      { status: 422, code: "VALIDATION_FAILED" }
    );

    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: t.principal.id,
      status: "disabled"
    });
    const inactive = await t.expectRefused(
      t.root.id,
      "workflows.start",
      { params: { workflow: "notify-clients" }, payload: { input: { note: NOTE } } },
      { status: 409, code: "CONFLICT" }
    );
    expect(inactive.details).toMatchObject({ reason: "principal_inactive" });
    expect(
      await t.stores.audit.listAuditEvents({ clientInstanceId, type: "workflow_run.started" })
    ).toEqual([]);
  });
});

describe("the audit of a Workflow Run", () => {
  it("writes the start and the end as governance events without a value of the run", async () => {
    const t = await ready();
    const run = await t.finish((await start(t, t.root.id)).id);
    const events = [
      ...(await t.stores.audit.listAuditEvents({ clientInstanceId, type: "workflow_run.started" })),
      ...(await t.stores.audit.listAuditEvents({ clientInstanceId, type: "workflow_run.ended" }))
    ];
    expect(events.map((event) => [event.type, event.subject, event.status])).toEqual([
      ["workflow_run.started", run.id, "success"],
      ["workflow_run.ended", run.id, "success"]
    ]);
    const [startedEvent, endedEvent] = events;
    expect(startedEvent?.actor).toMatchObject({ userId: t.root.id });
    expect(startedEvent?.metadata).toEqual({
      workflow: "notify-clients",
      revision: expect.any(String),
      trigger: "manual",
      mode: "live",
      principalId: t.principal.id
    });
    expect(endedEvent?.actor).toMatchObject({ principalKind: "service" });
    expect(endedEvent?.metadata).toEqual({
      workflow: "notify-clients",
      revision: expect.any(String),
      status: "done",
      stepRunCount: 7
    });
    const written = JSON.stringify(events);
    expect(written).not.toContain(NOTE);
    expect(written).not.toContain("client-anna");
  });
});

describe("an instance with the module workflows off", () => {
  it("answers every operation of the runs as a missing one and serves no step job", async () => {
    const t = await workflowFixture({ moduleOn: false });
    open = t;
    expect(t.workflows.jobHandlers).toEqual([]);
    const off = {
      status: 404,
      code: "NOT_FOUND",
      details: { reason: "module_off", module: "workflows" }
    };
    await t.expectRefused(
      t.root.id,
      "workflows.start",
      { params: { workflow: "notify-clients" }, payload: { input: { note: NOTE } } },
      off
    );
    await t.expectRefused(
      t.root.id,
      "workflows.list_runs",
      { params: { workflow: "notify-clients" } },
      off
    );
    for (const operation of [
      "workflows.get_run",
      "workflows.list_step_runs",
      "workflows.cancel_run"
    ] as const) {
      await t.expectRefused(t.root.id, operation, { params: { runId: "wfr_none" } }, off);
    }
  });
});
