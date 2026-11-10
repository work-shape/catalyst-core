import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { asUserId, type CollaborationWorkspaceId } from "@work-shape/catalyst-core";
import { executeInboxConfirmedOperation } from "@work-shape/catalyst-tool-execution";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { guardedEvents } from "./support/guardrails";
import { getTestJobs, getTestOperationCalls } from "./support/test-instance";

// A CLI publish of a workspace agent's draft that waits in its person's Inbox: the person's
// Allow, then an approver's approval, make the draft live (OP-4b, WS-PUB-1b).

/** How the CLI signs in, and what `--yes` adds. */
const UNATTENDED_KEY = { "x-test-key": "personal", "catalyst-unattended": "1" };

const waitingSchema = z.object({
  id: z.string(),
  status: z.literal("pending_confirmation"),
  approvalRequestId: z.string()
});
const requestSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  applyResult: z.looseObject({}).optional(),
  payload: z.looseObject({}).optional(),
  preview: z.looseObject({}).optional()
});

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

async function setup() {
  const t = await setupAccessInstance({
    storedAssetSource: true,
    furtherToolNames: ["read_skill"],
    server: (stores) => ({
      operations: { events: guardedEvents(stores, {}, { shipped: true }).events }
    })
  });
  instances.push(t);
  const team = await t.sharedWorkspace("Team");
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: team,
    userId: asUserId(t.kai.id),
    role: "member"
  });
  for (const bundle of ["builder", "publisher"])
    await t.grant(t.kai.id, bundle, { workspaceId: team });
  const live = (name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "agent", name });
  const create = (userId: string, name: string, workspaceId: CollaborationWorkspaceId) =>
    t.expectOk(userId, "assets.put", {
      params: { kind: "agent", name },
      payload: { config: agent(name), expectedRevision: null, workspaceId }
    });
  const push = async (userId: string, name: string, overrides: Record<string, unknown>) => {
    const asset = await live(name);
    if (!asset) throw new Error(`No agent '${name}'`);
    // A write over a draft names the draft it read.
    const draft = await t.stores.agentProposals.get({ clientInstanceId, agentId: asset.id });
    const response = await t.call(userId, "assets.put", {
      params: { kind: "agent", name },
      payload: {
        config: { ...(draft?.config ?? asset.config), ...overrides },
        expectedRevision: asset.revision,
        ...(draft ? { expectedDraftRevision: draft.revision } : {}),
        workspaceId: team
      }
    });
    expect(response.statusCode, response.body).toBe(200);
  };
  const publishYes = (userId: string, name: string, revision: number) =>
    t.call(userId, "assets.publish", {
      params: { kind: "agent", name },
      payload: { revision, workspaceId: team },
      headers: UNATTENDED_KEY
    });
  const decide = async (userId: string, requestId: string) => {
    const response = await t.call(userId, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    await getTestJobs(t.instance).runDue();
    return response;
  };
  const request = async (userId: string, requestId: string) =>
    requestSchema.parse(
      (await t.expectOk(userId, "approval_requests.get", { params: { requestId } })).json()
    );
  const run = (runId: string) => t.stores.operationRuns.get({ clientInstanceId, id: runId });
  return { t, team, live, create, push, publishYes, decide, request, run };
}

describe("a CLI publish of a workspace agent's draft, confirmed in the Inbox", () => {
  it("goes live after the owner's Allow and an approver's approval", async () => {
    const { t, team, live, create, push, publishYes, decide, request, run } = await setup();
    await create(t.admin.id, "helper", team);
    await push(t.kai.id, "helper", { instructions: "Draft.", toolNames: ["known.tool"] });

    const filed = await publishYes(t.kai.id, "helper", 1);
    expect(filed.statusCode, filed.body).toBe(202);
    const waiting = waitingSchema.parse(filed.json());

    expect((await decide(t.kai.id, waiting.approvalRequestId)).statusCode).toBe(200);
    const held = await run(waiting.id);
    expect(held).toMatchObject({ status: "pending_approval" });
    const heldRequestId = held?.approvalRequestId ?? "";
    expect(heldRequestId).not.toBe(waiting.approvalRequestId);
    expect(await request(t.admin.id, heldRequestId)).toMatchObject({
      kind: "agent_publish",
      status: "pending"
    });

    const approved = await decide(t.admin.id, heldRequestId);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await request(t.admin.id, heldRequestId)).toMatchObject({
      status: "approved",
      applyResult: { execution: "done" }
    });
    expect(await live("helper")).toMatchObject({ revision: 2, config: { instructions: "Draft." } });
  });
});

// The owner's Allow of their CLI publish is the approval where the owner,
// signed in, may decide the approval it would file; otherwise it files that approval.
describe("an owner's Allow that is the approval", () => {
  it("publishes at once for a holder of agent.approve on the workspace, with no agent_publish item", async () => {
    const { t, team, live, create, push, publishYes, decide, request, run } = await setup();
    await t.grant(t.kai.id, "agent.approve", { workspaceId: team });
    await create(t.admin.id, "approver-own", team);
    await push(t.kai.id, "approver-own", { instructions: "Draft.", toolNames: ["known.tool"] });
    const before = await t.stores.approvals.countApprovalRequests({
      clientInstanceId,
      kinds: ["agent_publish"]
    });
    const waiting = waitingSchema.parse((await publishYes(t.kai.id, "approver-own", 1)).json());
    // The card says nothing of a second person: the Allow is the approval.
    expect((await request(t.kai.id, waiting.approvalRequestId)).preview).not.toHaveProperty(
      "approvalFollows"
    );

    expect((await decide(t.kai.id, waiting.approvalRequestId)).statusCode).toBe(200);
    expect(await live("approver-own")).toMatchObject({ revision: 2 });
    expect(await run(waiting.id)).toMatchObject({
      status: "done",
      decision: {
        mode: "approved",
        reason: "approved_by_caller",
        by: t.kai.id,
        byLabel: t.kai.displayLabel
      }
    });
    expect(
      await t.stores.approvals.countApprovalRequests({ clientInstanceId, kinds: ["agent_publish"] })
    ).toBe(before);
    expect(await request(t.kai.id, waiting.approvalRequestId)).toMatchObject({
      status: "approved",
      applyResult: { execution: "done" }
    });
  });

  it("files the approval for a person who may not approve, and the card says so first", async () => {
    const { t, team, live, create, push, publishYes, decide, request, run } = await setup();
    await create(t.admin.id, "builder-own", team);
    await push(t.kai.id, "builder-own", { instructions: "Draft.", toolNames: ["known.tool"] });
    const waiting = waitingSchema.parse((await publishYes(t.kai.id, "builder-own", 1)).json());
    expect((await request(t.kai.id, waiting.approvalRequestId)).preview).toMatchObject({
      approvalFollows: true
    });
    await decide(t.kai.id, waiting.approvalRequestId);
    expect(await run(waiting.id)).toMatchObject({ status: "pending_approval" });
    expect(await live("builder-own")).toMatchObject({ revision: 1 });
  });

  it("asks the rights the owner holds when confirming: one taken away since filing files the approval", async () => {
    const { t, team, live, create, push, publishYes, decide, run } = await setup();
    const grantId = await t.grant(t.kai.id, "agent.approve", { workspaceId: team });
    await create(t.admin.id, "lost-right", team);
    await push(t.kai.id, "lost-right", { instructions: "Draft.", toolNames: ["known.tool"] });
    const waiting = waitingSchema.parse((await publishYes(t.kai.id, "lost-right", 1)).json());
    await t.stores.access.deleteGrant({ clientInstanceId, grantId });

    await decide(t.kai.id, waiting.approvalRequestId);
    expect(await run(waiting.id)).toMatchObject({ status: "pending_approval" });
    expect(await live("lost-right")).toMatchObject({ revision: 1 });
  });

  it("refuses a confirmation recorded by anybody but the person the call acts for", async () => {
    const { t, team, live, create, push, publishYes, decide, run } = await setup();
    await t.grant(t.kai.id, "agent.approve", { workspaceId: team });
    await create(t.admin.id, "someone-else", team);
    await push(t.kai.id, "someone-else", { instructions: "Draft.", toolNames: ["known.tool"] });
    const waiting = waitingSchema.parse((await publishYes(t.kai.id, "someone-else", 1)).json());
    // Nobody else reaches the item.
    expect((await decide(t.admin.id, waiting.approvalRequestId)).statusCode).toBe(404);

    // A decision written for another person, as no route writes it, runs nothing.
    const stored = await t.stores.approvals.getApprovalRequest({
      clientInstanceId,
      requestId: waiting.approvalRequestId
    });
    const held = await run(waiting.id);
    if (!stored || !held) throw new Error("The confirmation is not stored");
    await t.stores.operationRuns.approveWaiting({
      clientInstanceId,
      id: held.id,
      decision: {
        mode: "confirmed",
        by: t.admin.id,
        byLabel: t.admin.displayLabel,
        at: new Date().toISOString()
      }
    });
    const calls = await getTestOperationCalls(t.instance);
    const end = await executeInboxConfirmedOperation(
      {
        runId: held.id,
        call: {
          operation: held.operation,
          effect: held.effect,
          input: stored.payload.input,
          actor: { ...t.kai, externalUserId: t.kai.id, authSource: "test" },
          origin: held.origin,
          ...(held.workspaceId ? { workspaceId: held.workspaceId } : {}),
          correlationId: held.correlationId
        }
      },
      calls.deps,
      { requestId: waiting.approvalRequestId }
    );
    expect(end).toMatchObject({ execution: "refused", error: { code: "FORBIDDEN" } });
    expect(await run(waiting.id)).toMatchObject({ status: "denied" });
    expect(await live("someone-else")).toMatchObject({ revision: 1 });
  });
});

// A revision that goes live settles the requests to publish an earlier or the same one: they
// leave To decide at once with the reason, and stay readable where their requester reads them.
describe("requests a revision that went live overtook", () => {
  const listSchema = z.object({ items: z.array(requestSchema) });

  it("settles both CLI confirmations when an admin publishes the draft in the interface", async () => {
    const { t, team, live, create, push, publishYes, request, run } = await setup();
    await create(t.admin.id, "overtaken", team);
    await push(t.kai.id, "overtaken", { instructions: "First.", toolNames: ["known.tool"] });
    const first = waitingSchema.parse((await publishYes(t.kai.id, "overtaken", 1)).json());
    await push(t.kai.id, "overtaken", { instructions: "Second.", toolNames: ["known.tool"] });
    const second = waitingSchema.parse((await publishYes(t.kai.id, "overtaken", 2)).json());

    // An instance admin's own Publish of the draft: the newer revision goes live.
    const published = await t.call(t.admin.id, "assets.publish", {
      params: { kind: "agent", name: "overtaken" },
      payload: { revision: 2, workspaceId: team }
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(await live("overtaken")).toMatchObject({ revision: 2 });

    const toDecide = listSchema.parse(
      (await t.expectOk(t.kai.id, "approval_requests.list", { query: { status: "pending" } })).json()
    );
    expect(toDecide.items.map((item) => item.id)).not.toContain(first.approvalRequestId);
    expect(toDecide.items.map((item) => item.id)).not.toContain(second.approvalRequestId);
    expect(await request(t.kai.id, first.approvalRequestId)).toMatchObject({
      status: "superseded",
      applyResult: {
        execution: "refused",
        error: { code: "PUBLISH_OVERTAKEN", liveRevision: 2, alreadyLive: false }
      },
      payload: { inputRemoved: true }
    });
    expect(await request(t.kai.id, second.approvalRequestId)).toMatchObject({
      status: "superseded",
      applyResult: {
        error: { code: "PUBLISH_OVERTAKEN", liveRevision: 2, alreadyLive: true }
      }
    });
    for (const waiting of [first, second])
      expect(await run(waiting.id)).toMatchObject({ status: "denied" });
    // Its requester reads it among their requests, as settled.
    const mine = listSchema.parse(
      (await t.expectOk(t.kai.id, "approval_requests.list_mine")).json()
    );
    expect(
      mine.items.filter((item) =>
        [first.approvalRequestId, second.approvalRequestId].includes(item.id)
      )
    ).toHaveLength(2);
  });

  it("settles the approval filed after an Allow when another revision goes live", async () => {
    const { t, team, live, create, push, publishYes, decide, request, run } = await setup();
    await create(t.admin.id, "held-then-overtaken", team);
    await push(t.kai.id, "held-then-overtaken", { instructions: "Kai.", toolNames: ["known.tool"] });
    const waiting = waitingSchema.parse(
      (await publishYes(t.kai.id, "held-then-overtaken", 1)).json()
    );
    await decide(t.kai.id, waiting.approvalRequestId);
    const heldRequestId = (await run(waiting.id))?.approvalRequestId ?? "";
    expect(await request(t.admin.id, heldRequestId)).toMatchObject({ status: "pending" });

    // The admin writes a draft of their own over Kai's and publishes it.
    await push(t.admin.id, "held-then-overtaken", { instructions: "Admin." });
    const published = await t.call(t.admin.id, "assets.publish", {
      params: { kind: "agent", name: "held-then-overtaken" },
      payload: { revision: 2, workspaceId: team }
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(await live("held-then-overtaken")).toMatchObject({
      revision: 2,
      config: { instructions: "Admin." }
    });

    expect(await request(t.admin.id, heldRequestId)).toMatchObject({
      kind: "agent_publish",
      status: "superseded",
      applyResult: { error: { code: "PUBLISH_OVERTAKEN", alreadyLive: false } }
    });
    const count = z
      .looseObject({ count: z.number() })
      .parse((await t.expectOk(t.admin.id, "approval_requests.count_pending")).json());
    expect(count.count).toBe(0);
    expect(await run(waiting.id)).toMatchObject({ status: "denied" });
  });

  it("leaves a request filed against the live revision as it is now", async () => {
    const { t, team, create, push, publishYes, request } = await setup();
    await create(t.admin.id, "other-agent", team);
    await create(t.admin.id, "still-waits", team);
    await push(t.kai.id, "still-waits", { instructions: "Kai.", toolNames: ["known.tool"] });
    const waiting = waitingSchema.parse((await publishYes(t.kai.id, "still-waits", 1)).json());
    // Another agent goes live: nothing of this request moved.
    await push(t.admin.id, "other-agent", { instructions: "Other." });
    await t.expectOk(t.admin.id, "assets.publish", {
      params: { kind: "agent", name: "other-agent" },
      payload: { revision: 1, workspaceId: team }
    });
    expect(await request(t.kai.id, waiting.approvalRequestId)).toMatchObject({
      status: "pending"
    });
  });
});
