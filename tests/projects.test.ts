import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asConversationId,
  asUserId,
  isAppError,
  type CollaborationWorkspaceId,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { withTestSql } from "./support/test-sql";

// PRJ-1: a project is a folder of chat work in one workspace, shared with its members or
// private to its creator. Membership alone reaches it: no instance role, grant or bundle opens
// one. A conversation in a project is read by exactly the project's audience.
// Kai owns the workspace Team, Lena is a member. Mia holds Builder there and is no member.

const projectSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  audience: z.enum(["workspace", "private"]),
  collaborationWorkspaceId: z.string()
});
const projectsSchema = z.object({ items: z.array(projectSchema) });
const conversationSchema = z.looseObject({
  id: z.string(),
  visibility: z.string(),
  projectId: z.string().optional(),
  collaborationWorkspaceId: z.string()
});
const listSchema = z.object({ items: z.array(z.looseObject({ id: z.string() })) });

type Project = z.infer<typeof projectSchema>;

const ON = { projects: { enabled: true } };

describe("projects and who reaches them", () => {
  let t: AccessInstance;
  let mia: UserRecord;
  let team: CollaborationWorkspaceId;
  let other: CollaborationWorkspaceId;
  let shared: Project;
  let kaisPrivate: Project;
  let othersShared: Project;
  let inShared: string;
  let inPrivate: string;

  const createProject = async (
    userId: string,
    workspaceId: string,
    title: string,
    audience?: "workspace" | "private"
  ) =>
    projectSchema.parse(
      (
        await t.expectOk(userId, "projects.create", {
          payload: {
            collaborationWorkspaceId: workspaceId,
            title,
            ...(audience ? { audience } : {})
          }
        })
      ).json()
    );
  const startIn = async (userId: string, project: Project, title = "Chat") => {
    const created = await t.expectOk(userId, "conversations.create", {
      payload: {
        title,
        collaborationWorkspaceId: project.collaborationWorkspaceId,
        projectId: project.id
      }
    });
    const conversation = conversationSchema.parse(created.json());
    // Sent, so that a list shows it.
    await t.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(conversation.id),
      role: "user",
      text: "Hello"
    });
    return conversation;
  };
  const startOutside = async (userId: string, workspaceId: string, visibility?: "private") => {
    const created = await t.expectOk(userId, "conversations.create", {
      payload: {
        title: "Outside",
        collaborationWorkspaceId: workspaceId,
        ...(visibility ? { visibility } : {})
      }
    });
    const conversation = conversationSchema.parse(created.json());
    await t.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(conversation.id),
      role: "user",
      text: "Hello"
    });
    return conversation;
  };
  const listed = async (userId: string, workspaceId: string) =>
    projectsSchema
      .parse(
        (
          await t.expectOk(userId, "projects.list", {
            params: { collaborationWorkspaceId: workspaceId }
          })
        ).json()
      )
      .items.map((project) => project.title);
  const status = async (userId: string, operation: "projects.get", projectName: string) =>
    (await t.call(userId, operation, { params: { projectName } })).statusCode;
  const reads = async (userId: string, conversationId: string) =>
    (await t.call(userId, "conversations.thread.get", { params: { conversationId } }))
      .statusCode === 200;
  const setProject = (
    userId: string,
    conversationId: string,
    projectId: string | null,
    hideFromOthers?: true
  ) =>
    t.call(userId, "conversations.set_project", {
      params: { conversationId },
      payload: { projectId, ...(hideFromOthers ? { hideFromOthers } : {}) }
    });
  const reason = (response: { json(): unknown }) =>
    errorSchema.parse(response.json()).error.details?.reason;

  beforeAll(async () => {
    t = await setupAccessInstance({ modules: ON });
    mia = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Mia",
      roles: ["user"],
      permissions: []
    });
    team = (
      await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Team",
        creatorUserId: t.kai.id
      })
    ).id;
    other = (
      await t.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Other",
        creatorUserId: t.kai.id
      })
    ).id;
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.lena.id),
      role: "member"
    });
    await t.grant(mia.id, "builder", { workspaceId: team });
    shared = await createProject(t.kai.id, team, "Projekt Nord");
    kaisPrivate = await createProject(t.kai.id, team, "Notizen Kai", "private");
    othersShared = await createProject(t.kai.id, other, "Projekt Anderswo");
    inShared = (await startIn(t.kai.id, shared, "Plan")).id;
    inPrivate = (await startIn(t.kai.id, kaisPrivate, "Mine")).id;
  });
  afterAll(async () => {
    await t?.instance.close();
  });

  it("makes the name from the title and takes the workspace's default audience", () => {
    expect(shared.name).toMatch(/^projekt-nord-[a-z0-9]{4}$/u);
    expect(shared.audience).toBe("workspace");
    expect(kaisPrivate.audience).toBe("private");
  });

  it("shows a member the shared project and not another member's private one", async () => {
    expect(await listed(t.kai.id, team)).toEqual(
      expect.arrayContaining(["Projekt Nord", "Notizen Kai"])
    );
    expect(await listed(t.lena.id, team)).toEqual(["Projekt Nord"]);
    expect(await status(t.lena.id, "projects.get", shared.name)).toBe(200);
    // Not by its link either.
    expect(await status(t.lena.id, "projects.get", kaisPrivate.name)).toBe(404);
    expect(await reads(t.lena.id, inShared)).toBe(true);
    expect(await reads(t.lena.id, inPrivate)).toBe(false);
    const page = await t.call(t.lena.id, "conversations.list", {
      query: { collaborationWorkspaceId: team, projectId: kaisPrivate.id }
    });
    expect(page.statusCode).toBe(404);
  });

  it("starts a conversation with the project's audience and lists it on the project", async () => {
    const conversation = await startIn(t.lena.id, shared, "Lena's question");
    expect(conversation).toMatchObject({ projectId: shared.id, visibility: "workspace" });
    expect(await reads(t.kai.id, conversation.id)).toBe(true);
    const inProject = listSchema.parse(
      (
        await t.expectOk(t.kai.id, "conversations.list", {
          query: { collaborationWorkspaceId: team, projectId: shared.id }
        })
      ).json()
    );
    expect(inProject.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([conversation.id, inShared])
    );
    expect(inProject.items.map((item) => item.id)).not.toContain(inPrivate);
    const own = await startIn(t.kai.id, kaisPrivate, "Second");
    expect(own.visibility).toBe("private");
  });

  it("lets nobody start a private chat in a shared project, nor one in a project of another workspace", async () => {
    const privately = await t.call(t.kai.id, "conversations.create", {
      payload: { collaborationWorkspaceId: team, projectId: shared.id, visibility: "private" }
    });
    expect(reason(privately)).toBe("project_conversation_shared");
    const elsewhere = await t.call(t.kai.id, "conversations.create", {
      payload: { collaborationWorkspaceId: team, projectId: othersShared.id }
    });
    expect(elsewhere.statusCode).toBe(404);
    const intoPrivate = await t.call(t.lena.id, "conversations.create", {
      payload: { collaborationWorkspaceId: team, projectId: kaisPrivate.id }
    });
    expect(intoPrivate.statusCode).toBe(404);
  });

  it("shows the superadmin a shared project of a Shared Workspace and never a private one", async () => {
    expect(await listed(t.root.id, team)).toEqual(["Projekt Nord"]);
    expect(await status(t.root.id, "projects.get", shared.name)).toBe(200);
    expect(await status(t.root.id, "projects.get", kaisPrivate.name)).toBe(404);
    expect(await reads(t.root.id, inShared)).toBe(true);
    expect(await reads(t.root.id, inPrivate)).toBe(false);
  });

  it("shows an instance administrator who is no member no project", async () => {
    const list = await t.call(t.admin.id, "projects.list", {
      params: { collaborationWorkspaceId: team }
    });
    expect(list.statusCode).toBe(404);
    expect(await status(t.admin.id, "projects.get", shared.name)).toBe(404);
    expect(await reads(t.admin.id, inShared)).toBe(false);
  });

  it("shows a Builder of the workspace who is no member no project", async () => {
    const list = await t.call(mia.id, "projects.list", {
      params: { collaborationWorkspaceId: team }
    });
    expect(list.statusCode).toBe(404);
    expect(await status(mia.id, "projects.get", shared.name)).toBe(404);
    expect(await reads(mia.id, inShared)).toBe(false);
    const create = await t.call(mia.id, "projects.create", {
      payload: { collaborationWorkspaceId: team, title: "Mine" }
    });
    expect(create.statusCode).toBe(404);
    const start = await t.call(mia.id, "conversations.create", {
      payload: { collaborationWorkspaceId: team, projectId: shared.id }
    });
    expect(start.statusCode).toBe(404);
    const page = await t.call(mia.id, "conversations.list", {
      query: { collaborationWorkspaceId: team, projectId: shared.id }
    });
    expect(page.statusCode).toBe(404);
  });

  it("closes a project to its creator once they are no member, a bundle notwithstanding", async () => {
    const lenas = await createProject(t.lena.id, team, "Notizen Lena", "private");
    const inLenas = await startIn(t.lena.id, lenas, "Mine");
    const outside = await startOutside(t.lena.id, team, "private");
    await t.stores.workspaces.removeMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: asUserId(t.lena.id)
    });
    const row = await t.grant(t.lena.id, "builder", { workspaceId: team });
    try {
      expect(await reads(t.lena.id, outside.id)).toBe(true);
      expect(await reads(t.lena.id, inLenas.id)).toBe(false);
      const list = listSchema.parse(
        (
          await t.expectOk(t.lena.id, "conversations.list", {
            query: { collaborationWorkspaceId: team }
          })
        ).json()
      );
      expect(list.items.map((item) => item.id)).toEqual([outside.id]);
      expect(await status(t.lena.id, "projects.get", lenas.name)).toBe(404);
    } finally {
      await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId: row } });
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: asUserId(t.lena.id),
        role: "member"
      });
    }
    expect(await reads(t.lena.id, inLenas.id)).toBe(true);
  });

  it("answers a conversation whose project is of another workspace as missing", async () => {
    // A row the writers never leave: the check refuses it all the same.
    const stray = await startOutside(t.kai.id, team);
    await withTestSql(
      (sql) => sql`update conversations set project_id = ${othersShared.id} where id = ${stray.id}`
    );
    try {
      expect(await reads(t.lena.id, stray.id)).toBe(false);
    } finally {
      await withTestSql(
        (sql) => sql`update conversations set project_id = null where id = ${stray.id}`
      );
    }
  });

  it("puts the author's conversation into a project with the project's audience and takes it out", async () => {
    const own = await startOutside(t.kai.id, team, "private");
    expect(await reads(t.lena.id, own.id)).toBe(false);
    const moved = conversationSchema.parse((await setProject(t.kai.id, own.id, shared.id)).json());
    expect(moved).toMatchObject({ projectId: shared.id, visibility: "workspace" });
    expect(await reads(t.lena.id, own.id)).toBe(true);
    // Anyone who reads it takes it out; it stays shared.
    const out = conversationSchema.parse((await setProject(t.lena.id, own.id, null)).json());
    expect(out.projectId).toBeUndefined();
    expect(out.visibility).toBe("workspace");

    // The others read it now: into a private project only once the author saw they no
    // longer will (PRJ-6).
    expect(reason(await setProject(t.kai.id, own.id, kaisPrivate.id))).toBe(
      "project_hides_conversation"
    );
    expect(await reads(t.lena.id, own.id)).toBe(true);
    const intoPrivate = conversationSchema.parse(
      (await setProject(t.kai.id, own.id, kaisPrivate.id, true)).json()
    );
    expect(intoPrivate.visibility).toBe("private");
    expect(await reads(t.lena.id, own.id)).toBe(false);
    const left = conversationSchema.parse((await setProject(t.kai.id, own.id, null)).json());
    expect(left.visibility).toBe("private");
  });

  it("refuses a move into a project by anyone but the author", async () => {
    const kais = await startOutside(t.kai.id, team);
    expect(reason(await setProject(t.lena.id, kais.id, shared.id))).toBe("project_author_only");
  });

  it("refuses a project of another workspace and one outside the caller's audience", async () => {
    const lenas = await startOutside(t.lena.id, team);
    expect((await setProject(t.lena.id, lenas.id, kaisPrivate.id)).statusCode).toBe(404);
    const kais = await startOutside(t.kai.id, team);
    expect((await setProject(t.kai.id, kais.id, othersShared.id)).statusCode).toBe(404);
  });

  it("keeps a conversation that must stay private out of a shared project", async () => {
    const personal = await startOutside(t.kai.id, team, "private");
    await t.stores.conversations.markPersonalData({
      clientInstanceId,
      conversationId: asConversationId(personal.id),
      userId: t.kai.id,
      at: new Date().toISOString()
    });
    expect(reason(await setProject(t.kai.id, personal.id, shared.id))).toBe(
      "personal_conversation_private"
    );
    // A private project keeps it private: it may go there.
    expect((await setProject(t.kai.id, personal.id, kaisPrivate.id)).statusCode).toBe(200);

    // A chat that reads a Data Store its person added stays theirs alone (STORE-USE-1).
    const reading = await startOutside(t.kai.id, team, "private");
    const storeAssetId = await t.assetId("agent", "assistant");
    await withTestSql(
      (sql) => sql`
        insert into conversation_data_stores
          (conversation_id, store_asset_id, client_instance_id, added_by_user_id, added_at)
        values (${reading.id}, ${storeAssetId}, ${clientInstanceId}, ${t.kai.id}, now())`
    );
    expect(reason(await setProject(t.kai.id, reading.id, shared.id))).toBe(
      "data_store_conversation_private"
    );
    expect((await setProject(t.kai.id, reading.id, kaisPrivate.id)).statusCode).toBe(200);

    const about = await startOutside(t.kai.id, team, "private");
    await t.stores.conversations.setConversationSubject({
      clientInstanceId,
      conversationId: asConversationId(about.id),
      subject: { kind: "agent", name: "assistant" }
    });
    expect(reason(await setProject(t.kai.id, about.id, shared.id))).toBe(
      "subject_conversation_private"
    );
    const subject = await t.call(t.kai.id, "conversations.create", {
      payload: {
        collaborationWorkspaceId: team,
        projectId: shared.id,
        subject: { kind: "agent", name: "assistant" }
      }
    });
    expect(reason(subject)).toBe("subject_conversation_private");

    const { conversation: preview } = await t.stores.agentTryConversations.open({
      clientInstanceId,
      agentId: await t.assetId("agent", "assistant"),
      collaborationWorkspaceId: team,
      createdByUserId: t.kai.id,
      createdByExternalUserId: t.kai.id,
      title: "Try",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });
    expect(reason(await setProject(t.kai.id, preview.id, kaisPrivate.id))).toBe(
      "preview_conversation_private"
    );
  });

  it("holds a project in the conversation's workspace in the store as well", async () => {
    const kais = await startOutside(t.kai.id, team);
    const store = t.stores.conversations;
    await expect(
      store.setConversationProject({
        clientInstanceId,
        conversationId: asConversationId(kais.id),
        expectedProjectId: null,
        projectId: othersShared.id,
        visibility: "workspace"
      })
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === "NOT_FOUND");
    await expect(
      store.setConversationProject({
        clientInstanceId,
        conversationId: asConversationId(kais.id),
        expectedProjectId: shared.id,
        projectId: null,
        visibility: "workspace"
      })
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === "CONFLICT");
    await expect(
      store.createConversation({
        clientInstanceId,
        collaborationWorkspaceId: team,
        createdByUserId: t.kai.id,
        createdByExternalUserId: t.kai.id,
        visibility: "workspace",
        title: "Stray",
        retainedUntil: new Date(Date.now() + 86_400_000).toISOString(),
        projectId: othersShared.id
      })
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === "NOT_FOUND");
  });

  it("takes a conversation out of its project when it moves to another workspace", async () => {
    const moving = await startIn(t.kai.id, shared, "Moving");
    const moved = conversationSchema.parse(
      (
        await t.expectOk(t.kai.id, "conversations.move", {
          params: { conversationId: moving.id },
          payload: { collaborationWorkspaceId: other }
        })
      ).json()
    );
    expect(moved.projectId).toBeUndefined();
    expect(moved.collaborationWorkspaceId).toBe(other);
  });

  it("keeps every conversation's project in the conversation's workspace", async () => {
    const [row] = await withTestSql(
      (sql) => sql`
        select count(*)::int as stray from conversations c
        join config_assets a on a.id = c.project_id
        where a.scope_id is distinct from c.collaboration_workspace_id`
    );
    expect(row?.stray).toBe(0);
  });

  it("keeps projects out of the asset operations, which see no audience", async () => {
    const read = await t.call(t.lena.id, "assets.get", {
      params: { kind: "project", name: kaisPrivate.name },
      query: { workspaceId: team }
    });
    expect(read.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(read.json())).not.toContain("Notizen Kai");
  });

  it("records the creation by ids and audience only", async () => {
    const [row] = await withTestSql(
      (sql) => sql`
        select metadata from audit_events
        where type = 'project.created' and subject = ${kaisPrivate.id}`
    );
    const { operationRunId: _run, ...metadata } = z
      .looseObject({ operationRunId: z.string().optional() })
      .parse(row?.metadata);
    expect(metadata).toEqual({ workspaceId: team, audience: "private" });
  });
});

describe("projects where the module is off", () => {
  let t: AccessInstance;
  beforeAll(async () => {
    t = await setupAccessInstance();
  });
  afterAll(async () => {
    await t?.instance.close();
  });

  it("creates, lists and starts nothing in a project", async () => {
    const workspaceId = await t.sharedWorkspace("Team");
    const create = await t.call(t.admin.id, "projects.create", {
      payload: { collaborationWorkspaceId: workspaceId, title: "Nord" }
    });
    expect(errorSchema.parse(create.json()).error.details).toMatchObject({ reason: "module_off" });
    const start = await t.call(t.admin.id, "conversations.create", {
      payload: { collaborationWorkspaceId: workspaceId, projectId: "asset_any" }
    });
    expect(errorSchema.parse(start.json()).error.details).toMatchObject({ reason: "module_off" });
    const page = await t.call(t.admin.id, "conversations.list", {
      query: { collaborationWorkspaceId: workspaceId, projectId: "asset_any" }
    });
    expect(errorSchema.parse(page.json()).error.details).toMatchObject({ reason: "module_off" });
  });
});
