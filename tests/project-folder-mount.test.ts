import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  asUserId,
  asToolCallId,
  authenticatedUserFromRecord,
  createPlatformId,
  StoreBackedAuditRecorder,
  type CollaborationWorkspaceId,
  type ProjectCommandFolderPort,
  type UserRecord,
  type WorkspaceCommand
} from "@work-shape/catalyst-core";
import { createLogger, resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { ProjectFileService } from "@work-shape/catalyst-server";
import {
  DockerWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandRunner,
  WorkspaceCommandService,
  workspaceExecOutputSchema,
  type WorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { inlineCommandResults } from "./support/workspace-command-jobs";

// PRJ-4: real shell writes over the same ProjectFileService and version store as the file tools.
const ON = { projects: { enabled: true } };
const image = process.env.CATALYST_RUNNER_IMAGE;
const roots: string[] = [];
let t: AccessInstance;
let config: ClientInstanceConfig;
let team: CollaborationWorkspaceId;
let files: ProjectFileService;

beforeAll(async () => {
  const objects = new MemoryObjectStorage();
  t = await setupAccessInstance({
    modules: ON,
    server: (_stores, current) => {
      config = current;
      return { pages: { objects } };
    }
  });
  team = (
    await t.stores.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Mounts",
      creatorUserId: t.kai.id
    })
  ).id;
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: team,
    userId: t.lena.id,
    role: "member"
  });
  await t.expectOk(t.kai.id, "projects.list", { params: { collaborationWorkspaceId: team } });
  files = new ProjectFileService({
    stores: t.stores,
    clientInstanceId,
    config,
    modules: resolveInstanceModules(config, []).snapshot,
    logger: createLogger(),
    pages: { objects }
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
afterAll(async () => {
  await t?.instance.close();
});

async function project(audience: "workspace" | "private" = "workspace") {
  return z.object({ id: z.string() }).parse(
    (
      await t.expectOk(t.kai.id, "projects.create", {
        payload: { collaborationWorkspaceId: team, title: "Project mount", audience }
      })
    ).json()
  ).id;
}

async function chat(projectId?: string, person: UserRecord = t.kai) {
  const project = projectId
    ? await t.stores.projects.getProject({ clientInstanceId, projectId })
    : undefined;
  const conversation = await t.stores.conversations.createConversation({
    clientInstanceId,
    collaborationWorkspaceId: team,
    visibility: project?.audience ?? "workspace",
    createdByUserId: person.id,
    createdByExternalUserId: person.id,
    title: "Mount chat",
    retainedUntil: "2027-01-01T00:00:00.000Z",
    ...(projectId ? { projectId } : {})
  });
  return { conversation, run: await t.stores.createAgentRunForTesting(conversation) };
}
type Chat = Awaited<ReturnType<typeof chat>>;

async function harness(
  input: {
    executor?: WorkspaceCommandProcessExecutor;
    port?: ProjectCommandFolderPort;
    root?: string;
  } = {}
) {
  const root = input.root ?? (await mkdtemp(join(tmpdir(), "catalyst-project-mount-test-")));
  if (!input.root) roots.push(root);
  const bytes = new MemoryObjectStorage();
  const runner = new LocalWorkspaceCommandRunner({
    store: t.stores,
    byteStore: bytes,
    tempRootDirectory: root,
    reuseWorkspaceDirectories: true,
    projectFolders: input.port ?? files,
    ...(input.executor ? { processExecutor: input.executor } : {}),
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: t.stores.audit })
  });
  async function exec(
    c: Chat,
    command: string,
    withRun = true,
    timeoutSeconds = 30
  ): Promise<WorkspaceCommand> {
    const workspace = await t.stores.executionWorkspaces.ensureExecutionWorkspace({
      clientInstanceId,
      conversationId: c.conversation.id,
      ownerUserId: c.run.ownerUserId ?? ""
    });
    const queued = await t.stores.executionWorkspaces.enqueueWorkspaceCommand({
      clientInstanceId,
      workspaceId: workspace.id,
      ownerUserId: c.run.ownerUserId ?? "",
      ...(withRun ? { agentRunId: c.run.id } : {}),
      command,
      limits: { timeoutSeconds },
      expectedOutputs: []
    });
    const held = await t.stores.executionWorkspaces.claimWorkspaceCommand({
      clientInstanceId,
      commandId: queued.id,
      leaseOwnerId: "project-mount-test",
      leaseToken: crypto.randomUUID(),
      leaseMs: 60_000
    });
    if (held.status !== "claimed") throw new Error("Command not claimed");
    return runner.runClaimedCommand(held.row);
  }
  const service = new WorkspaceCommandService({
    store: t.stores,
    objectStore: bytes,
    commandResults: inlineCommandResults(t.stores, { runner })
  });
  return { root, runner, exec, service };
}

const folder = async (c: Chat) => {
  const found = await files.folderOfCommand({
    clientInstanceId,
    conversationId: c.conversation.id,
    ownerUserId: c.run.ownerUserId ?? "",
    agentRunId: c.run.id
  });
  if (!found) throw new Error("No project folder");
  return found.folder;
};
const seed = async (c: Chat, path: string, text: string, replaces = 0) =>
  files.write(await folder(c), {
    path,
    bytes: Buffer.from(text),
    userId: c.run.ownerUserId ?? "",
    replaces,
    runId: c.run.id
  });
const text = async (c: Chat, path: string) => {
  const read = await files.read(await folder(c), path);
  return read ? Buffer.from(read.bytes).toString() : undefined;
};

for (const docker of [false, true]) {
  describe.skipIf(docker && !image)(docker ? "Docker project mount" : "local project copy", () => {
    const start = () =>
      harness(
        docker
          ? { executor: new DockerWorkspaceCommandProcessExecutor({ image: image ?? "" }) }
          : {}
      );

    it("writes versions as the run, scans deletions separately and leaves unchanged files alone", async () => {
      const c = await chat(await project());
      await seed(c, "input.md", "original");
      await seed(c, "delete.md", "gone");
      const h = await start();
      const result = await h.exec(
        c,
        [
          "set -eu",
          'test "$(cat project/input.md)" = original',
          "printf changed > project/input.md",
          "rm project/delete.md",
          "mkdir -p project/project",
          "printf new > project/project/new.txt",
          "printf chat > chat.txt"
        ].join("\n")
      );
      expect(result.status, JSON.stringify(result.error)).toBe("completed");
      expect(result.output?.exitCode).toBe(0);
      expect(await text(c, "input.md")).toBe("changed");
      expect(await text(c, "project/new.txt")).toBe("new");
      expect(await text(c, "delete.md")).toBeUndefined();
      expect(result.output?.projectFileChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "input.md", version: 2, change: "updated" }),
          expect.objectContaining({ path: "delete.md", version: 2, change: "deleted" }),
          expect.objectContaining({ path: "project/new.txt", version: 1, change: "created" })
        ])
      );
      expect(result.output?.changedFiles.map((f) => f.path)).toEqual(["chat.txt"]);
      expect(
        await t.stores.executionWorkspaces.listWorkspaceFiles({
          clientInstanceId,
          workspaceId: result.workspaceId
        })
      ).toEqual([expect.objectContaining({ path: "chat.txt" })]);
      expect(
        (
          await t.stores.projectFiles.listProjectFileVersions({
            clientInstanceId,
            projectId: c.conversation.projectId ?? "",
            path: "input.md"
          })
        )[0]
      ).toMatchObject({
        version: 2,
        runId: c.run.id,
        conversationId: c.conversation.id,
        origin: "agent"
      });
      const tool = await h.service.exec(
        { command: "printf tool > project/from-tool.md\nprintf blocked > project/AGENTS.md" },
        {
          clientInstanceId,
          correlationId: "project-tool-result",
          user: authenticatedUserFromRecord({
            user: t.kai,
            identity: { authSource: "test", externalUserId: t.kai.id }
          }),
          toolRequest: {
            toolName: "workspace.exec",
            agentName: "test_agent",
            toolCallId: asToolCallId(crypto.randomUUID()),
            agentRunId: c.run.id,
            conversationId: c.conversation.id,
            input: {}
          }
        }
      );
      expect(tool.status, JSON.stringify(tool)).toBe("success");
      if (tool.status !== "success") throw new Error(JSON.stringify(tool));
      expect(tool.output, JSON.stringify(tool)).toMatchObject({ status: "completed", exitCode: 0 });
      expect(
        workspaceExecOutputSchema.parse(tool.output).projectFileChanges,
        JSON.stringify(tool)
      ).toContainEqual(
        expect.objectContaining({ path: "from-tool.md", version: 1, change: "created" })
      );
      expect(workspaceExecOutputSchema.parse(tool.output).projectFileWarnings).toEqual([
        "AGENTS.md ändert der Agent nur über die Bestätigung"
      ]);
      expect(await text(c, "AGENTS.md")).toBeUndefined();
      const unchanged = await h.exec(c, "test -f project/input.md");
      expect(unchanged.output?.projectFileChanges).toBeUndefined();
      const events = await t.stores.audit.listAuditEvents({
        clientInstanceId,
        type: "workspace_command.completed",
        limit: 100
      });
      const audited = events.find((event) => event.subject === result.id)?.metadata
        ?.projectFileChanges;
      expect(audited).toEqual(
        result.output?.projectFileChanges?.map((change) => ({
          projectId: change.projectId,
          version: change.version,
          change: change.change
        }))
      );
      expect(JSON.stringify(audited)).not.toContain("input.md");
    });

    it.each(["replace", "delete"])(
      "keeps top-level AGENTS.md unchanged on %s and reports the confirmation rule",
      async (change) => {
        const c = await chat(await project());
        await seed(c, "AGENTS.md", "approved instructions");
        const h = await start();
        const result = await h.exec(
          c,
          [
            "set -eu",
            change === "delete" ? "rm project/AGENTS.md" : "printf unapproved > project/AGENTS.md",
            "mkdir -p project/notes",
            "printf ordinary > project/notes/AGENTS.md"
          ].join("\n")
        );
        expect(result.status, JSON.stringify(result.error)).toBe("completed");
        expect(result.output?.projectFileWarnings).toEqual([
          "AGENTS.md ändert der Agent nur über die Bestätigung"
        ]);
        expect(await text(c, "AGENTS.md")).toBe("approved instructions");
        expect(await text(c, "notes/AGENTS.md")).toBe("ordinary");
        expect(
          await t.stores.projectFiles.listProjectFileVersions({
            clientInstanceId,
            projectId: c.conversation.projectId ?? "",
            path: "AGENTS.md"
          })
        ).toHaveLength(1);
        expect(result.output?.projectFileChanges?.some((file) => file.path === "AGENTS.md")).toBe(
          false
        );
      }
    );

    it("saves the chat and project changes left by a timed-out command", async () => {
      const c = await chat(await project());
      const h = await start();
      const result = await h.exec(
        c,
        "printf partial > project/partial.md\nprintf chat > chat.txt\nsleep 30",
        true,
        2
      );
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("WORKSPACE_COMMAND_TIMEOUT");
      expect(await text(c, "partial.md")).toBe("partial");
      expect(result.output?.projectFileChanges).toContainEqual(
        expect.objectContaining({ path: "partial.md", version: 1 })
      );
      expect(
        await t.stores.executionWorkspaces.listWorkspaceFiles({
          clientInstanceId,
          workspaceId: result.workspaceId
        })
      ).toContainEqual(expect.objectContaining({ path: "chat.txt" }));
    });

    it("provides no project folder without a readable project or a person's run", async () => {
      const id = await project("private");
      const allowed = await chat(id);
      await seed(allowed, "secret.md", "secret");
      const h = await start();
      const noMount = docker
        ? "! grep -q ' /workspace/project ' /proc/self/mountinfo"
        : "test ! -e project";
      for (const c of [await chat(), await chat(id, t.lena)]) {
        const denied = await h.exec(c, noMount);
        expect(denied.output?.exitCode, JSON.stringify(denied.error)).toBe(0);
        expect(denied.output?.projectFileChanges).toBeUndefined();
      }
      const noRun = await h.exec(allowed, noMount, false);
      expect(noRun.output?.exitCode).toBe(0);
      // A command reusing a hydrated workspace must not see the previous project's snapshot.
      expect((await h.exec(allowed, "test -f project/secret.md")).output?.exitCode).toBe(0);
      const reused = await h.exec(allowed, `${noMount} && test ! -f project/secret.md`, false);
      expect(reused.output?.exitCode, JSON.stringify(reused)).toBe(0);
    });
  });
}

describe("project snapshot writeback", () => {
  it("preserves concurrent edits as a conflict copy and drops a stale deletion", async () => {
    const id = await project();
    const first = await chat(id);
    const second = await chat(id, t.lena);
    await seed(first, "plan.md", "original");
    await seed(first, "delete.md", "original");
    const local = new LocalWorkspaceCommandProcessExecutor();
    const other = await harness();
    const h = await harness({
      executor: {
        async execute(input) {
          const result = await local.execute(input);
          expect(
            (
              await other.exec(
                second,
                "printf other > project/plan.md\nprintf keep > project/delete.md"
              )
            ).status
          ).toBe("completed");
          return result;
        }
      }
    });
    const result = await h.exec(first, "printf mine > project/plan.md\nrm project/delete.md");
    expect(result.status, JSON.stringify(result.error)).toBe("completed");
    expect(await text(first, "plan.md")).toBe("other");
    expect(await text(first, "delete.md")).toBe("keep");
    const copy = result.output?.projectFileChanges?.find(
      (change) => change.change === "conflict_copy"
    );
    expect(copy).toMatchObject({ changed: { path: "plan.md", version: 2 }, version: 1 });
    expect(copy?.path).toContain("Konflikt Kai");
    expect(await text(first, copy?.path ?? "")).toBe("mine");
    expect(result.output?.projectFileChanges).toHaveLength(1);
  });

  it("reads bytes from the host cache, verifies it and never shares writable copies", async () => {
    const c = await chat(await project());
    await seed(c, "cached.md", "original");
    const read = vi.spyOn(files, "readVersion");
    const first = await harness();
    expect((await first.exec(c, "cat project/cached.md")).output?.stdoutPreview).toBe("original");
    // A second worker on the same host shares the cache, even with another worker id.
    const second = await harness({ root: first.root });
    expect((await second.exec(c, "cat project/cached.md")).output?.stdoutPreview).toBe("original");
    expect(read).toHaveBeenCalledTimes(1);
    await first.exec(c, "printf updated > project/cached.md");
    expect((await first.exec(c, "cat project/cached.md")).output?.stdoutPreview).toBe("updated");
    expect(read).toHaveBeenCalledTimes(2);
    for (const entry of await readdir(join(first.root, "catalyst-project-files"))) {
      await writeFile(join(first.root, "catalyst-project-files", entry), "tampered");
    }
    expect((await second.exec(c, "cat project/cached.md")).output?.stdoutPreview).toBe("updated");
    expect(read).toHaveBeenCalledTimes(3);
    const cleaned = await second.runner.cleanupIdleWorkspaceDirectories({
      olderThanMs: 0,
      now: new Date(Date.now() + 1000)
    });
    expect(cleaned.failedCount).toBe(0);
    expect(await readdir(join(first.root, "catalyst-project-files"))).toEqual([]);
  });

  it("rejects links in the project scan and never scans project/ into conversation files", async () => {
    const c = await chat(await project());
    const h = await harness();
    const linked = await h.exec(c, "ln -s / project/outside\nprintf chat > own.txt");
    expect(linked.status).toBe("failed");
    expect(linked.error?.code).toBe("WORKSPACE_SYMLINK_REJECTED");
    expect(linked.output?.projectFileWarnings).toContain(
      "Project changes could not be saved (WORKSPACE_SYMLINK_REJECTED). Conversation files were saved."
    );
    expect(await files.list(await folder(c))).toEqual([]);
    expect(linked.output?.changedFiles).toContainEqual(
      expect.objectContaining({ path: "own.txt" })
    );
    expect(
      await t.stores.executionWorkspaces.listWorkspaceFiles({
        clientInstanceId,
        workspaceId: linked.workspaceId
      })
    ).toContainEqual(expect.objectContaining({ path: "own.txt" }));
    const noProject = await chat();
    const skipped = await h.exec(
      noProject,
      "mkdir project\nprintf ignore > project/file.txt\nprintf keep > own.txt"
    );
    expect(skipped.output?.changedFiles.map((file) => file.path)).toEqual(["own.txt"]);
  });

  it("rechecks access before saving when membership was revoked during the command", async () => {
    const c = await chat(await project(), t.lena);
    const local = new LocalWorkspaceCommandProcessExecutor();
    const h = await harness({
      executor: {
        async execute(input) {
          const result = await local.execute(input);
          await t.stores.workspaces.removeMembership({
            clientInstanceId,
            collaborationWorkspaceId: team,
            userId: asUserId(t.lena.id)
          });
          return result;
        }
      }
    });
    try {
      const result = await h.exec(c, "printf private > project/late.txt");
      expect(result.error?.code).toBe("WORKSPACE_PROJECT_MOUNT_FAILED");
      expect(
        await t.stores.projectFiles.listProjectFiles({
          clientInstanceId,
          projectId: c.conversation.projectId ?? ""
        })
      ).toEqual([]);
    } finally {
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: t.lena.id,
        role: "member"
      });
    }
  });

  it("gives a real child run its root chat's folder through the root execution workspace", async () => {
    const root = await chat(await project());
    const started = await t.stores.childAgentRuns.startSubagentRun({
      clientInstanceId,
      parentRunId: root.run.id,
      parentOperationRunId: createPlatformId<"OperationRunId">("oprun"),
      agentName: "assistant",
      description: "Child",
      task: "Write a project file",
      correlationId: "project-mount-child"
    });
    if (started.status !== "started") throw new Error("No child run");
    const conversation = await t.stores.conversations.getConversation(
      clientInstanceId,
      started.threadId
    );
    if (!conversation) throw new Error("No child thread");
    const h = await harness();
    const result = await h.exec(
      { conversation, run: started.run },
      "printf child > project/child.md"
    );
    expect(result.status, JSON.stringify(result.error)).toBe("completed");
    expect(started.run.conversationId).toBe(started.threadId);
    expect(result.conversationId).toBe(root.conversation.id);
    expect(result.agentRunId).toBe(started.run.id);
    expect(await text(root, "child.md")).toBe("child");
    expect(
      (
        await t.stores.projectFiles.listProjectFileVersions({
          clientInstanceId,
          projectId: root.conversation.projectId ?? "",
          path: "child.md"
        })
      )[0]
    ).toMatchObject({ runId: started.run.id, conversationId: root.conversation.id });
    const unrelated = await chat(await project());
    expect(
      await files.folderOfCommand({ ...result, conversationId: unrelated.conversation.id })
    ).toBeUndefined();
  });

  it("gives a Workflow step run no project mount", async () => {
    const c = await chat(await project());
    vi.spyOn(t.stores.agentRuns, "getAgentRun").mockResolvedValue({
      ...c.run,
      workflowStepRunId: "workflow-step"
    });
    const h = await harness();
    expect((await h.exec(c, "test ! -e project")).output?.exitCode).toBe(0);
  });

  it("fails without project deletions when a Docker snapshot directory disappears", async () => {
    const c = await chat(await project());
    await seed(c, "keep.md", "original");
    const local = new LocalWorkspaceCommandProcessExecutor();
    const h = await harness({
      executor: {
        mountsProjectFolder: true,
        async execute(input) {
          const result = await local.execute(input);
          if (!input.projectDirectory) throw new Error("Missing bind source");
          await rm(input.projectDirectory, { recursive: true });
          return result;
        }
      }
    });
    const result = await h.exec(c, "printf chat > chat.txt");
    expect(result.error?.code).toBe("WORKSPACE_PROJECT_MOUNT_FAILED");
    expect(await text(c, "keep.md")).toBe("original");
    expect(
      await t.stores.projectFiles.listProjectFileVersions({
        clientInstanceId,
        projectId: c.conversation.projectId ?? "",
        path: "keep.md"
      })
    ).toHaveLength(1);
    expect(result.output?.projectFileChanges).toBeUndefined();
    expect(result.output?.changedFiles).toContainEqual(
      expect.objectContaining({ path: "chat.txt" })
    );
  });

  it("records local removal of the project directory as deletions except for AGENTS.md", async () => {
    const c = await chat(await project());
    await seed(c, "delete.md", "original");
    await seed(c, "AGENTS.md", "approved");
    const h = await harness();
    const result = await h.exec(c, "rm -rf project");
    expect(result.status, JSON.stringify(result.error)).toBe("completed");
    expect(result.output?.projectFileChanges).toEqual([
      expect.objectContaining({ path: "delete.md", change: "deleted", version: 2 })
    ]);
    expect(await text(c, "delete.md")).toBeUndefined();
    expect(await text(c, "AGENTS.md")).toBe("approved");
    expect(result.output?.projectFileWarnings).toEqual([
      "AGENTS.md ändert der Agent nur über die Bestätigung"
    ]);
  });
});
