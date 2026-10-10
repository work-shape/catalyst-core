import { describe, expect, it } from "vitest";
import { apiErrorResponseSchema, operationRunSchema } from "@vivd-catalyst/api-contract";
import {
  asClientInstanceId,
  createPlatformId,
  legacyPermissionFor,
  type CentralPolicySetting
} from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import { registeredTestOperations as operations } from "./support/operations";
import {
  createTestInstance,
  getTestConfig,
  getTestJobs,
  registerTestOperations
} from "./support/test-instance";

// A call the policy holds for another person: from the 202 to the Inbox request, the decision
// and the one execution. The instance is assembled as a deployment assembles it, so the
// request is filed, listed and decided through the product's own approval routes.
//
// Every test here fails without the change: before it nothing held a call (the answer was 403
// POLICY_DENIED), and no approval kind executed one.

const HOUR_MS = 60 * 60 * 1000;
const approvalSetting: CentralPolicySetting = { operation: "testRunChange", value: "approval" };

async function fixture(input: { now?: () => Date; settings?: () => CentralPolicySetting[] } = {}) {
  /** `<actor id>:<name>` of every execution of the fixture operation. */
  const executed: string[] = [];
  const person = (id: string, roles: string[], rights: string[] = []) => ({
    id,
    externalUserId: id,
    displayLabel: id[0]?.toUpperCase() + id.slice(1),
    roles,
    permissionRefs: [],
    permissions: rights
  });
  const app = await createTestInstance({
    config: createTestConfig({
      developmentAuth: {
        enabled: true,
        users: [
          // May call the operation and may not decide on it.
          person("requester", ["user"], [legacyPermissionFor("users.manage")]),
          // An admin: may call and may decide, their own calls included.
          person("approver", ["admin"]),
          person("second", ["admin"]),
          person("stranger", ["user"])
        ],
        defaultUserId: "requester"
      }
    }),
    env: {},
    tools: [],
    operations: {
      centralPolicySettings: input.settings ?? (() => [approvalSetting]),
      ...(input.now ? { now: input.now } : {})
    }
  });
  registerTestOperations(app, (route) =>
    route.operation(operations.testRunChange, {
      execute: (item, context) => {
        executed.push(`${context.actor.displayLabel.toLowerCase()}:${item.name}`);
        return Promise.resolve({ name: item.name });
      }
    })
  );
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const as = (user: string) => ({ "x-dev-user-id": user });
  const call = (user: string, name: string, key?: string) =>
    app.call("testRunChange", {
      payload: { name },
      headers: { ...as(user), ...(key ? { "idempotency-key": key } : {}) }
    });
  const decide = (
    user: string,
    requestId: string,
    decision: "approve" | "reject",
    comment?: string
  ) =>
    app.call("approval_requests.decide", {
      params: { requestId },
      headers: as(user),
      payload: { decision, ...(comment ? { comment } : {}) }
    });
  const run = async (id: string) => {
    const found = await app.stores.operationRuns.get({ clientInstanceId, id });
    if (!found) throw new Error(`No run ${id}`);
    return found;
  };
  /** Files one call and answers its run and its approval request. */
  const hold = async (name = "held", key = "key-1", user = "requester") => {
    const response = await call(user, name, key);
    expect(response.statusCode).toBe(202);
    const body = operationRunSchema.parse(response.json());
    if (!body.approvalRequestId) throw new Error("The held call names no approval request");
    return { runId: body.id, requestId: body.approvalRequestId, body };
  };
  return { app, clientInstanceId, executed, as, call, decide, run, hold };
}

const errorOf = (response: { json(): unknown }) =>
  apiErrorResponseSchema.parse(response.json()).error;

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

    const approved = await f.decide("approver", requestId, "approve", "Looks right");
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "approved" });
    // It ran as the requester, not as the approver.
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
    expect(f.executed).toEqual(["requester:raced"]);
    expect((await f.run(runId)).status).toBe("done");
  });

  it("lets a person with the right approve their own call", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("own", "key-own", "approver");
    const approved = await f.decide("approver", requestId, "approve");
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
    expect(await f.run(runId)).toMatchObject({ status: "denied", denial: { kind: "declined" } });
    expect((await f.decide("approver", requestId, "approve")).statusCode).toBe(409);
    expect(f.executed).toEqual([]);
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
    expect(request?.status).toBe("superseded");
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

    const late = await f.decide("approver", requestId, "approve");
    expect(late.json()).toMatchObject({ status: "superseded" });
    expect(f.executed).toEqual([]);
    expect((await f.run(runId)).status).toBe("pending_approval");
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

    // The request ends as superseded: the approval is not recorded and nothing runs.
    const approved = await f.decide("approver", requestId, "approve");
    expect(approved.json()).toMatchObject({ status: "superseded" });
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

    const approved = await f.decide("approver", requestId, "approve");
    expect(approved.json()).toMatchObject({ status: "superseded" });
    expect(f.executed).toEqual([]);
    expect(await f.run(runId)).toMatchObject({ status: "denied", denial: { kind: "policy" } });
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
