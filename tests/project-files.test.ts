import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asConversationId,
  asToolCallId,
  asUserId,
  type AgentRunId,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type ToolExecutionContext,
  type UserRecord
} from "@work-shape/catalyst-core";
import { createLogger, resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { ProjectFileService } from "@work-shape/catalyst-server";
import {
  createWorkspaceToolDefinitions,
  ToolRegistry,
  WorkspaceCommandService
} from "@work-shape/catalyst-tool-execution";
import {
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import {
  createMultipartFilePayload,
  createTestAttachmentService
} from "./support/chat-server-attachment-harness";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { createTestToolRunner } from "./support/tool-runner";

// PRJ-2: the files of a project. One folder per project that people and agents write in place;
// every change is a version, and a change over a file that changed meanwhile is kept beside it
// as a conflict copy. The project's audience reads and writes it, and nobody else, also by id.
// Kai owns the workspace Team, Lena is a member; Mia holds Builder there and is no member.

const ON = { projects: { enabled: true } };
const LIMITS = { maxFiles: 6, maxFileBytes: 400, maxProjectBytes: 1500, versionsPerFile: 3 };

const projectSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  audience: z.enum(["workspace", "private"]),
  collaborationWorkspaceId: z.string()
});
type Project = z.infer<typeof projectSchema>;
const changeSchema = z.object({
  path: z.string(),
  version: z.number(),
  change: z.string(),
  previousVersion: z.number().optional(),
  changed: z.object({ path: z.string(), version: z.number() }).optional()
});
const filesSchema = z.object({
  items: z.array(
    z.looseObject({
      path: z.string(),
      version: z.number(),
      origin: z.string(),
      updatedBy: z.object({ id: z.string(), label: z.string() }).optional()
    })
  ),
  usage: z.object({ files: z.number(), bytes: z.number() })
});
const versionsSchema = z.object({
  currentVersion: z.number().optional(),
  items: z.array(
    z.looseObject({
      version: z.number(),
      deleted: z.boolean(),
      by: z.object({ id: z.string(), label: z.string() }).optional()
    })
  )
});

const resultSchema = z.object({
  status: z.string(),
  output: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ message: z.string() }).optional()
});

describe("project files", () => {
  let t: AccessInstance;
  const objects = new MemoryObjectStorage();
  let config: Parameters<typeof resolveInstanceModules>[0] | undefined;
  let mia: UserRecord;
  let team: CollaborationWorkspaceId;
  let shared: Project;
  let kaisPrivate: Project;
  let otherShared: Project;

  const reason = (response: { json(): unknown }) =>
    errorSchema.parse(response.json()).error.details?.reason;
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
  const startChat = async (
    userId: string,
    workspaceId: string,
    input: { projectId?: string; visibility?: "private" } = {}
  ) => {
    const created = await t.expectOk(userId, "conversations.create", {
      payload: { title: "Chat", collaborationWorkspaceId: workspaceId, ...input }
    });
    const id = z.object({ id: z.string() }).parse(created.json()).id;
    await t.stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: asConversationId(id),
      role: "user",
      text: "Hello"
    });
    return id;
  };
  const upload = (
    userId: string,
    projectId: string,
    filename: string,
    content: string,
    query: { path?: string; replaces?: number } = {}
  ) => {
    const body = createMultipartFilePayload({
      fieldName: "file",
      filename,
      contentType: "text/markdown",
      content
    });
    return t.call(userId, "projects.files.upload", {
      params: { projectId },
      query,
      headers: body.headers,
      payload: body.payload
    });
  };
  const uploaded = async (...input: Parameters<typeof upload>) => {
    const response = await upload(...input);
    expect(response.json(), `upload ${input[2]}`).not.toHaveProperty("error");
    return changeSchema.parse(response.json());
  };
  const files = async (userId: string, projectId: string) =>
    filesSchema.parse(
      (await t.expectOk(userId, "projects.files.list", { params: { projectId } })).json()
    );
  const content = async (userId: string, projectId: string, path: string, version?: number) => {
    const response = await t.call(userId, "projects.files.get_content", {
      params: { projectId },
      query: { path, ...(version ? { version } : {}) }
    });
    return { status: response.statusCode, body: response.body };
  };

  beforeAll(async () => {
    const attachments = createTestAttachmentService(clientInstanceId);
    t = await setupAccessInstance({
      modules: ON,
      server: (_stores, instanceConfig) => {
        const capped = { ...instanceConfig, projects: { files: LIMITS } };
        config = capped;
        return { config: capped, pages: { objects }, attachments };
      }
    });
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
    const other = (
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
    otherShared = await createProject(t.kai.id, other, "Projekt Anderswo");
  });
  afterAll(async () => {
    await t?.instance.close();
  });

  it("gives a person outside the audience nothing of a project's files, also by id", async () => {
    await uploaded(t.kai.id, kaisPrivate.id, "geheim.md", "nur Kai");
    await uploaded(t.kai.id, shared.id, "liesmich.md", "für alle");
    // Lena is a member, but the project is Kai's own; Mia holds Builder and is no member.
    for (const outsider of [t.lena.id, mia.id]) {
      const reads = [
        await t.call(outsider, "projects.files.list", { params: { projectId: kaisPrivate.id } }),
        await t.call(outsider, "projects.files.versions", {
          params: { projectId: kaisPrivate.id },
          query: { path: "geheim.md" }
        }),
        await t.call(outsider, "projects.files.get_content", {
          params: { projectId: kaisPrivate.id },
          query: { path: "geheim.md" }
        })
      ];
      expect(reads.map((response) => response.statusCode)).toEqual([404, 404, 404]);
      const writes = [
        await upload(outsider, kaisPrivate.id, "neu.md", "x"),
        await t.call(outsider, "projects.files.move", {
          params: { projectId: kaisPrivate.id },
          payload: { from: "geheim.md", to: "anders.md" }
        }),
        await t.call(outsider, "projects.files.delete", {
          params: { projectId: kaisPrivate.id },
          payload: { path: "geheim.md" }
        }),
        await t.call(outsider, "projects.files.restore", {
          params: { projectId: kaisPrivate.id },
          payload: { path: "geheim.md", version: 1 }
        }),
        await t.call(outsider, "projects.files.purge", {
          params: { projectId: kaisPrivate.id },
          payload: { path: "geheim.md" }
        })
      ];
      expect(writes.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404]);
    }
    // Mia is no member: a shared project of the workspace is not hers either.
    expect(
      (await t.call(mia.id, "projects.files.list", { params: { projectId: shared.id } })).statusCode
    ).toBe(404);
    // The member reads the shared one.
    expect((await files(t.lena.id, shared.id)).items.map((file) => file.path)).toContain(
      "liesmich.md"
    );
    expect((await content(t.kai.id, kaisPrivate.id, "geheim.md")).body).toBe("nur Kai");
  });

  it("keeps every change as a version, shows who made each, and undoes one by its version", async () => {
    const first = await uploaded(t.kai.id, shared.id, "plan.md", "eins");
    expect(first).toMatchObject({ path: "plan.md", version: 1, change: "created" });
    // A taken path is refused unless the person confirmed Replace for the version they saw.
    const blind = await upload(t.lena.id, shared.id, "plan.md", "zwei");
    expect(blind.statusCode).toBe(409);
    const second = await uploaded(t.lena.id, shared.id, "plan.md", "zwei", { replaces: 1 });
    expect(second).toMatchObject({ version: 2, change: "updated", previousVersion: 1 });

    const versions = versionsSchema.parse(
      (
        await t.expectOk(t.kai.id, "projects.files.versions", {
          params: { projectId: shared.id },
          query: { path: "plan.md" }
        })
      ).json()
    );
    expect(versions.currentVersion).toBe(2);
    expect(versions.items.map((item) => [item.version, item.by?.label])).toEqual([
      [2, "Lena"],
      [1, "Kai"]
    ]);
    expect((await content(t.kai.id, shared.id, "plan.md", 1)).body).toBe("eins");

    // Undo of Lena's change: restore v1 over v2. Not over a later change of someone else.
    const late = await t.call(t.kai.id, "projects.files.restore", {
      params: { projectId: shared.id },
      payload: { path: "plan.md", version: 1, replaces: 1 }
    });
    expect(late.statusCode).toBe(409);
    expect(reason(late)).toBe("project_file_changed");
    const undone = changeSchema.parse(
      (
        await t.expectOk(t.kai.id, "projects.files.restore", {
          params: { projectId: shared.id },
          payload: { path: "plan.md", version: 1, replaces: 2 }
        })
      ).json()
    );
    expect(undone).toMatchObject({ version: 3, change: "restored" });
    expect((await content(t.lena.id, shared.id, "plan.md")).body).toBe("eins");

    // Undo of a creation is a deletion, which a restore takes back.
    const removed = changeSchema.parse(
      (
        await t.expectOk(t.kai.id, "projects.files.delete", {
          params: { projectId: shared.id },
          payload: { path: "plan.md", replaces: 3 }
        })
      ).json()
    );
    expect(removed.change).toBe("deleted");
    expect((await files(t.kai.id, shared.id)).items.map((file) => file.path)).not.toContain(
      "plan.md"
    );
    // Only versionsPerFile (3) are kept: v1 went with the deletion, its bytes live on in v3.
    const kept = versionsSchema.parse(
      (
        await t.expectOk(t.kai.id, "projects.files.versions", {
          params: { projectId: shared.id },
          query: { path: "plan.md" }
        })
      ).json()
    );
    expect(kept.currentVersion).toBeUndefined();
    expect(kept.items.map((item) => [item.version, item.deleted])).toEqual([
      [4, true],
      [3, false],
      [2, false]
    ]);
    expect((await content(t.kai.id, shared.id, "plan.md", 3)).body).toBe("eins");
  });

  it("holds a project to its caps", async () => {
    const capped = await createProject(t.kai.id, team, "Grenzen");
    const big = await upload(t.kai.id, capped.id, "gross.md", "x".repeat(LIMITS.maxFileBytes + 1));
    expect(big.statusCode).toBe(422);
    expect(reason(big)).toBe("project_file_bytes_limit");
    for (let index = 0; index < LIMITS.maxFiles; index += 1) {
      await uploaded(t.kai.id, capped.id, `f${String(index)}.md`, "x".repeat(200));
    }
    const tooMany = await upload(t.kai.id, capped.id, "noch-eine.md", "x");
    expect(reason(tooMany)).toBe("project_files_limit");
    // Versions count toward the project's bytes: 6 x 200 = 1200, a 400-byte version of one of
    // them takes it past 1500.
    const tooLarge = await upload(t.kai.id, capped.id, "f0.md", "y".repeat(400), { replaces: 1 });
    expect(reason(tooLarge)).toBe("project_project_bytes_limit");
    expect((await files(t.kai.id, capped.id)).usage).toEqual({ files: 6, bytes: 1200 });
  });

  it("lands an upload of a project chat in the folder and keeps a chat file there on Save", async () => {
    const chat = await startChat(t.lena.id, team, { projectId: shared.id });
    const body = createMultipartFilePayload({
      fieldName: "file",
      filename: "notiz.txt",
      contentType: "text/plain",
      content: "aus dem Chat"
    });
    const response = await t.call(t.lena.id, "conversations.draft_attachments.upload", {
      params: { conversationId: chat },
      headers: body.headers,
      payload: body.payload
    });
    expect(response.json()).not.toHaveProperty("error");
    const landed = z
      .object({ attachment: z.object({ fileId: z.string() }), projectFile: changeSchema })
      .parse(response.json());
    expect(landed.projectFile).toMatchObject({ path: "notiz.txt", version: 1, change: "created" });
    const listed = (await files(t.kai.id, shared.id)).items.find(
      (file) => file.path === "notiz.txt"
    );
    expect(listed).toMatchObject({ origin: "upload", updatedBy: { label: "Lena" } });

    // Save to project of the same file again: the name is taken by the same bytes.
    const saved = changeSchema.parse(
      (
        await t.expectOk(t.lena.id, "conversations.project_files.save", {
          params: { conversationId: chat },
          payload: { source: { fileId: landed.attachment.fileId }, path: "abgelegt/notiz.txt" }
        })
      ).json()
    );
    expect(saved).toMatchObject({ path: "abgelegt/notiz.txt", change: "created" });

    // A chat outside a project lands nothing.
    const outside = await startChat(t.lena.id, team);
    const plain = await t.call(t.lena.id, "conversations.draft_attachments.upload", {
      params: { conversationId: outside },
      headers: body.headers,
      payload: body.payload
    });
    expect(plain.json()).not.toHaveProperty("projectFile");
  });

  it("adds a project file to a chat only where everyone who reads the chat reads the project", async () => {
    await uploaded(t.kai.id, kaisPrivate.id, "entwurf.md", "privat");
    await uploaded(t.kai.id, otherShared.id, "fremd.md", "anderswo");
    const add = (conversationId: string, projectId: string, path: string) =>
      t.call(t.kai.id, "conversations.draft_attachments.add_from_project", {
        params: { conversationId },
        payload: { projectId, path }
      });
    // A team chat is read by every member; Kai's private project is read by Kai alone.
    const teamChat = await startChat(t.kai.id, team);
    const wider = await add(teamChat, kaisPrivate.id, "entwurf.md");
    expect(wider.statusCode).toBe(422);
    expect(reason(wider)).toBe("project_audience_wider");
    // A project of another workspace: its members are others.
    const elsewhere = await add(teamChat, otherShared.id, "fremd.md");
    expect(reason(elsewhere)).toBe("project_audience_wider");
    // A chat of the shared project and a file of Kai's private one: also wider.
    const projectChat = await startChat(t.kai.id, team, { projectId: shared.id });
    expect(reason(await add(projectChat, kaisPrivate.id, "entwurf.md"))).toBe(
      "project_audience_wider"
    );
    // Kai's private chat is read by Kai alone: any project of his comes in.
    const ownChat = await startChat(t.kai.id, team, { visibility: "private" });
    const allowed = await add(ownChat, kaisPrivate.id, "entwurf.md");
    expect(allowed.json()).not.toHaveProperty("error");
    // A team chat takes a file of a shared project of its own workspace.
    expect((await add(teamChat, shared.id, "liesmich.md")).json()).not.toHaveProperty("error");
    // Lena never learns a file of Kai's private project exists.
    const lenaChat = await startChat(t.lena.id, team, { visibility: "private" });
    const probe = await t.call(t.lena.id, "conversations.draft_attachments.add_from_project", {
      params: { conversationId: lenaChat },
      payload: { projectId: kaisPrivate.id, path: "entwurf.md" }
    });
    expect(probe.statusCode).toBe(404);
  });

  describe("the agent's file tools on project/", () => {
    let service: ProjectFileService;
    let run: ReturnType<typeof createTestToolRunner>;
    let toolNames: string[];
    const runs = new Map<string, AgentRunId>();

    beforeAll(() => {
      if (!config) throw new Error("The instance has no config");
      service = new ProjectFileService({
        stores: t.stores,
        clientInstanceId,
        config,
        modules: resolveInstanceModules(config, []).snapshot,
        logger: createLogger(),
        pages: { objects }
      });
      const workspaceObjects = new MemoryObjectStorage();
      const tools = createWorkspaceToolDefinitions({
        service: new WorkspaceCommandService({
          store: t.stores,
          objectStore: workspaceObjects,
          fileStore: workspaceObjects,
          projectFolder: service
        })
      });
      toolNames = tools.map((tool) => tool.name);
      run = createTestToolRunner({
        registry: new ToolRegistry({ tools }),
        getAgentToolNames: () => toolNames
      });
    });

    const person = (user: UserRecord): AuthenticatedUser => ({
      id: user.id,
      externalUserId: user.id,
      displayLabel: user.displayLabel,
      roles: user.roles,
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    });
    const contextOf = (user: UserRecord): ToolExecutionContext => ({
      clientInstanceId,
      correlationId: "corr_project_tools",
      user: person(user)
    });
    const runOf = async (conversationId: string): Promise<AgentRunId> => {
      const known = runs.get(conversationId);
      if (known) return known;
      const conversation = await t.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(conversationId)
      );
      if (!conversation) throw new Error("The chat is not there");
      const created = (await t.stores.createAgentRunForTesting(conversation)).id;
      runs.set(conversationId, created);
      return created;
    };
    const tool = async (
      user: UserRecord,
      conversationId: string,
      toolName: string,
      input: unknown
    ) =>
      resultSchema.parse(
        await run(
          {
            toolName,
            toolCallId: asToolCallId(`toolcall_${globalThis.crypto.randomUUID()}`),
            agentRunId: await runOf(conversationId),
            conversationId: asConversationId(conversationId),
            agentName: "assistant",
            input
          },
          contextOf(user)
        )
      );

    it("writes the folder as a new version, keeps a stale write as a conflict copy, and lists and reads it", async () => {
      const project = await createProject(t.kai.id, team, "Werkstatt");
      const kaisChat = await startChat(t.kai.id, team, { projectId: project.id });
      const lenasChat = await startChat(t.lena.id, team, { projectId: project.id });

      const created = await tool(t.kai, kaisChat, "workspace.write_file", {
        path: "project/checkliste.md",
        content: "- Angebot\n"
      });
      expect(created).toMatchObject({
        status: "success",
        output: {
          path: "project/checkliste.md",
          created: true,
          project: { projectId: project.id, path: "checkliste.md", version: 1, change: "created" }
        }
      });
      // A blind write over the file is refused: the agent reads it first.
      const blind = await tool(t.lena, lenasChat, "workspace.write_file", {
        path: "project/checkliste.md",
        content: "neu"
      });
      expect(blind.status).toBe("failed");
      expect(blind.error?.message).toContain("replacesVersion 1");

      const read = await tool(t.lena, lenasChat, "workspace.read_file", {
        path: "project/checkliste.md"
      });
      expect(read).toMatchObject({
        status: "success",
        output: { workspaceId: `project:${project.id}`, version: 1, contentPreview: "- Angebot\n" }
      });
      const edited = await tool(t.lena, lenasChat, "workspace.edit_file", {
        path: "project/checkliste.md",
        edits: [{ oldText: "- Angebot\n", newText: "- Angebot\n- Termin\n" }]
      });
      expect(edited).toMatchObject({
        output: { project: { version: 2, change: "updated", previousVersion: 1 } }
      });

      // Kai's agent still has v1 in mind: its write is kept beside the file.
      const stale = await tool(t.kai, kaisChat, "workspace.write_file", {
        path: "project/checkliste.md",
        content: "- Angebot\n- Rechnung\n",
        replacesVersion: 1
      });
      expect(stale).toMatchObject({
        status: "success",
        output: {
          project: {
            change: "conflict_copy",
            version: 1,
            changed: { path: "checkliste.md", version: 2 }
          }
        }
      });
      const copy = z.object({ project: z.object({ path: z.string() }) }).parse(stale.output)
        .project.path;
      expect(copy).toMatch(/^checkliste \(Konflikt Kai \d\d\.\d\d\. \d\d\.\d\d\)\.md$/u);
      expect((await content(t.kai.id, project.id, "checkliste.md")).body).toBe(
        "- Angebot\n- Termin\n"
      );

      const listed = await tool(t.kai, kaisChat, "workspace.list_files", {});
      expect(
        z
          .object({
            files: z.array(z.object({ path: z.string(), version: z.number().optional() }))
          })
          .parse(listed.output)
          .files.filter((file) => file.path.startsWith("project/"))
          .map((file) => [file.path, file.version])
      ).toEqual(
        expect.arrayContaining([
          ["project/checkliste.md", 2],
          [`project/${copy}`, 1]
        ])
      );
      const versions = versionsSchema.parse(
        (
          await t.expectOk(t.kai.id, "projects.files.versions", {
            params: { projectId: project.id },
            query: { path: "checkliste.md" }
          })
        ).json()
      );
      expect(versions.items.map((item) => item.by?.label)).toEqual(["Lena", "Kai"]);
    });

    it("reaches only the chat's own project, and nothing for a person outside its audience", async () => {
      const kaisChat = await startChat(t.kai.id, team, { projectId: kaisPrivate.id });
      // A path that names another project is a path in this one's folder: no way out.
      const escape = await tool(t.kai, kaisChat, "workspace.read_file", {
        path: "project/../../liesmich.md"
      });
      expect(escape.status).toBe("failed");
      // Lena runs in a chat of Kai's private project only if she reads it: she does not.
      expect(
        await service.folderOf({
          clientInstanceId,
          conversationId: kaisChat,
          user: person(t.lena)
        })
      ).toBeUndefined();
      // A chat outside any project has no folder: project/ is its own path as before.
      const outside = await startChat(t.kai.id, team);
      const local = await tool(t.kai, outside, "workspace.write_file", {
        path: "project/frei.md",
        content: "nur im Chat"
      });
      expect(local).toMatchObject({ status: "success", output: { created: true } });
      expect(local.output).not.toHaveProperty("project");
    });
  });
});
