import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { asUserId, type CollaborationWorkspaceId } from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { guardedEvents } from "./support/guardrails";
import { getTestJobs } from "./support/test-instance";

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
  applyResult: z.looseObject({}).optional()
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
    const response = await t.call(userId, "assets.put", {
      params: { kind: "agent", name },
      payload: {
        config: { ...asset.config, ...overrides },
        expectedRevision: asset.revision,
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
