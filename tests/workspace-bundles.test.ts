import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { asConversationId, type CollaborationWorkspaceId } from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  skill,
  type AccessInstance
} from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";

// WS-BUILD-1: Builder and Publisher in a workspace, one row each, held without membership
// (access acceptance checks 10 and 24). Lena is no member of the workspace Sales; Kai is.

const conversationSchema = z.looseObject({ id: z.string(), visibility: z.string() });
const listSchema = z.object({ items: z.array(z.looseObject({ id: z.string() })) });
const revisionSchema = z.object({ revision: z.number() });

describe("a Builder and Publisher who is no member of the workspace", () => {
  let t: AppInstance;
  let other: CollaborationWorkspaceId;
  let membersConversation: string;
  beforeAll(async () => {
    t = await setupAppInstance();
    other = await t.sharedWorkspace("Other");
    const created = await t.expectOk(t.kai.id, "conversations.create", {
      payload: { title: "Team talk", collaborationWorkspaceId: t.workspaceId }
    });
    membersConversation = conversationSchema.parse(created.json()).id;
    // Sent, so that a member's list shows it: the one the builder must not see.
    await t.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(membersConversation),
      role: "user",
      text: "For the team"
    });
    expectStatus(await putApp(t.admin.id, "offers", t.workspaceId), 200);
    expectStatus(await putApp(t.admin.id, "offers-other", other), 200);
  });
  afterAll(async () => {
    await t.close();
  });

  const putAgent = (name: string, workspaceId?: string) =>
    t.call(t.lena.id, "assets.put", {
      params: { kind: "agent", name },
      payload: {
        config: agent(name),
        expectedRevision: null,
        ...(workspaceId === undefined ? {} : { workspaceId })
      }
    });
  function putApp(userId: string, name: string, workspaceId: string) {
    return t.call(userId, "assets.put", {
      params: { kind: "app", name },
      payload: { files: appFiles(name, { name: "Offers" }), workspaceId }
    });
  }
  const publishApp = async (name: string, workspaceId: string) => {
    const read = await t.expectOk(t.admin.id, "assets.get", {
      params: { kind: "app", name },
      query: { workspaceId }
    });
    const { revision } = revisionSchema.parse(read.json());
    return t.call(t.lena.id, "assets.publish", {
      params: { kind: "app", name },
      payload: { revision, workspaceId }
    });
  };
  const listConversations = (workspaceId: string) =>
    t.call(t.lena.id, "conversations.list", { query: { collaborationWorkspaceId: workspaceId } });
  const readMessages = (conversationId: string) =>
    t.call(t.lena.id, "conversations.messages.list", { params: { conversationId } });
  const refusal = (response: { json(): unknown }) =>
    errorSchema.parse(response.json()).error.details;

  let builderRow: string;
  let publisherRow: string;
  let ownConversation: string;

  it("builds in the workspace and nowhere else", async () => {
    expect(refusal(await putAgent("lena-helper", t.workspaceId))).toMatchObject({
      action: "agent.write"
    });
    builderRow = await t.grant(t.lena.id, "builder", { workspaceId: t.workspaceId });

    expectStatus(await putAgent("lena-helper", t.workspaceId), 200);
    expectStatus(await putApp(t.lena.id, "offers", t.workspaceId), 200);
    expect(refusal(await putAgent("lena-elsewhere", other))).toMatchObject({
      action: "agent.write"
    });
    expect(refusal(await putAgent("lena-instance"))).toMatchObject({ action: "agent.write" });
    expect(refusal(await putApp(t.lena.id, "offers-other", other))).toMatchObject({
      action: "app.write"
    });
    // Builder carries no delete and no publish.
    const read = await t.expectOk(t.lena.id, "assets.get", {
      params: { kind: "agent", name: "lena-helper" },
      query: { workspaceId: t.workspaceId }
    });
    const deleted = await t.call(t.lena.id, "assets.delete", {
      params: { kind: "agent", name: "lena-helper" },
      payload: {
        expectedRevision: revisionSchema.parse(read.json()).revision,
        workspaceId: t.workspaceId
      }
    });
    expect(refusal(deleted)).toMatchObject({ action: "agent.delete" });
    expect(refusal(await publishApp("offers", t.workspaceId))).toMatchObject({
      action: "app.publish"
    });
  });

  it("works there in private conversations of its own and sees no member's", async () => {
    const empty = await t.expectOk(t.lena.id, "conversations.list", {
      query: { collaborationWorkspaceId: t.workspaceId }
    });
    expect(listSchema.parse(empty.json()).items).toEqual([]);
    expect((await readMessages(membersConversation)).statusCode).toBe(404);

    const created = await t.expectOk(t.lena.id, "conversations.create", {
      payload: { title: "Build", collaborationWorkspaceId: t.workspaceId }
    });
    const conversation = conversationSchema.parse(created.json());
    ownConversation = conversation.id;
    // The workspace shares new conversations by default; a non-member's stays its own.
    expect(conversation.visibility).toBe("private");
    expectStatus(await readMessages(ownConversation), 200);
    await t.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(ownConversation),
      role: "user",
      text: "Build an agent"
    });
    const listed = await listConversations(t.workspaceId);
    expect(listSchema.parse(listed.json()).items.map((item) => item.id)).toEqual([ownConversation]);

    // Kai, a member, does not see it.
    const kaisList = await t.expectOk(t.kai.id, "conversations.list", {
      query: { collaborationWorkspaceId: t.workspaceId }
    });
    expect(listSchema.parse(kaisList.json()).items.map((item) => item.id)).toEqual([
      membersConversation
    ]);
    // Nothing opens in a workspace it holds no bundle in.
    const elsewhere = await t.call(t.lena.id, "conversations.create", {
      payload: { title: "Build", collaborationWorkspaceId: other }
    });
    expect(elsewhere.statusCode).toBe(404);
    expect((await listConversations(other)).statusCode).toBe(404);
  });

  it("publishes the workspace's assets as a Publisher, and nowhere else", async () => {
    publisherRow = await t.grant(t.lena.id, "publisher", { workspaceId: t.workspaceId });
    expectStatus(await publishApp("offers", t.workspaceId), 200);
    expect(refusal(await publishApp("offers-other", other))).toMatchObject({
      action: "app.publish"
    });
  });

  it("loses the building and the conversations at once when the right is revoked", async () => {
    // Publisher alone still opens the workspace; take both away.
    for (const grantId of [builderRow, publisherRow]) {
      await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId } });
    }
    expect(refusal(await putAgent("lena-helper-2", t.workspaceId))).toMatchObject({
      action: "agent.write"
    });
    expect((await readMessages(ownConversation)).statusCode).toBe(404);
    expect((await listConversations(t.workspaceId)).statusCode).toBe(404);
  });
});

describe("the build limits of a workspace", () => {
  let t: AccessInstance;
  let team: CollaborationWorkspaceId;
  beforeAll(async () => {
    t = await setupAccessInstance();
    team = await t.sharedWorkspace("Kai Spezis");
    await t.grant(t.kai.id, "builder", { workspaceId: team });
  });
  afterAll(async () => {
    await t.instance.close();
  });

  const setLimits = (userId: string, body: Record<string, unknown>) =>
    t.call(userId, "workspaces.limits.update", {
      params: { collaborationWorkspaceId: team },
      payload: body
    });
  const put = (userId: string, name: string, overrides: Record<string, unknown>) =>
    t.call(userId, "assets.put", {
      params: { kind: "agent", name },
      payload: { config: agent(name, overrides), expectedRevision: null, workspaceId: team }
    });

  it("are set by an instance admin alone, with known entries, as an audit event", async () => {
    const limits = { allowedToolNames: ["known.tool"], allowedModelBindingIds: ["plain"] };
    expect((await setLimits(t.kai.id, limits)).statusCode).toBe(403);
    expect(refusalOf(await setLimits(t.admin.id, { allowedToolNames: ["nope.tool"] }))).toEqual({
      reason: "unknown_tool",
      toolName: "nope.tool"
    });
    const set = await t.expectOk(t.admin.id, "workspaces.limits.update", {
      params: { collaborationWorkspaceId: team },
      payload: limits
    });
    expect(set.json()).toEqual({ id: team, name: "Kai Spezis", ...limits });
    const listed = await t.expectOk(t.admin.id, "workspaces.limits.list");
    expect(listSchema.parse(listed.json()).items.filter((item) => item.id === team)).toEqual([
      { id: team, name: "Kai Spezis", ...limits }
    ]);
    const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
    expect(
      events.filter(
        (event) => event.type === "collaboration_workspace.updated" && event.subject === team
      )
    ).toEqual([
      expect.objectContaining({
        metadata: {
          changedFields: ["allowedToolNames", "allowedModelBindingIds"],
          restrictsTools: true,
          restrictsModels: true
        }
      })
    ]);
  });

  it("stay out of what the workspace's members are answered", async () => {
    const shown = await t.expectOk(t.root.id, "workspaces.get", {
      params: { collaborationWorkspaceId: team }
    });
    expect(shown.json()).toMatchObject({ id: team, name: "Kai Spezis" });
    expect(shown.json()).not.toHaveProperty("allowedToolNames");
    expect(shown.json()).not.toHaveProperty("allowedModelBindingIds");
  });

  it("refuse every writer an agent of the workspace outside them, naming the list", async () => {
    const named = { workspaceId: team, workspace: "Kai Spezis" };
    // Choosing a model is the instance admin's right; the Builder is held to the tools.
    const builders = await put(t.kai.id, "kai-tool", { toolNames: ["second.tool"] });
    expect([builders.statusCode, refusalOf(builders)]).toEqual([
      403,
      { reason: "tool_not_allowed", toolName: "second.tool", ...named }
    ]);
    const tool = await put(t.admin.id, "admin-tool", { toolNames: ["second.tool"] });
    expect([tool.statusCode, refusalOf(tool)]).toEqual([
      403,
      { reason: "tool_not_allowed", toolName: "second.tool", ...named }
    ]);
    // Who manages models, a superadmin here, is held to the model list.
    const model = await put(t.root.id, "root-model", {
      modelProviderId: undefined,
      modelBindingId: "other"
    });
    expect([model.statusCode, refusalOf(model)]).toEqual([
      403,
      {
        reason: "model_not_allowed",
        modelBindingId: "other",
        allowedModelBindingIds: ["plain"],
        ...named
      }
    ]);
    expectStatus(
      await put(t.root.id, "within", {
        toolNames: ["known.tool"],
        modelProviderId: undefined,
        modelBindingId: "plain"
      }),
      200
    );
    // The model list is the operator's choice: a Builder picks among it without the right to
    // manage models, and is refused outside it naming the list.
    const pick = (name: string, modelBindingId: string) =>
      put(t.kai.id, name, { modelProviderId: undefined, modelBindingId });
    expectStatus(await pick("kai-listed-model", "plain"), 200);
    const unlisted = await pick("kai-unlisted-model", "other");
    expect([unlisted.statusCode, refusalOf(unlisted)]).toEqual([
      403,
      {
        reason: "model_not_allowed",
        modelBindingId: "other",
        allowedModelBindingIds: ["plain"],
        ...named
      }
    ]);
    // An agent of the instance is not bound by the workspace's lists.
    expectStatus(await t.putAgent(t.admin.id, "house", { toolNames: ["second.tool"] }), 200);
  });

  it("add no limit once lifted", async () => {
    await t.expectOk(t.admin.id, "workspaces.limits.update", {
      params: { collaborationWorkspaceId: team },
      payload: { allowedToolNames: null, allowedModelBindingIds: null }
    });
    expectStatus(await put(t.kai.id, "lifted", { toolNames: ["second.tool"] }), 200);
  });
});
describe("a Publisher deleting the workspace's skills (SKILL-DEL-1)", () => {
  let t: AccessInstance;
  let team: CollaborationWorkspaceId;
  let other: CollaborationWorkspaceId;
  beforeAll(async () => {
    t = await setupAccessInstance({ furtherToolNames: ["read_skill"] });
    team = await t.sharedWorkspace("Team");
    other = await t.sharedWorkspace("Other");
    await t.grant(t.kai.id, "builder", { workspaceId: team });
    for (const name of ["guide", "spare"]) expectStatus(await putSkill(name, team), 200);
    expectStatus(await putSkill("elsewhere", other), 200);
    const uses = { toolNames: ["read_skill"], skillNames: ["guide"] };
    expectStatus(await putTeamAgent("live-user", uses), 200);
    // A second write of an agent that is there goes to its draft, which also keeps the skill.
    expectStatus(await putTeamAgent("draft-user"), 200);
    const read = await t.expectOk(t.admin.id, "assets.get", {
      params: { kind: "agent", name: "draft-user" },
      query: { workspaceId: team }
    });
    expectStatus(
      await putTeamAgent("draft-user", uses, revisionSchema.parse(read.json()).revision),
      200
    );
    // An agent whose draft no longer lists the skill still serves it live.
    expectStatus(await putTeamAgent("live-only", uses), 200);
    const liveOnly = await t.expectOk(t.admin.id, "assets.get", {
      params: { kind: "agent", name: "live-only" },
      query: { workspaceId: team }
    });
    expectStatus(
      await putTeamAgent("live-only", {}, revisionSchema.parse(liveOnly.json()).revision),
      200
    );
  });
  afterAll(async () => {
    await t.instance.close();
  });

  function putSkill(name: string, workspaceId: string) {
    return t.call(t.admin.id, "assets.put", {
      params: { kind: "skill", name },
      payload: { config: skill(name), expectedRevision: null, workspaceId }
    });
  }
  function putTeamAgent(name: string, overrides: Record<string, unknown> = {}, revision?: number) {
    return t.call(t.admin.id, "assets.put", {
      params: { kind: "agent", name },
      payload: {
        config: agent(name, overrides),
        expectedRevision: revision ?? null,
        workspaceId: team
      }
    });
  }
  async function deleteSkill(name: string, workspaceId: string) {
    const read = await t.expectOk(t.admin.id, "assets.get", {
      params: { kind: "skill", name },
      query: { workspaceId }
    });
    return t.call(t.kai.id, "assets.delete", {
      params: { kind: "skill", name },
      payload: { expectedRevision: revisionSchema.parse(read.json()).revision, workspaceId }
    });
  }

  function readSkill(name: string) {
    return t.expectOk(t.kai.id, "assets.get", {
      params: { kind: "skill", name },
      query: { workspaceId: team }
    });
  }

  it("is no Builder's: Builder alone deletes no skill", async () => {
    // Who may not delete the skill is not told which agents keep it.
    expect((await readSkill("guide")).json()).not.toHaveProperty("listedBy");
    const refused = await deleteSkill("spare", team);
    expect([refused.statusCode, refusalOf(refused)]).toEqual([
      403,
      expect.objectContaining({ action: "skill.delete" })
    ]);
  });

  it("deletes a skill no agent lists, keeping its revisions, in its own workspace only", async () => {
    await t.grant(t.kai.id, "publisher", { workspaceId: team });
    expectStatus(await deleteSkill("spare", team), 200);
    const stored = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name: "spare"
    });
    expect(stored).toMatchObject({ status: "deleted", revision: 2 });
    const revisions = await t.expectOk(t.admin.id, "assets.revisions.list", {
      params: { kind: "skill", name: "spare" },
      query: { workspaceId: team }
    });
    expect(z.object({ items: z.array(z.unknown()) }).parse(revisions.json()).items).toHaveLength(2);
    const outside = await deleteSkill("elsewhere", other);
    expect(refusalOf(outside)).toMatchObject({ action: "skill.delete" });
    // The bundle deletes nothing else of the workspace.
    const read = await t.expectOk(t.admin.id, "assets.get", {
      params: { kind: "agent", name: "live-user" },
      query: { workspaceId: team }
    });
    const agentDelete = await t.call(t.kai.id, "assets.delete", {
      params: { kind: "agent", name: "live-user" },
      payload: { expectedRevision: revisionSchema.parse(read.json()).revision, workspaceId: team }
    });
    expect(refusalOf(agentDelete)).toMatchObject({ action: "agent.delete" });
  });

  it("refuses while an agent lists the skill, live or in its draft, naming the agents", async () => {
    const refused = await deleteSkill("guide", team);
    expect(refused.statusCode).toBe(409);
    const { error } = errorSchema.parse(refused.json());
    expect(error.details).toEqual({
      reason: "skill_in_use",
      agents: ["draft-user", "live-only", "live-user"]
    });
    expect(error.message).toBe(
      "The skill 'guide' is used by the agents 'draft-user', 'live-only', 'live-user'. Take it off those agents first, then delete it"
    );
    expect(
      await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "skill", name: "guide" })
    ).toMatchObject({ status: "active" });
  });

  it("tells who may delete the skill which agents keep it, before the delete", async () => {
    const read = (await readSkill("guide")).json();
    expect(read).toMatchObject({
      listedBy: ["draft-user", "live-only", "live-user"].map((name) =>
        expect.objectContaining({ name, title: expect.any(String) })
      )
    });
    expect(read).not.toHaveProperty("listedByUnread");
  });
});

function refusalOf(response: { json(): unknown }) {
  return errorSchema.parse(response.json()).error.details;
}
