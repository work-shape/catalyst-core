import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asUserId,
  createAuthorizer,
  type AgentRuntime,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { withTestSql } from "./support/test-sql";

// CHAT-SHARE-6a (chat-sharing.md 3.9, ADR-0034): a turn of a person who reads a shared chat
// from outside its workspace runs with their own rights as a non-member. Nothing comes from
// membership or from the chat's creator: the team's own agent is replaced by an instance agent
// open to them, and the team's Knowledge Bases, Connections and skills stay closed.

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

const refuse = (): never => {
  throw new Error("Not used here");
};
/** Takes every run the start service prepared, without running it. */
const queuedRuntime: AgentRuntime = {
  async start(input) {
    const prepared = input.preparedRun ?? refuse();
    return { runId: prepared.id, status: "queued", startedAt: prepared.startedAt };
  },
  observe: () => refuse(),
  getStatus: async () => refuse(),
  resume: async () => refuse(),
  cancel: async () => refuse()
};

const offerSchema = z.object({
  workspace: z.object({ id: z.string(), name: z.string() }),
  outside: z.boolean(),
  defaultAgentName: z.string().optional(),
  agents: z.array(z.object({ name: z.string() }))
});
const startedSchema = z.object({ run: z.object({ agentName: z.string() }) });

/** The person as a turn of theirs acts: their own record, in their own session. */
function identityOf(user: UserRecord): AuthenticatedUser {
  return {
    id: user.id,
    subjectUserId: user.id,
    externalUserId: user.id,
    authSource: "test",
    clientInstanceId,
    displayLabel: user.displayLabel,
    roles: user.roles,
    permissionRefs: user.permissionRefs,
    permissions: user.permissions
  };
}

/** An asset the team owns or the instance offers in the team, active and available there. */
async function teamAsset(
  kind: string,
  name: string,
  workspaceId: CollaborationWorkspaceId,
  owner: "workspace" | "instance"
): Promise<{ kind: string; name: string; assetId: string; workspaceId?: string }> {
  const assetId = `asset_outside_${kind}_${name}`;
  await withTestSql(
    (sql) => sql`
      insert into config_assets (id, client_instance_id, kind, name, scope_kind, scope_id, status, active_revision_id, created_at, updated_at)
      values (${assetId}, ${clientInstanceId}, ${kind}, ${name}, ${owner}, ${owner === "workspace" ? workspaceId : null}, 'active', ${`rev_${assetId}`}, now(), now())`
  );
  await withTestSql(
    (sql) => sql`
      insert into config_asset_availability (asset_id, client_instance_id, mode, updated_at)
      values (${assetId}, ${clientInstanceId}, 'selected', now())`
  );
  await withTestSql(
    (sql) => sql`
      insert into config_asset_workspace_availability (asset_id, collaboration_workspace_id)
      values (${assetId}, ${workspaceId})`
  );
  return {
    kind,
    name,
    assetId,
    ...(owner === "workspace" ? { workspaceId } : {})
  };
}

/**
 * A team with its own agent beside the instance's `assistant`, a creator and a member of it,
 * and a reader who is in another team only; the creator's private chat names the reader.
 */
async function setup() {
  const t = await setupAccessInstance({
    storedAssetSource: true,
    server: () => ({ agentRuntime: queuedRuntime })
  });
  instances.push(t);
  const team = await t.sharedWorkspace("Team T");
  const elsewhere = await t.sharedWorkspace("Team U");
  const user = (displayLabel: string) =>
    t.stores.users.createUser({ clientInstanceId, displayLabel, roles: ["user"] });
  const creator = await user("Creator");
  const member = await user("Member");
  const reader = await user("Reader");
  const join = (userId: string, workspaceId: CollaborationWorkspaceId) =>
    t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId,
      userId: asUserId(userId),
      role: "member"
    });
  await join(creator.id, team);
  await join(member.id, team);
  await join(reader.id, elsewhere);
  await t.expectOk(t.admin.id, "assets.put", {
    params: { kind: "agent", name: "team-agent" },
    payload: { config: agent("team-agent"), workspaceId: team }
  });
  const chat = z.object({ id: z.string() }).parse(
    (
      await t.expectOk(creator.id, "conversations.create", {
        payload: { title: "Figures", collaborationWorkspaceId: team, visibility: "private" }
      })
    ).json()
  ).id;
  let sent = 0;
  const start = (userId: string, agentName: string) => {
    sent += 1;
    return t.call(userId, "conversations.runs.start", {
      params: { conversationId: chat },
      payload: { agentName, idempotencyKey: `outside-${sent}`, message: { text: "Next step" } }
    });
  };
  const readerOffer = async (userId: string) =>
    offerSchema.parse(
      (
        await t.expectOk(userId, "conversations.reader_offer.get", {
          params: { conversationId: chat }
        })
      ).json()
    );
  const finish = async () =>
    withTestSql(
      (sql) =>
        sql`update agent_runs set status = 'completed', completed_at = now() where conversation_id = ${chat}`
    );
  return { t, team, creator, member, reader, chat, start, readerOffer, finish };
}

describe("CHAT-SHARE-6a: an outside reader's turns run with their own rights", () => {
  it("runs an instance agent open to them in place of the team's own, and with none open lets them read only", async () => {
    const { t, team, creator, reader, chat, start, readerOffer, finish } = await setup();
    // Before the share the reader reaches nothing of the chat.
    expect((await start(reader.id, "assistant")).statusCode).toBe(404);
    await t.expectOk(creator.id, "conversations.add_person", {
      params: { conversationId: chat },
      payload: { userId: reader.id }
    });

    // The member is offered the team's agent; the reader only the instance's.
    const asMember = await readerOffer(creator.id);
    expect(asMember.outside).toBe(false);
    expect(asMember.agents.map((offered) => offered.name)).toContain("team-agent");
    const asReader = await readerOffer(reader.id);
    expect(asReader).toMatchObject({
      workspace: { id: team, name: "Team T" },
      outside: true,
      defaultAgentName: "assistant"
    });
    expect(asReader.agents.map((offered) => offered.name)).toEqual(["assistant"]);
    // The workspace's own agent list stays closed to them.
    const listed = await t.call(reader.id, "workspaces.agents.list", {
      params: { collaborationWorkspaceId: team }
    });
    expect(listed.statusCode).toBe(404);

    // The chat runs on the team's agent: the member's turn keeps it, the reader's turn runs the
    // instance agent instead.
    const memberTurn = await start(creator.id, "team-agent");
    expect(startedSchema.parse(memberTurn.json()).run.agentName).toBe("team-agent");
    await finish();
    const readerTurn = await start(reader.id, "team-agent");
    expect(readerTurn.statusCode, readerTurn.body).toBe(200);
    expect(startedSchema.parse(readerTurn.json()).run.agentName).toBe("assistant");
    await finish();

    // With the instance agent limited to holders of `agent.use`, none is open to them: they
    // read, and their send is refused with its reason. The member still continues.
    const assistant = await t.assetId("agent", "assistant");
    await withTestSql(
      (sql) => sql`
        insert into agent_use_limits (asset_id, client_instance_id, updated_at)
        values (${assistant}, ${clientInstanceId}, now())`
    );
    const none = await readerOffer(reader.id);
    expect(none.agents).toEqual([]);
    expect(none.defaultAgentName).toBeUndefined();
    const refused = await start(reader.id, "team-agent");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { code: "CONFLICT", details: { reason: "no_agent_open" } }
    });
    await t.expectOk(reader.id, "conversations.thread.get", { params: { conversationId: chat } });
    expect(startedSchema.parse((await start(creator.id, "team-agent")).json()).run.agentName).toBe(
      "team-agent"
    );
  });

  it("resolves the same rights in the chat as the person holds outside the workspace: no Knowledge Base, Connection, skill or agent of the team", async () => {
    const { t, team, creator, member, reader, chat } = await setup();
    const resources = [
      ["knowledge_base.use", await teamAsset("knowledge_base", "team-kb", team, "workspace")],
      ["knowledge_base.use", await teamAsset("knowledge_base", "offered-kb", team, "instance")],
      ["connection.use", await teamAsset("connection", "team-crm", team, "workspace")],
      ["connection.use", await teamAsset("connection", "offered-crm", team, "instance")],
      ["skill.read", await teamAsset("skill", "team-skill", team, "workspace")],
      ["data_store.read", await teamAsset("data_store", "team-ledger", team, "workspace")],
      [
        "agent.use",
        {
          kind: "agent",
          name: "team-agent",
          assetId: await t.assetId("agent", "team-agent"),
          workspaceId: team
        }
      ]
    ] as const;
    const authorizer = createAuthorizer(t.stores.access);
    // As a turn's call asks them: for the actor, in the chat's workspace.
    const rights = async (user: UserRecord, workspaceId: CollaborationWorkspaceId | null) => {
      const access = await authorizer.forActor(identityOf(user), { workspaceId });
      return resources.map(([action, resource]) => ({
        action,
        name: resource.name,
        allowed: access.authorize(action, resource).allowed
      }));
    };
    const outsideBefore = await rights(reader, team);
    const elsewhere = await rights(reader, null);
    await t.expectOk(creator.id, "conversations.add_person", {
      params: { conversationId: chat },
      payload: { userId: reader.id }
    });
    const inChat = await rights(reader, team);
    // Named: equal to what they hold as a non-member, inside or outside the workspace.
    expect(inChat).toEqual(outsideBefore);
    expect(inChat).toEqual(elsewhere);
    expect(inChat.filter((right) => right.allowed)).toEqual([]);
    // Not vacuous: a member of the team uses what is offered to its members.
    const asMember = await rights(member, team);
    expect(asMember.filter((right) => right.allowed).map((right) => right.name)).toEqual(
      expect.arrayContaining(["team-kb", "offered-kb", "team-crm", "offered-crm"])
    );
    // Nothing of the creator's passes either: the creator's rights are those of a member.
    expect(await rights(creator, team)).toEqual(asMember);

    // An instance agent cannot carry a team's skill (owner reach), so no agent open to the
    // reader names one; the team's skill is not readable to them by its route.
    const carried = await t.call(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "carrier" },
      payload: { config: agent("carrier", { skillNames: ["team-skill"] }) }
    });
    expect(carried.statusCode).toBeGreaterThanOrEqual(400);
    const skill = await t.call(reader.id, "assets.get", {
      params: { kind: "skill", name: "team-skill" },
      query: { workspaceId: team }
    });
    expect(skill.statusCode).toBeGreaterThanOrEqual(400);
  });
});
