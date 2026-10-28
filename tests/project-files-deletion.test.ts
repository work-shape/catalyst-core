import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asUserId, type AuthenticatedUser } from "@work-shape/catalyst-core";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { arrangeDeletion } from "./support/deletion-fixture";
import { createMultipartFilePayload } from "./support/chat-server-attachment-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { RecordingByteStore } from "./support/retention-harness";

// PRJ-2: project files outlive chats and go with their project. A deleted user's private
// projects go with their files, in Shared Workspaces too, and the chats that still point at one
// leave it first; a deleted workspace's projects leave no row and no stored byte behind.

const idSchema = z.object({ id: z.string() });

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
  // The call path is built again, with the module on.
  const t = await arrangeDeletion(db, label, {
    config,
    modules,
    pages: { objects },
    operationCalls: undefined
  });
  const project = async (
    user: AuthenticatedUser,
    workspaceId: string,
    title: string,
    audience?: "private"
  ) => {
    const response = await t.api.call(
      "projects.create",
      {
        payload: { collaborationWorkspaceId: workspaceId, title, ...(audience ? { audience } : {}) }
      },
      user.id
    );
    expect(response.json()).not.toHaveProperty("error");
    return idSchema.parse(response.json()).id;
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
  return { t, project, upload, rowsOf, objectsOf };
}

describe("project files when their people and workspaces go", () => {
  const db = usePostgresSuite("projectfilesdeletion");

  it("deletes a user's private projects with their files, after their chats leave them", async () => {
    const { t, project, upload, rowsOf, objectsOf } = await arrange(db, "prjuser");
    const owner = await t.createUser("owner", ["user", "admin", "superadmin"]);
    const leaving = await t.createUser("leaving");
    const team = await t.createSharedWorkspace(owner, "Team");
    await db.store.workspaces.addMembership({
      ...t.scope,
      collaborationWorkspaceId: team.id,
      userId: asUserId(leaving.id),
      role: "member"
    });
    const personal = await t.personalWorkspaceOf(leaving);
    const own = await project(leaving, team.id, "Eigene Notizen", "private");
    const sharedProject = await project(leaving, team.id, "Gemeinsam");
    const personalProject = await project(leaving, personal.id, "Privat");
    await upload(leaving, own, "eigen.txt");
    await upload(leaving, sharedProject, "geteilt.txt");
    await upload(leaving, personalProject, "zuhause.txt");
    // A chat in the private project: deleted with the account, but its row points at the
    // project until the cleanup takes it out (the key restricts the project's delete).
    const chat = await t.api.call(
      "conversations.create",
      { payload: { title: "Im Projekt", collaborationWorkspaceId: team.id, projectId: own } },
      leaving.id
    );
    const chatId = idSchema.parse(chat.json()).id;
    expect(objectsOf(own)).toHaveLength(1);
    expect(objectsOf(personalProject)).toHaveLength(1);

    expect([200, 202]).toContain((await t.api.call("me.delete", {}, leaving.id)).statusCode);
    await t.runDeletionJobs();
    await expect(t.userRow(leaving)).resolves.toEqual([]);

    await expect(rowsOf(own)).resolves.toEqual({ assets: 0, projects: 0, files: 0, versions: 0 });
    await expect(rowsOf(personalProject)).resolves.toEqual({
      assets: 0,
      projects: 0,
      files: 0,
      versions: 0
    });
    expect(objectsOf(own)).toEqual([]);
    expect(objectsOf(personalProject)).toEqual([]);
    const [left] = await db.sql<Array<{ project_id: string | null }>>`
      select project_id from conversations where id = ${chatId}`;
    expect(left?.project_id ?? null).toBeNull();
    // The workspace's project stays with its file; the version no longer names the person.
    await expect(rowsOf(sharedProject)).resolves.toEqual({
      assets: 1,
      projects: 1,
      files: 1,
      versions: 1
    });
    expect(objectsOf(sharedProject)).toHaveLength(1);
    const [authors] = await db.sql<Array<{ named: number }>>`
      select count(*)::int as named from project_file_versions
      where project_id = ${sharedProject} and by_user_id is not null`;
    expect(authors?.named).toBe(0);
  });

  it("leaves no row and no stored byte of a deleted workspace's projects", async () => {
    const { t, project, upload, rowsOf, objectsOf } = await arrange(db, "prjworkspace");
    const owner = await t.createUser("owner", ["user", "admin", "superadmin"]);
    const workspace = await t.createSharedWorkspace(owner, "Weg damit");
    const other = await t.createSharedWorkspace(owner, "Bleibt");
    const gone = await project(owner, workspace.id, "Akten");
    const goneToo = await project(owner, workspace.id, "Privat", "private");
    const kept = await project(owner, other.id, "Akten");
    await upload(owner, gone, "a.txt");
    await upload(owner, gone, "b.txt");
    await upload(owner, goneToo, "c.txt");
    await upload(owner, kept, "a.txt");

    const accepted = await t.api.call(
      "workspaces.delete",
      {
        params: { collaborationWorkspaceId: workspace.id },
        payload: { confirmName: workspace.name }
      },
      owner.id
    );
    expect(accepted.statusCode).toBe(200);
    await t.runDeletionJobs();
    const [left] = await db.sql<Array<{ workspaces: number }>>`
      select count(*)::int as workspaces from collaboration_workspaces where id = ${workspace.id}`;
    expect(left?.workspaces).toBe(0);
    for (const projectId of [gone, goneToo]) {
      await expect(rowsOf(projectId)).resolves.toEqual({
        assets: 0,
        projects: 0,
        files: 0,
        versions: 0
      });
      expect(objectsOf(projectId)).toEqual([]);
    }
    await expect(rowsOf(kept)).resolves.toMatchObject({ projects: 1, files: 1 });
    expect(objectsOf(kept)).toHaveLength(1);
  });
});
