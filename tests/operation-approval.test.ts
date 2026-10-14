import { describe, expect, it } from "vitest";
import { createPlatformId, type CentralPolicySetting } from "@vivd-catalyst/core";
import { approvalSetting, errorOf, fixture, HOUR_MS } from "./support/operation-approval";
import { getTestJobs } from "./support/test-instance";

// A call the policy holds for another person: from the 202 to the Inbox request, the decision
// and the one execution. The instance is assembled as a deployment assembles it, so the
// request is filed, listed and decided through the product's own approval routes.
//
// Every test here fails without the change: before it nothing held a call (the answer was 403
// POLICY_DENIED), and no approval kind executed one.
//
// An approval records the decision and enqueues the job that executes the call. `approve`
// lets that job run; a test that looks at the moment between the two decides with `decide`.

describe("a call that waits for another person", () => {
  it("answers 202, is listed for the people who decide with the call, its actor and its inputs", async () => {
    const f = await fixture();
    const { runId, requestId, body } = await f.hold("rename-me");
    expect(body).toMatchObject({ status: "pending_approval", operation: "testRunChange" });
    expect(f.executed).toEqual([]);

    const listed = await f.app.call("approval_requests.list", {
      query: { status: "pending" },
      headers: f.as("approver")
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toMatchObject([
      { id: requestId, kind: "operation_call", status: "pending", canDecide: true }
    ]);
    const detail = await f.app.call("approval_requests.get", {
      params: { requestId },
      headers: f.as("approver")
    });
    expect(detail.json()).toMatchObject({
      id: requestId,
      kind: "operation_call",
      requestedBy: { displayLabel: "Requester" },
      preview: {
        runId,
        operation: "testRunChange",
        effect: "changing",
        actor: { kind: "user", label: "Requester" },
        origin: { kind: "user" },
        // The input as the operation read it, its default included.
        inputs: expect.arrayContaining([
          { key: "name", value: "rename-me" },
          { key: "mode", value: "ok" }
        ])
      },
      canDecide: true
    });
    // The person who called reads the request and may not decide it without the right.
    const own = await f.app.call("approval_requests.get", {
      params: { requestId },
      headers: f.as("requester")
    });
    expect(own.json()).toMatchObject({ canDecide: false, canWithdraw: true });
    const refused = await f.decide("requester", requestId, "approve");
    expect(refused.statusCode).toBe(403);
    expect(
      await f.app.call("approval_requests.get", {
        params: { requestId },
        headers: f.as("stranger")
      })
    ).toMatchObject({ statusCode: 404 });
    expect(f.executed).toEqual([]);
    expect((await f.run(runId)).status).toBe("pending_approval");
  });

  it("executes once on approval, as the person who called, and refuses a second approval", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("approved");

    // The decision is recorded and answered before anything of the call runs.
    const approved = await f.decide("approver", requestId, "approve", "Looks right");
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: "approved",
      applyResult: { runId, execution: "queued" }
    });
    expect(f.executed).toEqual([]);
    expect((await f.run(runId)).status).toBe("pending_approval");

    await f.runJobs();
    // It ran as the requester, not as the approver.
    expect(f.executed).toEqual(["requester:approved"]);
    expect(await f.stored(requestId)).toMatchObject({
      status: "approved",
      decision: { decidedByLabel: "Approver", comment: "Looks right" },
      applyResult: { runId, execution: "done" }
    });
    // A job that comes by again finds the call executed and runs nothing.
    await f.runJobs();
    expect(f.executed).toEqual(["requester:approved"]);
    const run = await f.run(runId);
    const users = await f.app.stores.users.listUsers({ clientInstanceId: f.clientInstanceId });
    const idOf = (label: string) => users.find((user) => user.displayLabel === label)?.id;
    expect(run).toMatchObject({
      status: "done",
      actor: { kind: "user", id: idOf("Requester") },
      decision: { mode: "approved", by: idOf("Approver"), byLabel: "Approver" }
    });

    const again = await f.decide("approver", requestId, "approve");
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe("CONFLICT");
    const other = await f.decide("second", requestId, "reject", "Too late");
    expect(other.statusCode).toBe(409);
    expect(f.executed).toEqual(["requester:approved"]);
    expect((await f.run(runId)).decision?.mode).toBe("approved");

    // The caller's key now answers what the execution answered, and executes nothing.
    const replay = await f.call("requester", "approved", "key-1");
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ name: "approved" });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.headers["operation-run-id"]).toBe(runId);
    expect(f.executed).toEqual(["requester:approved"]);

    // The run's own events, each once: checked when it was called, started and completed
    // when it was approved.
    const audit = await f.app.stores.audit.listAuditEvents({
      clientInstanceId: f.clientInstanceId
    });
    const ofRun = audit.filter((event) => event.metadata?.operationRunId === runId);
    expect(ofRun.map((event) => event.type).sort()).toEqual([
      // Asked when the call was made and again when it was to run.
      "operation.authorization_checked",
      "operation.authorization_checked",
      "operation.completed",
      "operation.started"
    ]);
    // Each names the person who called as its actor.
    expect(new Set(ofRun.map((event) => event.actor?.userId))).toEqual(
      new Set([idOf("Requester")])
    );
    expect(audit.map((event) => event.type)).toEqual(
      expect.arrayContaining(["approval_request.created", "approval_request.decided"])
    );
  });

  it("executes once when two people approve at the same moment", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("raced");
    const both = await Promise.all([
      f.decide("approver", requestId, "approve"),
      f.decide("second", requestId, "approve")
    ]);
    expect(both.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    await f.runJobs();
    expect(f.executed).toEqual(["requester:raced"]);
    expect((await f.run(runId)).status).toBe("done");
  });

  it("lets a person with the right approve their own call", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("own", "key-own", "approver");
    const approved = await f.approve("approver", requestId);
    expect(approved.statusCode).toBe(200);
    expect(f.executed).toEqual(["approver:own"]);
    expect(await f.run(runId)).toMatchObject({ status: "done", decision: { mode: "approved" } });
  });

  it("ends a rejected call as declined, executes nothing and answers its key 403 DECLINED", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("rejected");

    const rejected = await f.decide("approver", requestId, "reject", "Not this one");
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: "rejected" });
    expect(await f.run(runId)).toMatchObject({
      status: "denied",
      denial: { kind: "declined", comment: "Not this one" },
      decision: { mode: "declined", byLabel: "Approver", comment: "Not this one" }
    });

    const replay = await f.call("requester", "rejected", "key-1");
    expect(replay.statusCode).toBe(403);
    expect(errorOf(replay).code).toBe("DECLINED");
    expect(replay.headers["operation-run-id"]).toBe(runId);
    // A decision that comes after is refused and says the request is decided.
    const late = await f.decide("second", requestId, "approve");
    expect(late.statusCode).toBe(409);
    expect(f.executed).toEqual([]);
  });

  it("ends a withdrawn call as declined by its own caller", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("withdrawn");
    const withdrawn = await f.app.call("approval_requests.withdraw", {
      params: { requestId },
      headers: f.as("requester")
    });
    expect(withdrawn.statusCode).toBe(200);
    // Withdrawing ends the run: it does not stay waiting for a request nobody can decide.
    expect(await f.run(runId)).toMatchObject({
      status: "denied",
      denial: { kind: "declined" },
      decision: { mode: "declined", byLabel: "Requester" }
    });
    expect(await f.stored(requestId)).toMatchObject({ status: "withdrawn" });
    expect((await f.approve("approver", requestId)).statusCode).toBe(409);
    expect(f.executed).toEqual([]);
    const replay = await f.call("requester", "withdrawn", "key-1");
    expect(errorOf(replay).code).toBe("DECLINED");
  });

  it("expires a call nobody decided: run expired, request superseded, key answers 409", async () => {
    let now = new Date(Date.now() - 8 * 24 * HOUR_MS);
    const f = await fixture({ now: () => now });
    const { runId, requestId } = await f.hold("too-late");
    now = new Date();

    await getTestJobs(f.app).runDue();

    expect((await f.run(runId)).status).toBe("expired");
    const request = await f.app.stores.approvals.getApprovalRequest({
      clientInstanceId: f.clientInstanceId,
      requestId
    });
    // The request says that it expired and names nobody who decided it.
    expect(request).toMatchObject({
      status: "superseded",
      applyResult: { runId, execution: "expired" }
    });
    expect(request?.decision).toBeUndefined();
    const replay = await f.call("requester", "too-late", "key-1");
    expect(replay.statusCode).toBe(409);
    expect(errorOf(replay).code).toBe("OPERATION_EXPIRED");
    const late = await f.decide("approver", requestId, "approve");
    expect(late.statusCode).toBe(409);
    expect(f.executed).toEqual([]);
  });

  it("does not execute a call whose time ran out before the expire job came by", async () => {
    let now = new Date(Date.now() - 8 * 24 * HOUR_MS);
    const f = await fixture({ now: () => now });
    const { runId, requestId } = await f.hold("stale");
    now = new Date();

    // Fails before the fix: the request was recorded as superseded by the approver, as if
    // their approval had been a decision.
    const late = await f.approve("approver", requestId);
    expect(late.json()).toMatchObject({
      status: "superseded",
      applyResult: { runId, execution: "expired" }
    });
    expect(late.json().decision).toBeUndefined();
    expect(f.executed).toEqual([]);
    // The job that comes by afterwards ends the run. Its request is ended already.
    await getTestJobs(f.app).runDue();
    expect((await f.run(runId)).status).toBe("expired");
    expect((await f.decide("second", requestId, "approve")).statusCode).toBe(409);
  });

  it("does not execute an approved call whose caller lost the right meanwhile", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("revoked");
    const users = await f.app.stores.users.listUsers({ clientInstanceId: f.clientInstanceId });
    const requester = users.find((user) => user.displayLabel === "Requester");
    if (!requester) throw new Error("No requester");
    await f.app.stores.users.updateUser({
      clientInstanceId: f.clientInstanceId,
      userId: requester.id,
      permissions: []
    });

    // The right is asked when the call is to run. The request ends as superseded with the
    // reason, and nothing runs.
    await f.approve("approver", requestId);
    expect(await f.stored(requestId)).toMatchObject({
      status: "superseded",
      applyResult: { runId, execution: "refused", error: { code: "FORBIDDEN" } }
    });
    expect(f.executed).toEqual([]);
    expect(await f.run(runId)).toMatchObject({
      status: "denied",
      denial: { kind: "forbidden", action: "users.manage" }
    });
  });

  it("does not execute an approved call the policy has come to refuse", async () => {
    let settings: CentralPolicySetting[] = [approvalSetting];
    const f = await fixture({ settings: () => settings });
    const { runId, requestId } = await f.hold("refused-now");
    settings = [{ operation: "testRunChange", value: "deny" }];

    await f.approve("approver", requestId);
    expect(await f.stored(requestId)).toMatchObject({
      status: "superseded",
      applyResult: { execution: "refused", error: { code: "POLICY_DENIED" } }
    });
    expect(f.executed).toEqual([]);
    expect(await f.run(runId)).toMatchObject({ status: "denied", denial: { kind: "policy" } });
  });
});

/** Fails the test when `work` has not answered in time, instead of hanging with it. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The decision of a held call uses the one connection of its transaction and executes nothing.
// Before, each approval held its transaction's connection while its handler took more from the
// same pool and then ran the call: as many approvals as the pool has connections (10 by
// default) left every connection idle in a transaction for good and the API answered nobody.
describe("many approvals at the same moment", () => {
  const POOL_SIZE = 10;

  it("answers at once when pool-size-plus-two held calls are approved together, and every call ends", async () => {
    const f = await fixture();
    const held: { runId: string; requestId: string }[] = [];
    for (let index = 0; index < POOL_SIZE + 2; index++) {
      held.push(await f.hold(`load-${index}`, `key-${index}`));
    }

    const decided = await within(
      15_000,
      "Approving all calls at once",
      Promise.all(held.map(({ requestId }) => f.decide("approver", requestId, "approve")))
    );
    expect(decided.map((response) => response.statusCode)).toEqual(held.map(() => 200));
    // The API answers while the approved calls still wait to be executed.
    const listed = await within(
      5_000,
      "The API",
      f.app.call("approval_requests.list", {
        query: { status: "pending" },
        headers: f.as("approver")
      })
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([]);
    expect(f.executed).toEqual([]);

    // Four calls run at a time, so the queue takes several passes.
    for (let pass = 0; pass < held.length && f.executed.length < held.length; pass++) {
      await f.runJobs();
    }
    expect([...f.executed].sort()).toEqual(
      held.map((_call, index) => `requester:load-${index}`).sort()
    );
    for (const { runId, requestId } of held) {
      expect(await f.run(runId)).toMatchObject({
        status: "done",
        decision: { mode: "approved" }
      });
      expect(await f.stored(requestId)).toMatchObject({
        status: "approved",
        applyResult: { execution: "done" }
      });
    }
    const health = await within(5_000, "The API", f.call("approver", "after", "key-after"));
    expect(health.statusCode).toBe(202);
  }, 60_000);

  it("refuses fifteen of sixteen approvals of one request at once and executes the call once", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("sixteen");

    const decided = await within(
      15_000,
      "Sixteen approvals of one request",
      Promise.all(
        Array.from({ length: 16 }, (_unused, index) =>
          f.decide(index % 2 === 0 ? "approver" : "second", requestId, "approve")
        )
      )
    );
    const codes = decided.map((response) => response.statusCode).sort();
    expect(codes).toEqual([200, ...Array.from({ length: 15 }, () => 409)]);
    await f.runJobs();
    expect(f.executed).toEqual(["requester:sixteen"]);
    expect((await f.run(runId)).status).toBe("done");
  }, 60_000);
});

// What is asked again, as the person who made the call, at the moment the call is to run.
// Before, an approved call ran on what was true when it was approved, inside that request.
describe("an approved call at the moment it runs", () => {
  it("does not run for a person whose account was closed after the approval", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("closed");
    // Approved while the account was open: the decision is recorded.
    const approved = await f.decide("approver", requestId, "approve");
    expect(approved.json()).toMatchObject({ status: "approved" });
    await f.app.stores.users.updateUser({
      clientInstanceId: f.clientInstanceId,
      userId: await f.userId("Requester"),
      status: "disabled"
    });

    await f.runJobs();

    expect(f.executed).toEqual([]);
    expect(await f.stored(requestId)).toMatchObject({
      status: "superseded",
      applyResult: {
        runId,
        execution: "refused",
        error: { message: "The account of the person who made this call is closed or deleted." }
      }
    });
    expect(await f.run(runId)).toMatchObject({
      status: "denied",
      denial: { kind: "forbidden", reason: "holder_inactive" }
    });
  });

  it("does not run a call the policy came to refuse after the approval", async () => {
    let settings: CentralPolicySetting[] = [approvalSetting];
    const f = await fixture({ settings: () => settings });
    const { runId, requestId } = await f.hold("denied-after");
    expect((await f.decide("approver", requestId, "approve")).json().status).toBe("approved");
    settings = [{ operation: "testRunChange", value: "deny" }];

    await f.runJobs();

    expect(f.executed).toEqual([]);
    expect(await f.stored(requestId)).toMatchObject({
      status: "superseded",
      applyResult: { execution: "refused", error: { code: "POLICY_DENIED" } }
    });
    expect(await f.run(runId)).toMatchObject({ status: "denied", denial: { kind: "policy" } });
  });

  it("ends a call that takes longer than its operation's time as failed, and tells it to stop", async () => {
    const f = await fixture({ timeoutMs: 100 });
    const { runId, requestId } = await f.hold("slow-one");

    await f.approve("approver", requestId);

    expect(f.executed).toEqual(["requester:slow-one"]);
    // The implementation was told to stop through its signal.
    expect(f.stopped).toEqual(["slow-one"]);
    expect(await f.run(runId)).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
    expect(await f.stored(requestId)).toMatchObject({
      status: "approved",
      applyResult: { runId, execution: "failed", error: { code: "TIMEOUT" } }
    });
  });

  it("records a call whose first attempt never ended as interrupted and does not run it again", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("cut-off");
    expect((await f.decide("approver", requestId, "approve")).statusCode).toBe(200);
    // The process that took the run for execution ended before the call did.
    const taken = await f.app.stores.operationRuns.resume({
      clientInstanceId: f.clientInstanceId,
      id: (await f.run(runId)).id,
      startedAt: new Date().toISOString(),
      decision: { mode: "approved", by: "usr_x", at: new Date().toISOString() }
    });
    expect(taken?.status).toBe("running");

    // The job's next attempt does not wait for the sweep of runs that never ended.
    await f.runJobs();

    expect(f.executed).toEqual([]);
    expect(await f.run(runId)).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect(await f.stored(requestId)).toMatchObject({
      status: "approved",
      applyResult: { runId, execution: "interrupted" }
    });
  });
});

describe("runs that never end", () => {
  it("fails a run that is still running past its operation's time as interrupted", async () => {
    const f = await fixture();
    const startedLongAgo = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const base = {
      clientInstanceId: f.clientInstanceId,
      // An operation this process does not know counts as interrupted after an hour.
      operation: "gone.operation",
      effect: "changing" as const,
      target: "live" as const,
      actor: { kind: "user" as const, id: "usr_1", label: "One" },
      origin: {
        kind: "app" as const,
        appRevisionId: "rev",
        actionName: "save",
        pageSessionId: "page"
      },
      inputHash: "a".repeat(64)
    };
    const stuck = await f.app.stores.operationRuns.create({
      ...base,
      id: createPlatformId<"OperationRunId">("oprun"),
      correlationId: "corr_stuck",
      idempotencyKey: "stuck",
      startedAt: startedLongAgo
    });
    const working = await f.app.stores.operationRuns.create({
      ...base,
      id: createPlatformId<"OperationRunId">("oprun"),
      correlationId: "corr_working",
      startedAt: recent
    });
    if (!stuck || !working) throw new Error("The runs were not created");

    await getTestJobs(f.app).runDue();

    expect(await f.run(stuck.id)).toMatchObject({
      status: "failed",
      error: { code: "interrupted" }
    });
    expect((await f.run(working.id)).status).toBe("running");
  });
});
