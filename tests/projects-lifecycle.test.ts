import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asConversationId,
  asUserId,
  isAppError,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type Conversation
} from "@work-shape/catalyst-core";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { ConversationRetentionWorkflow } from "@work-shape/catalyst-server";
import { arrangeDeletion } from "./support/deletion-fixture";
import { createMultipartFilePayload } from "./support/chat-server-attachment-harness";
import { settled, waitUntilBlocked } from "./support/postgres-concurrency-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { RecordingByteStore } from "./support/retention-harness";

// PRJ-6: a whole project. Its creator shares it or makes it private, and its chats follow; a
// member of both workspaces moves it with its chats and files, and its grants end; a deletion
// claims the project first, then removes its files with their versions and bytes, and keeps or
// deletes its chats as the person chose. With `retention.projectIdleDays` an idle project is
// noticed seven days before the retention job deletes it.

const projectSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  audience: z.enum(["workspace", "private"]),
  collaborationWorkspaceId: z.string()
});
const conversationSchema = z.looseObject({
  id: z.string(),
  visibility: z.string(),
  projectId: z.string().optional(),
  collaborationWorkspaceId: z.string()
});
const errorSchema = z.object({
  error: z.object({ code: z.string(), details: z.looseObject({}).optional() })
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function arrange(db: ReturnType<typeof usePostgresSuite>, label: string) {
  const probe = await arrangeDeletion(db, `${label}probe`);
  const config = {
    ...probe.options.config,
    modules: { ...probe.options.config.modules, projects: { enabled: true } }
  };
  await probe.api.close();
  const modules = resolveInstanceModules(config, []).snapshot;
  // The instance's `files` store, where project files live.
  const objects = new RecordingByteStore();
  const t = await arrangeDeletion(db, label, {
    config,
    modules,
    pages: { objects },
    operationCalls: undefined
  });
  const call = (
    user: AuthenticatedUser,
    operation: Parameters<typeof t.api.call>[0],
    input: Parameters<typeof t.api.call>[1]
  ) => t.api.call(operation, input, user.id);
  const ok = async (
    user: AuthenticatedUser,
    operation: Parameters<typeof t.api.call>[0],
    input: Parameters<typeof t.api.call>[1]
  ) => {
    const response = await call(user, operation, input);
    expect(response.json()).not.toHaveProperty("error");
    return response.json();
  };
  const reasonOf = (response: { json(): unknown }) =>
    errorSchema.parse(response.json()).error.details?.reason;
  const project = async (
    user: AuthenticatedUser,
    workspaceId: string,
    title: string,
    audience?: "workspace" | "private"
  ) =>
    projectSchema.parse(
      await ok(user, "projects.create", {
        payload: { collaborationWorkspaceId: workspaceId, title, ...(audience ? { audience } : {}) }
      })
    );
  const chatIn = async (user: AuthenticatedUser, projectId: string, workspaceId: string) => {
    const created = conversationSchema.parse(
      await ok(user, "conversations.create", {
        payload: { title: "Im Projekt", collaborationWorkspaceId: workspaceId, projectId }
      })
    );
    await db.store.conversations.appendMessage({
      ...t.scope,
      conversationId: asConversationId(created.id),
      role: "user",
      text: "Hallo"
    });
    return created;
  };
  const conversation = async (id: string): Promise<Conversation> => {
    const found = await db.store.conversations.getConversation(
      t.clientInstanceId,
      asConversationId(id)
    );
    if (!found) throw new Error("No such conversation");
    return found;
  };
  const upload = async (user: AuthenticatedUser, projectId: string, filename: string) => {
    const body = createMultipartFilePayload({
      fieldName: "file",
      filename,
      contentType: "text/plain",
      content: `Inhalt von ${filename}`
    });
    const response = await t.api.call("projects.files.upload", {
      params: { projectId },
      headers: { ...body.headers, "x-dev-user-id": user.id },
      payload: body.payload
    });
    expect(response.json()).not.toHaveProperty("error");
  };
  const reads = async (user: AuthenticatedUser, conversationId: string) =>
    (await call(user, "conversations.thread.get", { params: { conversationId } })).statusCode ===
    200;
  const seesProject = async (user: AuthenticatedUser, name: string) =>
    (await call(user, "projects.get", { params: { projectName: name } })).statusCode === 200;
  const rowsOf = async (projectId: string) => {
    const [row] = await db.sql<
      Array<{ assets: number; projects: number; files: number; versions: number }>
    >`
      select
        (select count(*)::int from config_assets where id = ${projectId}) as assets,
        (select count(*)::int from projects where asset_id = ${projectId}) as projects,
        (select count(*)::int from project_files where project_id = ${projectId}) as files,
        (select count(*)::int from project_file_versions where project_id = ${projectId}) as versions`;
    return { ...row };
  };
  const objectsOf = (projectId: string) =>
    objects.keys().filter((key) => key.startsWith(`assets/${projectId}/`));
  const member = (
    collaborationWorkspaceId: CollaborationWorkspaceId,
    user: AuthenticatedUser,
    role: "member" | "owner"
  ) =>
    db.store.workspaces.addMembership({
      ...t.scope,
      collaborationWorkspaceId,
      userId: asUserId(user.id),
      role
    });
  /** One retention run at `now`, with idle projects deleted after `idleDays`. */
  const retention = (now: Date, idleDays?: number) =>
    new ConversationRetentionWorkflow(
      {
        ...t.options,
        config: {
          ...config,
          retention: {
            ...config.retention,
            ...(idleDays === undefined ? {} : { projectIdleDays: idleDays })
          }
        },
        pages: { objects }
      },
      { now: () => now }
    ).runProjectRetention();
  /** Everything that counts as activity of the project lies `days` back. */
  const ageProject = async (projectId: string, days: number) => {
    const at = new Date(Date.now() - days * DAY_MS);
    await db.sql`update config_assets set created_at = ${at}, updated_at = ${at} where id = ${projectId}`;
    await db.sql`update projects set audience_changed_at = ${at} where asset_id = ${projectId}`;
    await db.sql`update conversations set updated_at = ${at} where project_id = ${projectId}`;
    await db.sql`update project_files set updated_at = ${at} where project_id = ${projectId}`;
  };
  const notices = async () =>
    (
      await db.sql<Array<{ addressee: string; summary: string }>>`
        select addressee_user_id as addressee, summary from approval_requests
        where client_instance_id = ${t.clientInstanceId} and kind = 'notice'
        order by created_at`
    ).map((row) => ({ ...row }));
  return {
    t,
    objects,
    call,
    ok,
    reasonOf,
    project,
    chatIn,
    conversation,
    upload,
    reads,
    seesProject,
    rowsOf,
    objectsOf,
    member,
    retention,
    ageProject,
    notices
  };
}

describe("a whole project: who reads it, where it is, and its deletion", () => {
  const db = usePostgresSuite("projectslifecycle");

  it("shares a private project with its chats and makes it private again", async () => {
    const a = await arrange(db, "prjaud");
    const kai = await a.t.createUser("kai");
    const lena = await a.t.createUser("lena");
    const team = await a.t.createSharedWorkspace(kai, "Team");
    await a.member(team.id, lena, "member");
    const notes = await a.project(kai, team.id, "Notizen", "private");
    const kaisChat = await a.chatIn(kai, notes.id, team.id);
    await a.upload(kai, notes.id, "plan.md");
    expect(await a.seesProject(lena, notes.name)).toBe(false);
    expect(await a.reads(lena, kaisChat.id)).toBe(false);

    const shared = await a.ok(kai, "projects.set_audience", {
      params: { projectId: notes.id },
      payload: { audience: "workspace", expectedAudience: "private" }
    });
    expect(shared).toMatchObject({ conversationsShared: 1, project: { audience: "workspace" } });
    expect(await a.seesProject(lena, notes.name)).toBe(true);
    expect(await a.reads(lena, kaisChat.id)).toBe(true);
    expect((await a.conversation(kaisChat.id)).visibility).toBe("workspace");
    expect(
      (await a.call(lena, "projects.files.list", { params: { projectId: notes.id } })).statusCode
    ).toBe(200);

    // Lena writes in the shared project; she cannot change who reads it.
    const lenasChat = await a.chatIn(lena, notes.id, team.id);
    await a.upload(lena, notes.id, "lena.md");
    expect(
      a.reasonOf(
        await a.call(lena, "projects.set_audience", {
          params: { projectId: notes.id },
          payload: { audience: "private", expectedAudience: "workspace" }
        })
      )
    ).toBe("project_creator_only");
    const impact = await a.ok(kai, "projects.impact", { params: { projectId: notes.id } });
    expect(impact).toEqual({
      conversations: 2,
      conversationsOfOthers: 1,
      conversationsKeptPrivate: 0,
      files: 2,
      filesOfOthers: 1,
      filesKeptPrivate: 0
    });
    // A dialog that saw an older audience is refused.
    expect(
      a.reasonOf(
        await a.call(kai, "projects.set_audience", {
          params: { projectId: notes.id },
          payload: { audience: "workspace", expectedAudience: "private" }
        })
      )
    ).toBe("project_audience_changed");

    const hidden = await a.ok(kai, "projects.set_audience", {
      params: { projectId: notes.id },
      payload: { audience: "private", expectedAudience: "workspace" }
    });
    expect(hidden).toMatchObject({ conversationsLeft: 1, conversationsMadePrivate: 1 });
    expect(await a.seesProject(lena, notes.name)).toBe(false);
    expect(await a.reads(lena, kaisChat.id)).toBe(false);
    // Lena's chat left the project and stays shared in the workspace, read by both.
    const left = await a.conversation(lenasChat.id);
    expect(left.projectId).toBeUndefined();
    expect(left.visibility).toBe("workspace");
    expect(await a.reads(lena, lenasChat.id)).toBe(true);
    expect(await a.reads(kai, lenasChat.id)).toBe(true);
    // The file Lena wrote stays in the project.
    expect(a.objectsOf(notes.id)).toHaveLength(2);

    const [event] = await db.sql<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events
      where type = 'project.audience_changed' and subject = ${notes.id}
      order by created_at desc limit 1`;
    expect(event?.metadata).toMatchObject({
      workspaceId: team.id,
      previousAudience: "workspace",
      audience: "private",
      conversationsLeft: 1
    });
    expect(JSON.stringify(event?.metadata)).not.toContain("Notizen");
  });

  it("keeps a project private while a chat in it holds personal data or reads a Data Store", async () => {
    const a = await arrange(db, "prjkept");
    const kai = await a.t.createUser("kai");
    const team = await a.t.createSharedWorkspace(kai, "Team");
    const personal = await a.project(kai, team.id, "Persönlich", "private");
    const marked = await a.chatIn(kai, personal.id, team.id);
    await db.store.conversations.markPersonalData({
      ...a.t.scope,
      conversationId: asConversationId(marked.id),
      userId: kai.id,
      at: new Date().toISOString()
    });
    const share = () =>
      a.call(kai, "projects.set_audience", {
        params: { projectId: personal.id },
        payload: { audience: "workspace", expectedAudience: "private" }
      });
    const refused = await share();
    expect(refused.statusCode).toBe(409);
    expect(a.reasonOf(refused)).toBe("project_conversations_stay_private");
    expect((await a.conversation(marked.id)).visibility).toBe("private");

    const reading = await a.project(kai, team.id, "Mit Datenspeicher", "private");
    const chat = await a.chatIn(kai, reading.id, team.id);
    // Any asset stands in for the Data Store: the row is what keeps the chat private.
    await db.sql`
      insert into conversation_data_stores
        (conversation_id, store_asset_id, client_instance_id, added_by_user_id, added_at)
      values (${chat.id}, ${reading.id}, ${a.t.clientInstanceId}, ${kai.id}, now())`;
    const refusedToo = await a.call(kai, "projects.set_audience", {
      params: { projectId: reading.id },
      payload: { audience: "workspace", expectedAudience: "private" }
    });
    expect(a.reasonOf(refusedToo)).toBe("project_conversations_stay_private");
    const impact = await a.ok(kai, "projects.impact", { params: { projectId: reading.id } });
    expect(impact).toMatchObject({ conversationsKeptPrivate: 1 });
    await db.sql`delete from conversation_data_stores where conversation_id = ${chat.id}`;
  });

  it("asks before a chat others read enters a private project, and reads the audience again under the lock", async () => {
    const a = await arrange(db, "prjenter");
    const kai = await a.t.createUser("kai");
    const lena = await a.t.createUser("lena");
    const team = await a.t.createSharedWorkspace(kai, "Team");
    await a.member(team.id, lena, "member");
    const mine = await a.project(kai, team.id, "Meins", "private");
    const open = conversationSchema.parse(
      await a.ok(kai, "conversations.create", {
        payload: { title: "Offen", collaborationWorkspaceId: team.id }
      })
    );
    const asked = await a.call(kai, "conversations.set_project", {
      params: { conversationId: open.id },
      payload: { projectId: mine.id }
    });
    expect(a.reasonOf(asked)).toBe("project_hides_conversation");
    expect(await a.reads(lena, open.id)).toBe(true);
    await a.ok(kai, "conversations.set_project", {
      params: { conversationId: open.id },
      payload: { projectId: mine.id, hideFromOthers: true }
    });
    expect(await a.reads(lena, open.id)).toBe(false);

    // The store refuses a chat whose visibility no longer matches the project's audience, and a
    // chat of someone else in a private project.
    const lenas = conversationSchema.parse(
      await a.ok(lena, "conversations.create", {
        payload: { title: "Lenas", collaborationWorkspaceId: team.id, visibility: "private" }
      })
    );
    await expect(
      db.store.conversations.setConversationProject({
        ...a.t.scope,
        conversationId: asConversationId(lenas.id),
        expectedProjectId: null,
        projectId: mine.id,
        visibility: "private"
      })
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === "NOT_FOUND");
    const kais = conversationSchema.parse(
      await a.ok(kai, "conversations.create", {
        payload: { title: "Kais", collaborationWorkspaceId: team.id, visibility: "private" }
      })
    );
    await expect(
      db.store.conversations.setConversationProject({
        ...a.t.scope,
        conversationId: asConversationId(kais.id),
        expectedProjectId: null,
        projectId: mine.id,
        visibility: "workspace"
      })
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === "CONFLICT");
  });

  it("decides a chat's entry and a change of the audience one after the other, under the project's lock", async () => {
    const a = await arrange(db, "prjrace");
    const kai = await a.t.createUser("kai");
    const lena = await a.t.createUser("lena");
    const team = await a.t.createSharedWorkspace(kai, "Team");
    await a.member(team.id, lena, "member");
    const markedChat = async (title: string) => {
      const chat = conversationSchema.parse(
        await a.ok(kai, "conversations.create", {
          payload: { title, collaborationWorkspaceId: team.id, visibility: "private" }
        })
      );
      await db.store.conversations.markPersonalData({
        ...a.t.scope,
        conversationId: asConversationId(chat.id),
        userId: kai.id,
        at: new Date().toISOString()
      });
      return chat;
    };
    const share = (projectId: string) =>
      settled(
        db.store.projects.setProjectAudience({
          ...a.t.scope,
          projectId,
          collaborationWorkspaceId: team.id,
          expectedAudience: "private",
          audience: "workspace",
          changedAt: new Date().toISOString()
        })
      );
    const enter = (conversationId: string, projectId: string) =>
      settled(
        db.secondStore.conversations.setConversationProject({
          ...a.t.scope,
          conversationId: asConversationId(conversationId),
          expectedProjectId: null,
          projectId,
          visibility: "private"
        })
      );

    // The project is shared first: the private chat that waited is refused, as its visibility
    // no longer matches, and stays out of the members' sight.
    const first = await a.project(kai, team.id, "Erst geteilt", "private");
    const mail = await markedChat("Mail");
    let held = await db.hold(
      (tx) => tx`select 1 from config_assets where id = ${first.id} for update`
    );
    const shared = share(first.id);
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
    const entered = enter(mail.id, first.id);
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
    await held.commit();
    expect((await shared).status).toBe("fulfilled");
    const refused = await entered;
    expect(refused.status).toBe("rejected");
    expect(refused.status === "rejected" && isAppError(refused.reason) && refused.reason.code).toBe(
      "CONFLICT"
    );
    expect((await a.conversation(mail.id)).projectId).toBeUndefined();
    expect(await a.reads(lena, mail.id)).toBe(false);

    // The chat enters first: the sharing that waited sees it and is refused.
    const second = await a.project(kai, team.id, "Erst betreten", "private");
    const notes = await markedChat("Notizen");
    held = await db.hold(
      (tx) => tx`select 1 from config_assets where id = ${second.id} for update`
    );
    const enteredFirst = settled(
      db.store.conversations.setConversationProject({
        ...a.t.scope,
        conversationId: asConversationId(notes.id),
        expectedProjectId: null,
        projectId: second.id,
        visibility: "private"
      })
    );
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
    const sharedLater = settled(
      db.secondStore.projects.setProjectAudience({
        ...a.t.scope,
        projectId: second.id,
        collaborationWorkspaceId: team.id,
        expectedAudience: "private",
        audience: "workspace",
        changedAt: new Date().toISOString()
      })
    );
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
    await held.commit();
    expect((await enteredFirst).status).toBe("fulfilled");
    const late = await sharedLater;
    expect(
      late.status === "rejected" && isAppError(late.reason) && late.reason.details
    ).toMatchObject({ reason: "project_conversations_stay_private" });
    expect(await a.reads(lena, notes.id)).toBe(false);
  });

  it("keeps a project private while a file holds what a private chat wrote, also after the chat left", async () => {
    const a = await arrange(db, "prjkeptfiles");
    const kai = await a.t.createUser("kai");
    const team = await a.t.createSharedWorkspace(kai, "Team");
    const notes = await a.project(kai, team.id, "Notizen", "private");
    const chat = await a.chatIn(kai, notes.id, team.id);
    await db.store.conversations.markPersonalData({
      ...a.t.scope,
      conversationId: asConversationId(chat.id),
      userId: kai.id,
      at: new Date().toISOString()
    });
    const write = async (path: string, conversationId: string) => {
      const objectKey = `assets/${notes.id}/files/${path}`;
      await a.objects.put(objectKey, new TextEncoder().encode("Inhalt"));
      const written = await db.store.projectFiles.writeProjectFileVersion({
        ...a.t.scope,
        projectId: notes.id,
        path,
        content: { objectKey, byteSize: 6, checksum: `sha256:${path}`, mimeType: "text/plain" },
        origin: "agent",
        byUserId: kai.id,
        conversationId,
        at: new Date().toISOString(),
        limits: { maxFiles: 10, maxFileBytes: 100, maxProjectBytes: 1000, versionsPerFile: 5 }
      });
      expect(written.status).toBe("written");
    };
    await write("notizen.md", chat.id);
    // The chat leaves the project; what it wrote stays in the file's versions.
    await a.ok(kai, "conversations.set_project", {
      params: { conversationId: chat.id },
      payload: { projectId: null }
    });
    const share = () =>
      a.call(kai, "projects.set_audience", {
        params: { projectId: notes.id },
        payload: { audience: "workspace", expectedAudience: "private" }
      });
    expect(a.reasonOf(await share())).toBe("project_files_stay_private");
    await expect(
      a.ok(kai, "projects.impact", { params: { projectId: notes.id } })
    ).resolves.toMatchObject({ conversationsKeptPrivate: 0, filesKeptPrivate: 1 });
    await a.ok(kai, "projects.files.purge", {
      params: { projectId: notes.id },
      payload: { path: "notizen.md" }
    });

    // A version whose chat is gone cannot be told apart: it keeps the project private too.
    await write("alt.md", "conv_gone");
    expect(a.reasonOf(await share())).toBe("project_files_stay_private");
    await a.ok(kai, "projects.files.purge", {
      params: { projectId: notes.id },
      payload: { path: "alt.md" }
    });
    await a.ok(kai, "projects.set_audience", {
      params: { projectId: notes.id },
      payload: { audience: "workspace", expectedAudience: "private" }
    });
  });

  it("moves a project with its chats and files where the mover is a member of both, and ends its grants", async () => {
    const a = await arrange(db, "prjmove");
    const kai = await a.t.createUser("kai");
    const lena = await a.t.createUser("lena");
    const root = await a.t.createUser("root", ["user", "admin", "superadmin"]);
    const team = await a.t.createSharedWorkspace(kai, "Team");
    const sales = await a.t.createSharedWorkspace(lena, "Vertrieb");
    const kaisOwn = await a.t.personalWorkspaceOf(kai);
    await a.member(team.id, lena, "member");
    const nord = await a.project(kai, team.id, "Nord");
    const chat = await a.chatIn(kai, nord.id, team.id);
    await a.upload(kai, nord.id, "a.txt");
    const before = a.objectsOf(nord.id);
    await db.sql`
      insert into permission_grants
        (id, client_instance_id, holder_kind, holder_id, action, scope_kind, scope_id, effect,
         granted_by, created_at)
      values ('grant_prj6', ${a.t.clientInstanceId}, 'user', ${lena.id}, 'project.read', 'asset',
        ${nord.id}, 'allow', ${kai.id}, now())`;

    // Kai is no member of Vertrieb, Lena's superadmin access is no membership either.
    const notMember = await a.call(kai, "projects.move", {
      params: { projectId: nord.id },
      payload: { collaborationWorkspaceId: sales.id }
    });
    expect(notMember.statusCode).toBe(404);
    const superadmin = await a.call(root, "projects.move", {
      params: { projectId: nord.id },
      payload: { collaborationWorkspaceId: sales.id }
    });
    expect(superadmin.statusCode).toBe(403);
    // Into Kai's Personal Workspace: Lena's chat would leave her.
    const lenasChat = await a.chatIn(lena, nord.id, team.id);
    const intoPersonal = await a.call(kai, "projects.move", {
      params: { projectId: nord.id },
      payload: { collaborationWorkspaceId: kaisOwn.id }
    });
    expect(a.reasonOf(intoPersonal)).toBe("project_holds_others_conversations");
    await a.ok(lena, "conversations.set_project", {
      params: { conversationId: lenasChat.id },
      payload: { projectId: null }
    });

    const moved = await a.ok(lena, "projects.move", {
      params: { projectId: nord.id },
      payload: { collaborationWorkspaceId: sales.id }
    });
    expect(moved).toMatchObject({
      conversationsMoved: 1,
      project: { collaborationWorkspaceId: sales.id, audience: "workspace" }
    });
    const movedChat = await a.conversation(chat.id);
    expect(movedChat).toMatchObject({ collaborationWorkspaceId: sales.id, projectId: nord.id });
    // Kai is no member of Vertrieb: he reaches neither the project nor its chat now.
    expect(await a.seesProject(kai, nord.name)).toBe(false);
    expect(await a.reads(kai, chat.id)).toBe(false);
    expect(await a.reads(lena, chat.id)).toBe(true);
    // The files stay under the project's own prefix: no byte was copied.
    expect(a.objectsOf(nord.id)).toEqual(before);
    const [grants] = await db.sql<Array<{ count: number }>>`
      select count(*)::int as count from permission_grants where scope_id = ${nord.id}`;
    expect(grants?.count).toBe(0);
    const [event] = await db.sql<Array<{ metadata: Record<string, unknown> }>>`
      select metadata from audit_events where type = 'project.moved' and subject = ${nord.id}`;
    expect(event?.metadata).toMatchObject({
      fromWorkspaceId: team.id,
      toWorkspaceId: sales.id,
      grantsDropped: 1
    });
    // Every chat's project is in the chat's workspace.
    const [stray] = await db.sql<Array<{ count: number }>>`
      select count(*)::int as count from conversations c join config_assets p on p.id = c.project_id
      where p.scope_id is distinct from c.collaboration_workspace_id`;
    expect(stray?.count).toBe(0);
  });

  it("moves a project out of a Personal Workspace as private unless the person shares it", async () => {
    const a = await arrange(db, "prjpersonal");
    const kai = await a.t.createUser("kai");
    const own = await a.t.personalWorkspaceOf(kai);
    const team = await a.t.createSharedWorkspace(kai, "Team");
    const home = await a.project(kai, own.id, "Zuhause");
    const chat = await a.chatIn(kai, home.id, own.id);
    expect((await a.conversation(chat.id)).visibility).toBe("workspace");
    const moved = await a.ok(kai, "projects.move", {
      params: { projectId: home.id },
      payload: { collaborationWorkspaceId: team.id }
    });
    expect(moved).toMatchObject({ project: { audience: "private" } });
    expect((await a.conversation(chat.id)).visibility).toBe("private");
    const back = await a.ok(kai, "projects.move", {
      params: { projectId: home.id },
      payload: { collaborationWorkspaceId: own.id }
    });
    expect(back).toMatchObject({ project: { audience: "workspace" } });
    expect((await a.conversation(chat.id)).visibility).toBe("workspace");
  });

  it("deletes a project with its files, versions and bytes, and keeps or deletes its chats as chosen", async () => {
    const a = await arrange(db, "prjdelete");
    const kai = await a.t.createUser("kai");
    const lena = await a.t.createUser("lena");
    const team = await a.t.createSharedWorkspace(kai, "Team");
    await a.member(team.id, lena, "member");

    const kept = await a.project(kai, team.id, "Behalten");
    const keptChat = await a.chatIn(lena, kept.id, team.id);
    const keptData = await a.t.createData(await a.conversation(keptChat.id));
    await a.upload(kai, kept.id, "a.txt");
    const keep = await a.ok(lena, "projects.delete", {
      params: { projectId: kept.id },
      payload: { conversations: "keep" }
    });
    expect(keep).toEqual({ conversationsDeleted: 0, conversationsKept: 1 });
    await expect(a.rowsOf(kept.id)).resolves.toEqual({
      assets: 0,
      projects: 0,
      files: 0,
      versions: 0
    });
    expect(a.objectsOf(kept.id)).toEqual([]);
    const stays = await a.conversation(keptChat.id);
    expect(stays).toMatchObject({ status: "active", visibility: "workspace" });
    expect(stays.projectId).toBeUndefined();
    await a.t.expectDataLeft(stays, keptData);
    expect(await a.seesProject(lena, kept.name)).toBe(false);

    const gone = await a.project(kai, team.id, "Weg");
    const goneChat = await a.conversation((await a.chatIn(lena, gone.id, team.id)).id);
    const goneData = await a.t.createData(goneChat);
    await a.upload(kai, gone.id, "a.txt");
    await a.upload(kai, gone.id, "b.txt");
    // No chat enters a deleted project.
    const late = await a.call(kai, "conversations.create", {
      payload: { title: "Zu spät", collaborationWorkspaceId: team.id, projectId: kept.id }
    });
    expect(late.statusCode).toBe(404);
    const remove = await a.ok(kai, "projects.delete", {
      params: { projectId: gone.id },
      payload: { conversations: "delete" }
    });
    expect(remove).toEqual({ conversationsDeleted: 1, conversationsKept: 0 });
    await expect(a.t.statusOf(goneChat)).resolves.toBe("deleted");
    await a.t.expectDataRemoved(goneChat, goneData);
    await expect(a.rowsOf(gone.id)).resolves.toEqual({
      assets: 0,
      projects: 0,
      files: 0,
      versions: 0
    });
    expect(a.objectsOf(gone.id)).toEqual([]);
    const events = await a.t.eventsOfType("project.deleted");
    expect(events.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversations: "delete",
          conversationsDeleted: 1,
          cleanup: "complete"
        })
      ])
    );
  });

  it("claims the chats the person chose to delete with the project, before any cleanup", async () => {
    const a = await arrange(db, "prjclaimchats");
    const kai = await a.t.createUser("kai");
    const team = await a.t.createSharedWorkspace(kai, "Team");
    const gone = await a.project(kai, team.id, "Weg");
    const chat = await a.chatIn(kai, gone.id, team.id);
    const claim = await db.store.projects.claimProjectDeletion({
      ...a.t.scope,
      projectId: gone.id,
      deleteConversations: true,
      deletedAt: new Date().toISOString()
    });
    expect(claim).toEqual({
      status: "claimed",
      conversationIds: [],
      deletedConversationIds: [chat.id]
    });
    // Deleted before its data is cleaned up: the conversation retry finishes what is left.
    const [row] = await db.sql<Array<{ status: string; project_id: string | null }>>`
      select status, project_id from conversations where id = ${chat.id}`;
    expect({ ...row }).toEqual({ status: "deleted", project_id: null });
  });

  it("claims a project before its bytes go, refuses writes after, and finishes a failed cleanup on the next run", async () => {
    const a = await arrange(db, "prjretry");
    const kai = await a.t.createUser("kai");
    const team = await a.t.createSharedWorkspace(kai, "Team");
    const failing = await a.project(kai, team.id, "Fehlschlag");
    await a.upload(kai, failing.id, "a.txt");
    // The object store is down while the project is deleted.
    const deletePrefix = a.objects.deletePrefix.bind(a.objects);
    a.objects.deletePrefix = () => Promise.reject(new Error("Object storage is unavailable"));
    const response = await a.ok(kai, "projects.delete", {
      params: { projectId: failing.id },
      payload: { conversations: "keep" }
    });
    expect(response).toEqual({ conversationsDeleted: 0, conversationsKept: 0 });
    // Claimed: nobody reads it, and no file is written into it, while its rows and bytes wait.
    expect(await a.seesProject(kai, failing.name)).toBe(false);
    await expect(a.rowsOf(failing.id)).resolves.toMatchObject({ assets: 1, files: 1 });
    expect(a.objectsOf(failing.id)).toHaveLength(1);
    await expect(
      db.store.projectFiles.writeProjectFileVersion({
        ...a.t.scope,
        projectId: failing.id,
        path: "spät.txt",
        content: { objectKey: "late", byteSize: 1, checksum: "x", mimeType: "text/plain" },
        origin: "person",
        byUserId: kai.id,
        at: new Date().toISOString(),
        limits: { maxFiles: 10, maxFileBytes: 10, maxProjectBytes: 100, versionsPerFile: 5 }
      })
    ).rejects.toSatisfy((error) => isAppError(error) && error.code === "NOT_FOUND");
    expect(await a.t.eventsOfType("project.cleanup_failed")).toHaveLength(1);

    a.objects.deletePrefix = deletePrefix;
    const summary = await a.retention(new Date());
    expect(summary).toMatchObject({ cleanupCompletedCount: 1, cleanupPendingCount: 0 });
    await expect(a.rowsOf(failing.id)).resolves.toEqual({
      assets: 0,
      projects: 0,
      files: 0,
      versions: 0
    });
    expect(a.objectsOf(failing.id)).toEqual([]);
  });

  it("gives notice of an idle project seven days ahead and deletes it then, keeping its chats", async () => {
    const a = await arrange(db, "prjidle");
    const kai = await a.t.createUser("kai");
    const owner = await a.t.createUser("owner");
    const lena = await a.t.createUser("lena");
    const team = await a.t.createSharedWorkspace(owner, "Team");
    await a.member(team.id, kai, "member");
    await a.member(team.id, lena, "member");
    const idle = await a.project(kai, team.id, "Ruhig");
    const chat = await a.chatIn(kai, idle.id, team.id);
    await a.upload(kai, idle.id, "a.txt");
    const fresh = await a.project(kai, team.id, "Frisch");
    const privateIdle = await a.project(kai, team.id, "Privat ruhig", "private");
    await a.ageProject(idle.id, 25);
    await a.ageProject(privateIdle.id, 25);

    // Empty by default: nothing is noticed or deleted.
    expect(await a.retention(new Date())).toMatchObject({ noticedCount: 0, deletedCount: 0 });
    expect(await a.notices()).toEqual([]);

    const now = new Date();
    expect(await a.retention(now, 30)).toMatchObject({ noticedCount: 2, deletedCount: 0 });
    const filed = await a.notices();
    // The shared project's creator and the workspace's Owner; the private one's creator alone.
    expect(filed.map((notice) => notice.addressee).sort()).toEqual(
      [kai.id, owner.id, kai.id].sort()
    );
    expect(filed.every((notice) => !notice.addressee.includes(lena.id))).toBe(true);
    // The summary, which lists and mails show, names no project.
    expect(filed.every((notice) => !notice.summary.includes("Ruhig"))).toBe(true);
    // Noticed once.
    expect(await a.retention(now, 30)).toMatchObject({ noticedCount: 0, deletedCount: 0 });

    // Seven days later, with nothing happening, the idle projects go; their chats stay.
    const later = new Date(now.getTime() + 7 * DAY_MS + 60_000);
    const summary = await a.retention(later, 30);
    expect(summary).toMatchObject({ deletedCount: 2 });
    await expect(a.rowsOf(idle.id)).resolves.toEqual({
      assets: 0,
      projects: 0,
      files: 0,
      versions: 0
    });
    expect(a.objectsOf(idle.id)).toEqual([]);
    const stays = await a.conversation(chat.id);
    expect(stays.status).toBe("active");
    expect(stays.projectId).toBeUndefined();
    await expect(a.rowsOf(fresh.id)).resolves.toMatchObject({ assets: 1 });
    const events = await a.t.eventsOfType("project.retention_deleted");
    expect(events).toHaveLength(2);
  });

  it("keeps an idle project that someone used after its notice, and notices it anew later", async () => {
    const a = await arrange(db, "prjidleused");
    const kai = await a.t.createUser("kai");
    const team = await a.t.createSharedWorkspace(kai, "Team");
    const used = await a.project(kai, team.id, "Benutzt");
    await a.ageProject(used.id, 25);
    const now = new Date();
    expect(await a.retention(now, 30)).toMatchObject({ noticedCount: 1 });
    // A file changes after the notice.
    await a.upload(kai, used.id, "neu.txt");
    const later = new Date(now.getTime() + 8 * DAY_MS);
    expect(await a.retention(later, 30)).toMatchObject({ deletedCount: 0 });
    await expect(a.rowsOf(used.id)).resolves.toMatchObject({ assets: 1, files: 1 });
    const [row] = await db.sql<Array<{ noticed: boolean }>>`
      select idle_notice_at is not null as noticed from projects where asset_id = ${used.id}`;
    expect(row?.noticed).toBe(false);
  });
});
