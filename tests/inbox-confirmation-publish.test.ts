import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ASSET_KIND, type CentralPolicySetting } from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { guardedEvents } from "./support/guardrails";
import { getTestJobs } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";
import type { WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows } from "./support/workflow-runs";

// OP-4b: `catalyst <kind> publish --yes` is a call of the person's personal key marked
// unattended. It is not the person's own confirmation, so it waits in their Inbox, and in
// nobody else's; their Allow there is their click on Publish (operations checks 33 to 35).
// An admin set `assets.publish` to `allow` centrally: the floor holds anyway.

/** How the CLI signs in, and what `--yes` adds. */
const UNATTENDED_KEY = { "x-test-key": "personal", "catalyst-unattended": "1" };
const PUBLISH_ALLOWED: CentralPolicySetting = { operation: "assets.publish", value: "allow" };

const waitingSchema = z
  .object({
    id: z.string(),
    status: z.literal("pending_confirmation"),
    approvalRequestId: z.string()
  })
  .transform(({ id, approvalRequestId }) => ({ runId: id, requestId: approvalRequestId }));
const heldSchema = z.object({
  id: z.string(),
  status: z.literal("pending_approval"),
  approvalRequestId: z.string()
});
const requestSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  addresseeUserId: z.string().optional(),
  canDecide: z.boolean(),
  canWithdraw: z.boolean(),
  payload: z.looseObject({}),
  preview: z.looseObject({ review: z.looseObject({}).optional() }),
  applyResult: z.looseObject({}).optional()
});
const listSchema = z.object({ items: z.array(z.object({ id: z.string() })) });
const countSchema = z.looseObject({ count: z.number(), canReview: z.boolean() });

describe("an unattended CLI publish waits in its person's Inbox (OP-4b)", () => {
  let t: AppInstance;
  /** Holds `operations.approve` on the instance and nothing about Apps. */
  let approver: { id: string };
  beforeAll(async () => {
    t = await setupAppInstance({
      explicitCredentials: true,
      server: (stores) => ({
        operations: {
          events: guardedEvents(stores, {}, { shipped: true }).events,
          centralPolicySettings: () => [PUBLISH_ALLOWED]
        }
      })
    });
    for (const action of ["app.read", "app.write", "app.publish"]) {
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: t.kai.id,
        action,
        effect: "allow",
        scopeKind: "workspace",
        scopeId: t.workspaceId,
        grantedBy: t.admin.id
      });
    }
    approver = t.lena;
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: approver.id,
      action: "operations.approve",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: t.admin.id
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const stored = (name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name });
  const created = async (name: string) => {
    expectStatus(await t.putApp(t.admin.id, name, appFiles(`${name} 1`, { id: name })), 200);
  };
  const publishYes = (userId: string, name: string, headers: Record<string, string> = {}) =>
    t.call(userId, "assets.publish", {
      params: { kind: "app", name },
      payload: { revision: 1, workspaceId: t.workspaceId },
      headers: { ...UNATTENDED_KEY, ...headers }
    });
  const waits = async (userId: string, name: string) => {
    const response = await publishYes(userId, name);
    expectStatus(response, 202);
    return waitingSchema.parse(response.json());
  };
  const get = (userId: string, requestId: string) =>
    t.call(userId, "approval_requests.get", { params: { requestId } });
  const request = async (userId: string, requestId: string) =>
    requestSchema.parse(
      (await t.expectOk(userId, "approval_requests.get", { params: { requestId } })).json()
    );
  const decide = (
    userId: string,
    requestId: string,
    decision: "approve" | "reject" | "request_changes"
  ) =>
    t.call(userId, "approval_requests.decide", {
      params: { requestId },
      payload: { decision, ...(decision === "request_changes" ? { comment: "Why?" } : {}) }
    });
  const listed = async (userId: string, query: Record<string, string> = {}) =>
    listSchema
      .parse((await t.expectOk(userId, "approval_requests.list", { query })).json())
      .items.map((item) => item.id);
  const pending = async (userId: string) =>
    countSchema.parse((await t.expectOk(userId, "approval_requests.count_pending")).json());
  const run = (runId: string) => t.stores.operationRuns.get({ clientInstanceId, id: runId });

  it("check 33: a member's --yes publishes nothing and waits as a confirmation in their Inbox alone", async () => {
    await created("offers");
    const before = await pending(t.admin.id);

    const waiting = await waits(t.kai.id, "offers");

    expect((await stored("offers"))?.publishedRevision).toBeUndefined();
    expect(await run(waiting.runId)).toMatchObject({
      status: "pending_confirmation",
      origin: { kind: "cli", unattended: true },
      approvalRequestId: waiting.requestId
    });
    const item = await request(t.kai.id, waiting.requestId);
    expect(item).toMatchObject({
      kind: "operation_call",
      status: "pending",
      addresseeUserId: t.kai.id,
      canDecide: true,
      canWithdraw: false,
      payload: { mode: "confirmation", subjectKind: "app_publish" },
      preview: { mode: "confirmation", operation: "assets.publish" }
    });
    // The publish review of the App, as the approvers' item shows it.
    expect(item.preview.review).toMatchObject({ kind: "app", name: "offers", revision: 1 });
    expect(await listed(t.kai.id)).toContain(waiting.requestId);
    expect((await pending(t.kai.id)).count).toBeGreaterThanOrEqual(1);
    // Nobody else's count moved.
    expect((await pending(t.admin.id)).count).toBe(before.count);
  });

  it("check 35: nobody but the addressee sees, counts or decides it, an admin and an approver included", async () => {
    await created("rates");
    const waiting = await waits(t.kai.id, "rates");
    for (const other of [t.admin.id, t.root.id, approver.id]) {
      expect(await listed(other)).not.toContain(waiting.requestId);
      expect(await listed(other, { scope: "decided" })).not.toContain(waiting.requestId);
      const read = await get(other, waiting.requestId);
      expectStatus(read, 404);
      const decided = await decide(other, waiting.requestId, "approve");
      expectStatus(decided, 404);
    }
    // The approver has a queue, and it is the same with or without the item.
    expect((await pending(approver.id)).canReview).toBe(true);
    // A person who reviews nothing and was never addressed is refused the queue, as before.
    const stranger = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Stranger",
      roles: ["user"],
      permissions: []
    });
    expectStatus(await t.call(stranger.id, "approval_requests.list"), 403);
    expect(await pending(stranger.id)).toMatchObject({ count: 0, canReview: false });
    expect(await run(waiting.runId)).toMatchObject({ status: "pending_confirmation" });
    expect((await stored("rates"))?.publishedRevision).toBeUndefined();
  });

  it("check 33: the member's Allow files the app_publish item, which an admin approves; the frozen revision goes live once", async () => {
    await created("menu");
    const waiting = await waits(t.kai.id, "menu");
    const frozen = await run(waiting.runId);

    expectStatus(await decide(t.kai.id, waiting.requestId, "approve"), 200);
    await getTestJobs(t.instance).runDue();

    // The Allow was the member's click: the guardrail asks the approvers, as for their Publish.
    const moved = await run(waiting.runId);
    const held = heldSchema.parse({ ...moved, id: moved?.id });
    expect(held.approvalRequestId).not.toBe(waiting.requestId);
    expect((await stored("menu"))?.publishedRevision).toBeUndefined();
    expect(await request(t.kai.id, waiting.requestId)).toMatchObject({
      status: "approved",
      applyResult: { execution: "held", approvalRequestId: held.approvalRequestId }
    });
    const filed = await request(t.admin.id, held.approvalRequestId);
    expect(filed).toMatchObject({ kind: "app_publish", status: "pending", canDecide: true });
    expect(filed.addresseeUserId).toBeUndefined();
    expect(await request(t.kai.id, held.approvalRequestId)).toMatchObject({ canDecide: false });

    // A decided confirmation is not decided again, by anyone.
    const again = await decide(t.kai.id, waiting.requestId, "approve");
    expectStatus(again, 409);
    expectStatus(await decide(t.kai.id, waiting.requestId, "reject"), 409);
    // A job that runs again changes nothing.
    await getTestJobs(t.instance).runDue();
    expect(await run(waiting.runId)).toMatchObject({
      status: "pending_approval",
      approvalRequestId: held.approvalRequestId
    });

    expectStatus(await decide(t.admin.id, held.approvalRequestId, "approve"), 200);
    await getTestJobs(t.instance).runDue();
    expect(await stored("menu")).toMatchObject({ publishedRevision: 1 });
    expect(await run(waiting.runId)).toMatchObject({
      status: "done",
      actor: { id: t.kai.id },
      // The call ran as frozen: the input of the --yes call, and nothing else.
      inputHash: frozen?.inputHash,
      decision: { mode: "approved", by: t.admin.id }
    });
  });

  it("runs the frozen call or nothing: a draft that moved after --yes publishes nothing on Allow", async () => {
    await created("moving");
    const waiting = await waits(t.kai.id, "moving");
    expectStatus(await t.putApp(t.admin.id, "moving", appFiles("moving 2", { id: "moving" })), 200);
    expect((await request(t.kai.id, waiting.requestId)).preview.review).toMatchObject({
      stale: "draft_moved"
    });
    expectStatus(await decide(t.kai.id, waiting.requestId, "approve"), 200);
    await getTestJobs(t.instance).runDue();
    expect((await stored("moving"))?.publishedRevision).toBeUndefined();
    expect(await run(waiting.runId)).toMatchObject({ status: "denied" });
    expect(await request(t.kai.id, waiting.requestId)).toMatchObject({
      applyResult: { execution: "refused" }
    });
  });

  it("check 33: an instance admin's Allow publishes at once, with no item for the approvers", async () => {
    await created("catalog");
    const filedBefore = await t.stores.approvals.countApprovalRequests({
      clientInstanceId,
      kinds: ["app_publish"]
    });
    const waiting = await waits(t.admin.id, "catalog");
    expect((await stored("catalog"))?.publishedRevision).toBeUndefined();

    expectStatus(await decide(t.admin.id, waiting.requestId, "approve"), 200);
    await getTestJobs(t.instance).runDue();

    expect(await stored("catalog")).toMatchObject({ publishedRevision: 1 });
    expect(await run(waiting.runId)).toMatchObject({
      status: "done",
      actor: { id: t.admin.id },
      decision: { mode: "approved", reason: "approved_by_caller", by: t.admin.id }
    });
    expect(await request(t.admin.id, waiting.requestId)).toMatchObject({
      status: "approved",
      applyResult: { execution: "done" }
    });
    expect(
      await t.stores.approvals.countApprovalRequests({ clientInstanceId, kinds: ["app_publish"] })
    ).toBe(filedBefore);
  });

  it("refuses the call on Deny and asks nothing more; a confirmation cannot be sent back for changes", async () => {
    await created("specials");
    const waiting = await waits(t.kai.id, "specials");
    expectStatus(await decide(t.kai.id, waiting.requestId, "request_changes"), 422);
    expectStatus(await decide(t.kai.id, waiting.requestId, "reject"), 200);
    await getTestJobs(t.instance).runDue();
    expect(await run(waiting.runId)).toMatchObject({ status: "denied" });
    expect((await stored("specials"))?.publishedRevision).toBeUndefined();
    expect(await request(t.kai.id, waiting.requestId)).toMatchObject({ status: "rejected" });
    expectStatus(await decide(t.kai.id, waiting.requestId, "approve"), 409);
  });

  /** Makes the run due, as seven days without an answer would. */
  const pastDue = (runId: string) =>
    withTestSql(
      (sql) =>
        sql`update operation_runs set expires_at = now() - interval '1 second' where id = ${runId}`
    );

  it("check 34: a confirmation left for 7 days expires, ran nothing, and leaves To decide", async () => {
    await created("archive");
    const waiting = await waits(t.kai.id, "archive");
    const due = await run(waiting.runId);
    // Seven days, give or take the clock of the test.
    const waited = Date.parse(String(due?.expiresAt)) - Date.parse(String(due?.createdAt));
    expect(Math.abs(waited - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(60_000);
    const countBefore = (await pending(t.kai.id)).count;
    await pastDue(waiting.runId);
    await withTestSql(
      (sql) =>
        sql`update platform_jobs set run_after = now() where kind = 'operation_runs.expire' and client_instance_id = ${clientInstanceId} and status = 'queued'`
    );
    await getTestJobs(t.instance).runDue();
    expect(await run(waiting.runId)).toMatchObject({ status: "expired" });
    expect(await request(t.kai.id, waiting.requestId)).toMatchObject({
      status: "superseded",
      canDecide: false,
      applyResult: { execution: "expired" }
    });
    expect(await listed(t.kai.id, { status: "pending" })).not.toContain(waiting.requestId);
    expect((await pending(t.kai.id)).count).toBe(countBefore - 1);
    expectStatus(await decide(t.kai.id, waiting.requestId, "approve"), 409);
    expect((await stored("archive"))?.publishedRevision).toBeUndefined();
  });

  it("answers an Allow after the deadline, before any sweep, with the expiry, and runs nothing", async () => {
    await created("late");
    const waiting = await waits(t.kai.id, "late");
    await pastDue(waiting.runId);
    const late = await decide(t.kai.id, waiting.requestId, "approve");
    expectStatus(late, 200);
    expect(late.json()).toMatchObject({
      status: "superseded",
      applyResult: { execution: "expired" }
    });
    await getTestJobs(t.instance).runDue();
    expect((await stored("late"))?.publishedRevision).toBeUndefined();
    expect((await run(waiting.runId))?.status).not.toBe("done");
  });

  it("reads the header only from an API credential, and takes no other value", async () => {
    await created("sessions");
    // The person's own session is their click, header or not: the guardrail holds it for the
    // approvers, and nothing waits in their Inbox.
    const session = await t.call(t.kai.id, "assets.publish", {
      params: { kind: "app", name: "sessions" },
      payload: { revision: 1, workspaceId: t.workspaceId },
      headers: { "catalyst-unattended": "1" }
    });
    expectStatus(session, 202);
    expect(heldSchema.parse(session.json()).status).toBe("pending_approval");
    // The CLI without --yes is its caller's answer at the terminal: no confirmation either.
    const asked = await t.call(t.kai.id, "assets.publish", {
      params: { kind: "app", name: "sessions" },
      payload: { revision: 1, workspaceId: t.workspaceId },
      headers: { "x-test-key": "personal" }
    });
    expectStatus(asked, 202);
    expect(heldSchema.parse(asked.json()).status).toBe("pending_approval");
    const wrong = await publishYes(t.kai.id, "sessions", { "catalyst-unattended": "yes" });
    expectStatus(wrong, 422);
    expect(errorSchema.parse(wrong.json()).error.code).toBe("VALIDATION_FAILED");
  });
});

describe("an unattended CLI publish of a Workflow (OP-4b)", () => {
  let open: WorkflowFixture | undefined;
  afterAll(async () => {
    await open?.instance.close();
  });

  it("check 33: waits in the root's Inbox, and the root's Allow makes it live", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      {
        definitions: "assets",
        events: (stores) => guardedEvents(stores, {}, { shipped: true }).events
      }
    );
    const id = "unattended-notify";
    const put = await t.expectOk(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: id },
      payload: {
        config: { name: id, manifest: { ...notifyClients(), id } },
        expectedRevision: null
      }
    });
    const { revision } = z.object({ revision: z.number() }).parse(put.json());
    const response = await t.call(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: id },
      payload: { revision },
      headers: UNATTENDED_KEY
    });
    expectStatus(response, 202);
    const waiting = waitingSchema.parse(response.json());
    const asset = () =>
      t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name: id
      });
    expect((await asset())?.publishedRevision).toBeUndefined();
    expectStatus(
      await t.call(t.root.id, "approval_requests.decide", {
        params: { requestId: waiting.requestId },
        payload: { decision: "approve" }
      }),
      200
    );
    await getTestJobs(t.instance).runDue();
    expect(await asset()).toMatchObject({ publishedRevision: revision });
  });
});
