import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPlatformAssetCalls } from "@work-shape/catalyst-server";
import {
  asAgentRunId,
  asConversationId,
  asToolCallId,
  asUserId,
  isAgentAvailableInWorkspace,
  isAppError,
  type CollaborationWorkspaceId,
  type ToolExecutionContext,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  skill,
  type AccessInstance
} from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { testServerOptions } from "./support/test-instance";

// A workspace owns the agents and skills made in it (WS-OWN-1a, access acceptance check 33):
// made in a workspace's Studio or through a CLI root bound with `--workspace`, the workspace
// owns them; made with the scope Instance, the instance does. Only an asset of that workspace
// may name what it owns.

const AGENT_RIGHTS = ["agent.read", "agent.write", "agent.delete"];
const SKILL_RIGHTS = ["skill.read", "skill.write", "skill.delete"];

/** Kai is a member of the one workspace and holds the agent and skill rights there, nothing else. */
async function setup() {
  const t = await setupAccessInstance({ furtherToolNames: ["read_skill"] });
  const team = await t.sharedWorkspace("Team");
  const other = await t.sharedWorkspace("Other team");
  await join(t, t.kai, team);
  for (const action of [...AGENT_RIGHTS, ...SKILL_RIGHTS]) {
    await t.grant(t.kai.id, action, { workspaceId: team });
  }
  return { t, team, other };
}

async function join(t: AccessInstance, user: UserRecord, workspaceId: CollaborationWorkspaceId) {
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: workspaceId,
    userId: asUserId(user.id),
    role: "member"
  });
}

/** An agent that reads the named skills. */
const reader = (name: string, skillNames: string[]) =>
  agent(name, { toolNames: ["read_skill"], skillNames });

async function put(
  t: AccessInstance,
  userId: string,
  kind: "agent" | "skill",
  config: { name: string },
  workspaceId?: string
) {
  const response = await t.call(userId, "assets.put", {
    params: { kind, name: config.name },
    payload: {
      config,
      expectedRevision: null,
      ...(workspaceId === undefined ? {} : { workspaceId })
    }
  });
  if (response.statusCode === 200) return { status: 200 };
  const { error } = errorSchema.parse(response.json());
  return { status: response.statusCode, code: error.code, reason: error.details?.reason };
}

const ownerOf = async (t: AccessInstance, kind: string, name: string) =>
  (await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name }))?.scope;

async function offeredIn(t: AccessInstance, name: string, workspaceId: CollaborationWorkspaceId) {
  const workspace = await t.stores.workspaces.getWorkspace(clientInstanceId, workspaceId);
  if (!workspace) throw new Error(`No workspace '${workspaceId}'`);
  const availability = (
    await t.stores.configAssets.listAgentAvailability({ clientInstanceId })
  ).get(name);
  return isAgentAvailableInWorkspace(availability, workspace);
}

const invalidScope = { status: 422, code: "VALIDATION_FAILED", reason: "invalid_scope" };

describe("the owner of an agent or a skill", () => {
  it("is the workspace it is made in, and the instance for one made with the scope Instance", async () => {
    const { t, team, other } = await setup();

    expect(await put(t, t.kai.id, "skill", skill("team-notes"), team)).toEqual({ status: 200 });
    expect(await put(t, t.kai.id, "agent", reader("team-helper", ["team-notes"]), team)).toEqual({
      status: 200
    });
    for (const { kind, name } of [
      { kind: "skill", name: "team-notes" },
      { kind: "agent", name: "team-helper" }
    ]) {
      expect(await ownerOf(t, kind, name), name).toEqual({
        kind: "workspace",
        workspaceId: team
      });
    }
    // Today's rule: offered in the shared workspace it was made in, and nowhere else.
    expect(await offeredIn(t, "team-helper", team)).toBe(true);
    expect(await offeredIn(t, "team-helper", other)).toBe(false);

    // A right in the workspace is no right on the instance, nor in another workspace.
    expect(await put(t, t.kai.id, "agent", agent("kai-own"))).toMatchObject({ status: 403 });
    expect(await put(t, t.kai.id, "agent", agent("kai-own"), other)).toMatchObject({
      status: 403
    });
    // The scope Instance: the administrator's agent is the instance's.
    expect(await put(t, t.admin.id, "agent", agent("house-agent"))).toEqual({ status: 200 });
    expect(await ownerOf(t, "agent", "house-agent")).toEqual({ kind: "instance" });

    // Each owner is its own list.
    const names = async (userId: string, workspaceId?: string) =>
      z
        .object({ items: z.array(z.object({ name: z.string() }).loose()) })
        .parse(
          (
            await t.expectOk(userId, "assets.list", {
              params: { kind: "agent" },
              ...(workspaceId === undefined ? {} : { query: { workspaceId } })
            })
          ).json()
        )
        .items.map((item) => item.name);
    expect(await names(t.kai.id, team)).toEqual(["team-helper"]);
    expect(await names(t.kai.id)).toEqual([]);
    expect(await names(t.admin.id)).toEqual(["assistant", "house-agent"]);
  });

  it("refuses an agent of the instance or of another workspace that names a workspace's skill", async () => {
    const { t, team, other } = await setup();
    expect(await put(t, t.kai.id, "skill", skill("team-notes"), team)).toEqual({ status: 200 });

    // The administrator reads the skill and may write everywhere: still refused, by owner.
    expect(await put(t, t.admin.id, "agent", reader("outside", ["team-notes"]))).toEqual(
      invalidScope
    );
    expect(await put(t, t.admin.id, "agent", reader("outside", ["team-notes"]), other)).toEqual(
      invalidScope
    );
    // So is a batch bound to the other workspace.
    const batch = await t.call(t.admin.id, "assets.sync", {
      payload: {
        workspaceId: other,
        items: [
          {
            type: "put",
            kind: "agent",
            config: reader("outside", ["team-notes"]),
            expectedRevision: null
          }
        ]
      }
    });
    expect(batch.statusCode).toBe(422);
    expect(errorSchema.parse(batch.json()).error.details).toMatchObject({
      reason: "invalid_scope"
    });
    // An agent of the workspace itself names it.
    expect(await put(t, t.kai.id, "agent", reader("team-helper", ["team-notes"]), team)).toEqual({
      status: 200
    });
    expect(await ownerOf(t, "agent", "outside")).toBeUndefined();
  });

  it("lets a workspace's agent name an instance skill only where its writer reads that skill", async () => {
    const { t, team } = await setup();
    expect(await put(t, t.admin.id, "skill", skill("handbook"))).toEqual({ status: 200 });

    // Kai does not read the instance's skill: it is a reference to nothing for him.
    const refused = await t.call(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "team-helper" },
      payload: {
        config: reader("team-helper", ["handbook"]),
        expectedRevision: null,
        workspaceId: team
      }
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain("Agent 'team-helper' references missing skill 'handbook'");

    await t.grant(t.kai.id, "skill.read", { assetId: await t.assetId("skill", "handbook") });
    expect(await put(t, t.kai.id, "agent", reader("team-helper", ["handbook"]), team)).toEqual({
      status: 200
    });
  });

  it("is the bound workspace for a batch, whose agents start hidden, and never a Namespace beside it", async () => {
    const { t, team } = await setup();
    await t.createNamespace("kai-");
    const sync = (payload: Record<string, unknown>) => t.call(t.kai.id, "assets.sync", { payload });
    const items = [
      { type: "put", kind: "skill", config: skill("team-notes"), expectedRevision: null },
      {
        type: "put",
        kind: "agent",
        config: reader("team-pushed", ["team-notes"]),
        expectedRevision: null
      }
    ];

    const both = await sync({ namespace: "kai-", workspaceId: team, items });
    expect(both.statusCode).toBe(422);
    expect(errorSchema.parse(both.json()).error.message).toBe(
      "A batch names a Namespace or a workspace, not both"
    );

    const applied = await sync({ workspaceId: team, items });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(await ownerOf(t, "agent", "team-pushed")).toEqual({
      kind: "workspace",
      workspaceId: team
    });
    expect(await ownerOf(t, "skill", "team-notes")).toEqual({
      kind: "workspace",
      workspaceId: team
    });
    // A push is made in no workspace: hidden until an instance admin widens it.
    expect(await offeredIn(t, "team-pushed", team)).toBe(false);

    // A batch bound to the workspace deletes what the workspace owns.
    const deleted = await sync({
      workspaceId: team,
      items: [{ type: "delete", kind: "agent", name: "team-pushed", expectedRevision: 1 }]
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(
      (
        await t.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "agent",
          name: "team-pushed"
        })
      )?.status
    ).not.toBe("active");
  });

  it("is deleted with its workspace", async () => {
    const { t, team } = await setup();
    expect(await put(t, t.kai.id, "skill", skill("team-notes"), team)).toEqual({ status: 200 });
    expect(await put(t, t.kai.id, "agent", reader("team-helper", ["team-notes"]), team)).toEqual({
      status: 200
    });
    expect(await put(t, t.admin.id, "skill", skill("handbook"))).toEqual({ status: 200 });

    await t.stores.workspaces.deleteWorkspace({ clientInstanceId, collaborationWorkspaceId: team });

    expect(await ownerOf(t, "agent", "team-helper")).toBeUndefined();
    expect(await ownerOf(t, "skill", "team-notes")).toBeUndefined();
    expect(
      (await t.stores.configAssets.listAgentAvailability({ clientInstanceId })).get("team-helper")
    ).toBeUndefined();
    expect(await ownerOf(t, "skill", "handbook")).toEqual({ kind: "instance" });
  });
});

describe("the instance default and a workspace's agent", () => {
  const ownedByWorkspace = {
    status: 422,
    code: "VALIDATION_FAILED",
    reason: "default_owned_by_workspace"
  };
  const defaultOf = async (t: AccessInstance) =>
    (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).defaultAgentName;

  it("never makes a workspace's agent the default, and refuses one as an instance's first agent", async () => {
    const { t, team } = await setup();
    // An instance without agents: its first one is its default, so a workspace's is refused.
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        { type: "setDefaultAgent", agentName: undefined },
        { type: "delete", kind: "agent", name: "assistant" }
      ]
    });
    expect(await put(t, t.admin.id, "agent", agent("team-first"), team)).toEqual(ownedByWorkspace);
    expect(await ownerOf(t, "agent", "team-first")).toBeUndefined();
    expect(await put(t, t.admin.id, "agent", agent("house-first"))).toEqual({ status: 200 });
    expect(await defaultOf(t)).toBe("house-first");
    expect(await put(t, t.kai.id, "agent", agent("team-first"), team)).toEqual({ status: 200 });
    expect(await defaultOf(t)).toBe("house-first");

    // Offered everywhere by the administrator, it is still no default.
    await t.expectOk(t.admin.id, "assets.set_availability", {
      params: { kind: "agent", name: "team-first" },
      payload: { mode: "all" }
    });
    const named = await t.call(t.admin.id, "assets.set_default", {
      params: { kind: "agent" },
      payload: { name: "team-first" }
    });
    expect(named.statusCode).toBe(422);
    expect(errorSchema.parse(named.json()).error.details?.reason).toBe(
      "default_owned_by_workspace"
    );
    expect(await defaultOf(t)).toBe("house-first");
  });

  it("offers a new workspace agent in another workspace only for an instance admin", async () => {
    const { t, team, other } = await setup();
    await join(t, t.kai, other);
    const putOfferedIn = (userId: string, name: string, workspaceId: string) =>
      t.call(userId, "assets.put", {
        params: { kind: "agent", name },
        payload: {
          config: agent(name),
          expectedRevision: null,
          workspaceId: team,
          availableIn: { workspaceId }
        }
      });
    expect((await putOfferedIn(t.kai.id, "kai-helper", other)).statusCode).toBe(403);
    expect(await ownerOf(t, "agent", "kai-helper")).toBeUndefined();
    // Its own workspace, named or not, is the builder's to offer it in.
    expect((await putOfferedIn(t.kai.id, "kai-helper", team)).statusCode).toBe(200);
    expect(await offeredIn(t, "kai-helper", team)).toBe(true);

    expect((await putOfferedIn(t.admin.id, "admin-helper", other)).statusCode).toBe(200);
    expect(await offeredIn(t, "admin-helper", other)).toBe(true);
    expect(await offeredIn(t, "admin-helper", team)).toBe(false);
  });
});

describe("a Build conversation about a workspace's agent", () => {
  it("reads the workspace's agents with the builder's right in that workspace", async () => {
    const { t, team, other } = await setup();
    const lenaRights = [...AGENT_RIGHTS, ...SKILL_RIGHTS];
    await join(t, t.lena, other);
    for (const action of lenaRights) await t.grant(t.lena.id, action, { workspaceId: other });
    expect(await put(t, t.kai.id, "agent", agent("team-helper"), team)).toEqual({ status: 200 });
    expect(await put(t, t.kai.id, "agent", agent("team-second"), team)).toEqual({ status: 200 });
    expect(await put(t, t.lena.id, "agent", agent("other-agent"), other)).toEqual({ status: 200 });

    const started = await t.expectOk(t.kai.id, "conversations.create", {
      payload: { collaborationWorkspaceId: team, subject: { kind: "agent", name: "team-helper" } }
    });
    const conversationId = z.object({ id: z.string() }).parse(started.json()).id;

    await t.instance.call("health.get");
    const options = testServerOptions(t.instance);
    if (!options) throw new Error("The instance has no server options");
    const calls = createPlatformAssetCalls(options);
    const context: ToolExecutionContext = {
      user: {
        id: t.kai.id,
        externalUserId: t.kai.id,
        displayLabel: t.kai.displayLabel,
        roles: t.kai.roles,
        permissions: t.kai.permissions,
        permissionRefs: t.kai.permissionRefs,
        clientInstanceId,
        authSource: "test"
      },
      clientInstanceId,
      correlationId: `corr_${randomUUID()}`,
      toolRequest: {
        toolName: "platform.assets.get",
        toolCallId: asToolCallId(`call_${randomUUID()}`),
        agentRunId: asAgentRunId(`run_${randomUUID()}`),
        conversationId: asConversationId(conversationId),
        agentName: "assistant",
        input: {}
      }
    };

    expect((await calls.get(context)).name).toBe("team-helper");
    expect((await calls.get(context, { kind: "agent", name: "team-second" })).name).toBe(
      "team-second"
    );
    // Another workspace's agent is answered as one that does not exist.
    const refusal = async (name: string) => {
      try {
        await calls.get(context, { kind: "agent", name });
      } catch (error) {
        return isAppError(error) ? { code: error.code, details: error.details } : error;
      }
      return "read";
    };
    expect(await refusal("other-agent")).toEqual(await refusal("nobody-agent"));
    expect(await refusal("other-agent")).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the agent's first save of a conversation (NAV-2)", () => {
  /** What a platform tool of Kai's conversation is called with. */
  function kaiContext(t: AccessInstance, conversationId: string): ToolExecutionContext {
    return {
      user: {
        id: t.kai.id,
        externalUserId: t.kai.id,
        displayLabel: t.kai.displayLabel,
        roles: t.kai.roles,
        permissions: t.kai.permissions,
        permissionRefs: t.kai.permissionRefs,
        clientInstanceId,
        authSource: "test"
      },
      clientInstanceId,
      correlationId: `corr_${randomUUID()}`,
      toolRequest: {
        toolName: "platform.assets.put",
        toolCallId: asToolCallId(`call_${randomUUID()}`),
        agentRunId: asAgentRunId(`run_${randomUUID()}`),
        conversationId: asConversationId(conversationId),
        agentName: "assistant",
        input: {}
      }
    };
  }

  async function ownConversation(t: AccessInstance, workspaceId: CollaborationWorkspaceId) {
    // The person's own conversation: a first save creates nothing in one its members read. The
    // workspace starts its conversations private.
    await t.expectOk(t.admin.id, "workspaces.update", {
      params: { collaborationWorkspaceId: workspaceId },
      payload: { defaultConversationVisibility: "private" }
    });
    const started = await t.expectOk(t.kai.id, "conversations.create", {
      payload: { collaborationWorkspaceId: workspaceId }
    });
    return z.object({ id: z.string() }).parse(started.json()).id;
  }

  async function subjectOf(t: AccessInstance, conversationId: string) {
    const conversation = await t.stores.conversations.getConversation(
      clientInstanceId,
      asConversationId(conversationId)
    );
    return conversation?.subject;
  }

  async function callsOf(t: AccessInstance) {
    await t.instance.call("health.get");
    const options = testServerOptions(t.instance);
    if (!options) throw new Error("The instance has no server options");
    return createPlatformAssetCalls(options);
  }

  it("creates an agent and a skill its workspace owns, offers the agent nowhere and records the person", async () => {
    const { t, team } = await setup();
    const calls = await callsOf(t);

    const forAgent = await ownConversation(t, team);
    const created = await calls.put(kaiContext(t, forAgent), {
      kind: "agent",
      name: "built-helper",
      config: agent("built-helper", { displayName: "Built helper" })
    });
    expect(created).toEqual({
      saved: true,
      revision: 1,
      created: true,
      kind: "agent",
      name: "built-helper",
      title: "Built helper",
      // The answer names the owner, so the page it opens reads the agent there.
      workspaceId: team
    });
    expect(await ownerOf(t, "agent", "built-helper")).toEqual({
      kind: "workspace",
      workspaceId: team
    });
    expect(await subjectOf(t, forAgent)).toEqual({ kind: "agent", name: "built-helper" });
    // Offered nowhere: not in its own workspace either, until a person places it.
    expect(await offeredIn(t, "built-helper", team)).toBe(false);
    // The person of the conversation made it, as a save through the API records.
    const audited = await t.stores.audit.listAuditEvents({ clientInstanceId });
    const made = audited.find(
      (event) => event.type === "config_asset.updated" && event.metadata?.name === "built-helper"
    );
    expect(made?.actor?.userId).toBe(t.kai.id);

    // A conversation that is about an asset creates the next one beside it (BUILD-ALL-1): the
    // workspace owns it too, and the conversation stays about the agent.
    expect(
      await calls.put(kaiContext(t, forAgent), {
        kind: "skill",
        name: "second-notes",
        config: skill("second-notes")
      })
    ).toMatchObject({ saved: true, created: true, kind: "skill", besideSubject: true });
    expect(await ownerOf(t, "skill", "second-notes")).toEqual({
      kind: "workspace",
      workspaceId: team
    });
    expect(await subjectOf(t, forAgent)).toEqual({ kind: "agent", name: "built-helper" });
    // A save naming the created skill asks the guardrails about the skill, and a save naming
    // nothing about the subject.
    const [skillEvent] = await calls.putBeforeEvents(asConversationId(forAgent), {
      kind: "skill",
      name: "second-notes",
      config: skill("second-notes"),
      expectedRevision: 1
    });
    expect(skillEvent).toMatchObject({ subject: { kind: "skill", name: "second-notes" } });
    const [subjectEvent] = await calls.putBeforeEvents(asConversationId(forAgent), {
      config: agent("built-helper"),
      expectedRevision: 1
    });
    expect(subjectEvent).toMatchObject({ subject: { kind: "agent", name: "built-helper" } });

    const forSkill = await ownConversation(t, team);
    expect(
      await calls.put(kaiContext(t, forSkill), {
        kind: "skill",
        name: "built-notes",
        config: skill("built-notes")
      })
    ).toMatchObject({ saved: true, created: true, kind: "skill", name: "built-notes" });
    expect(await ownerOf(t, "skill", "built-notes")).toEqual({
      kind: "workspace",
      workspaceId: team
    });
  });

  it("names the agent it created and opened in the language of the run", async () => {
    // ACCEPT-1c C8: a German run's line said "Agent „Leave Reviewer“ erstellt".
    const { t, team } = await setup();
    const calls = await callsOf(t);
    const conversation = await ownConversation(t, team);
    const german = { ...kaiContext(t, conversation), locale: "de" as const };
    const displayName = { en: "Leave reviewer", de: "Urlaubsprüfer" };
    expect(
      await calls.put(german, {
        kind: "agent",
        name: "leave-reviewer",
        config: agent("leave-reviewer", { displayName })
      })
    ).toMatchObject({ created: true, title: "Urlaubsprüfer" });
    expect(await calls.open(german, { kind: "agent", name: "leave-reviewer" })).toMatchObject({
      title: "Urlaubsprüfer"
    });
  });

  it("is refused where the person may not write, as the API refuses the same put", async () => {
    const { t, other } = await setup();
    await join(t, t.kai, other);
    const calls = await callsOf(t);
    const conversationId = await ownConversation(t, other);

    const throughApi = await put(t, t.kai.id, "agent", agent("kai-elsewhere"), other);
    expect(throughApi).toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(
      calls.put(kaiContext(t, conversationId), {
        kind: "agent",
        name: "kai-elsewhere",
        config: agent("kai-elsewhere")
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await ownerOf(t, "agent", "kai-elsewhere")).toBeUndefined();
    expect(await subjectOf(t, conversationId)).toBeUndefined();

    // A save that names no kind it may create, or no name, creates nothing.
    for (const input of [{ kind: "agent" }, { kind: "connection", name: "nope" }]) {
      await expect(calls.put(kaiContext(t, conversationId), input)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        details: { reason: "create_unnamed" }
      });
    }
  });
});
