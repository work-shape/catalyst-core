import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asToolCallId,
  type ClientInstanceId,
  type Conversation,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import {
  createWorkspaceToolDefinitions,
  shapeWorkspaceCommandOutput,
  WorkspaceCommandService,
  type WorkspaceObjectStore
} from "@vivd-catalyst/tool-execution";
import { InProcessToolExecution, ToolRegistry } from "@vivd-catalyst/tool-execution";

describe("workspace tools", () => {
  it("validates command, cwd, timeout, expected outputs, and path traversal", async () => {
    const valid = await createWorkspaceHarness();
    const queued = await valid.runTool("workspace.exec", {
      command: "node scripts/build-report.js",
      cwd: "reports",
      timeoutSeconds: 120,
      expectedOutputs: [{ path: "reports/output.txt", kind: "text/plain", promote: true }]
    });
    expect(queued.status).toBe("success");
    if (queued.status !== "success") {
      throw new Error("Expected queued command");
    }
    expect(queued.output).toMatchObject({
      status: "queued",
      limits: {
        timeoutSeconds: 120,
        idleTimeoutSeconds: 30,
        maxStdoutBytes: 65536,
        maxStderrBytes: 65536,
        maxWorkspaceBytes: 104857600
      },
      stdoutPreview: "",
      stderrPreview: "",
      changedFiles: [],
      promotedArtifacts: []
    });

    await expectToolFailure(
      "workspace.exec",
      { command: "   " },
      "validation_failed",
      /blank/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "pwd", cwd: "../outside" },
      "validation_failed",
      /traverse/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "sleep 1", timeoutSeconds: 301 },
      "validation_failed",
      /timeout/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "echo ok", expectedOutputs: [{ path: "/tmp/out.txt" }] },
      "validation_failed",
      /relative/u
    );
    await expectToolFailure(
      "workspace.read_file",
      { path: "../secret.txt" },
      "validation_failed",
      /traverse/u
    );
    await expectToolFailure(
      "workspace.promote_artifact",
      { path: "../secret.txt" },
      "validation_failed",
      /traverse/u
    );
  });

  it("enforces agent allowlists through in-process tool execution", async () => {
    const harness = await createWorkspaceHarness({
      agentToolNames: ["workspace.list_files"]
    });
    const request = harness.createRequest("workspace.exec", { command: "pwd" });

    const decision = await harness.execution.authorize(request, harness.context);

    expect(decision).toMatchObject({
      status: "denied",
      reason: "Agent 'workspace_agent' is not allowed to use 'workspace.exec'"
    });
  });

  it("checks per-conversation, per-user, and global workspace command concurrency", async () => {
    const conversationScoped = await createWorkspaceHarness({
      limits: {
        perConversationActiveCommands: 1,
        perUserActiveCommands: 10,
        globalActiveCommands: 10
      }
    });
    await conversationScoped.runTool("workspace.exec", { command: "sleep 1" });
    const sameConversation = await conversationScoped.runTool("workspace.exec", { command: "sleep 2" });
    expect(sameConversation.status).toBe("failed");
    if (sameConversation.status === "failed") {
      expect(sameConversation.error.message).toMatch(/conversation/u);
    }

    const userScoped = await createWorkspaceHarness({
      limits: {
        perConversationActiveCommands: 10,
        perUserActiveCommands: 1,
        globalActiveCommands: 10
      }
    });
    await userScoped.seedActiveCommand({ ownerUserId: userScoped.ownerUserId });
    const sameUser = await userScoped.runTool("workspace.exec", { command: "sleep 1" });
    expect(sameUser.status).toBe("failed");
    if (sameUser.status === "failed") {
      expect(sameUser.error.message).toMatch(/user/u);
    }

    const globalScoped = await createWorkspaceHarness({
      limits: {
        perConversationActiveCommands: 10,
        perUserActiveCommands: 10,
        globalActiveCommands: 1
      }
    });
    await globalScoped.seedActiveCommand({ ownerUserId: "other-user" });
    const globallyBlocked = await globalScoped.runTool("workspace.exec", { command: "sleep 1" });
    expect(globallyBlocked.status).toBe("failed");
    if (globallyBlocked.status === "failed") {
      expect(globallyBlocked.error.message).toMatch(/global/u);
    }
  });

  it("does not let concurrent workspace.exec calls both pass when conversation capacity is one", async () => {
    const harness = await createWorkspaceHarness({
      limits: {
        perConversationActiveCommands: 1,
        perUserActiveCommands: 10,
        globalActiveCommands: 10
      }
    });

    const results = await Promise.all([
      harness.runTool("workspace.exec", { command: "sleep 1" }),
      harness.runTool("workspace.exec", { command: "sleep 2" })
    ]);

    expect(results.filter((result) => result.status === "success")).toHaveLength(1);
    const failed = results.find((result) => result.status === "failed");
    expect(failed?.status).toBe("failed");
    if (failed?.status === "failed") {
      expect(failed.error.message).toMatch(/conversation/u);
      expect(failed.error.details).toMatchObject({
        scope: "conversation",
        activeCommands: 1,
        limit: 1
      });
    }
  });

  it("lists internal workspace files without exposing them as tool artifacts", async () => {
    const harness = await createWorkspaceHarness();
    await harness.putWorkspaceFile({
      path: "internal/notes.txt",
      objectKey: "workspace/internal/notes.txt",
      bytes: "private notes",
      mimeType: "text/plain"
    });

    const result = await harness.runTool("workspace.list_files", {});

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected list_files to succeed");
    }
    expect(result.artifacts).toBeUndefined();
    expect(result.output).toMatchObject({
      files: [
        {
          path: "internal/notes.txt",
          byteSize: 13,
          mimeType: "text/plain"
        }
      ]
    });
  });

  it("reads bounded text previews and rejects binary or oversized files", async () => {
    const harness = await createWorkspaceHarness({
      limits: {
        maxReadFileBytes: 64,
        maxReadPreviewBytes: 12
      }
    });
    await harness.putWorkspaceFile({
      path: "notes/long.txt",
      objectKey: "workspace/notes/long.txt",
      bytes: "abcdefghijklmnopqrstuvwxyz",
      mimeType: "text/plain"
    });
    await harness.putWorkspaceFile({
      path: "bin/blob.dat",
      objectKey: "workspace/bin/blob.dat",
      bytes: new Uint8Array([0, 1, 2, 3]),
      mimeType: "application/octet-stream"
    });
    await harness.putWorkspaceFile({
      path: "large.txt",
      objectKey: "workspace/large.txt",
      bytes: "x".repeat(80),
      mimeType: "text/plain"
    });

    const preview = await harness.runTool("workspace.read_file", { path: "notes/long.txt" });
    expect(preview.status).toBe("success");
    if (preview.status !== "success") {
      throw new Error("Expected read_file to succeed");
    }
    expect(preview.output).toMatchObject({
      path: "notes/long.txt",
      contentPreview: "abcdefghijkl",
      truncated: true
    });

    const binary = await harness.runTool("workspace.read_file", { path: "bin/blob.dat" });
    expect(binary.status).toBe("failed");
    if (binary.status === "failed") {
      expect(binary.error.message).toMatch(/binary|MIME/u);
    }

    const oversized = await harness.runTool("workspace.read_file", { path: "large.txt" });
    expect(oversized.status).toBe("failed");
    if (oversized.status === "failed") {
      expect(oversized.error.message).toMatch(/too large/u);
    }
  });

  it("promotes a workspace file as a managed artifact while unpromoted files stay hidden", async () => {
    const harness = await createWorkspaceHarness();
    await harness.putWorkspaceFile({
      path: "reports/final.pdf",
      objectKey: "workspace/reports/final.pdf",
      bytes: "%PDF-preview",
      mimeType: "application/pdf"
    });
    await harness.putWorkspaceFile({
      path: "reports/draft.pdf",
      objectKey: "workspace/reports/draft.pdf",
      bytes: "%PDF-draft",
      mimeType: "application/pdf"
    });

    const promoted = await harness.runTool("workspace.promote_artifact", {
      path: "reports/final.pdf",
      kind: "document.pdf",
      filename: "final.pdf",
      mimeType: "application/pdf"
    });

    expect(promoted.status).toBe("success");
    if (promoted.status !== "success") {
      throw new Error("Expected promote_artifact to succeed");
    }
    expect(promoted.artifacts).toHaveLength(1);
    expect(promoted.artifacts?.[0]).toMatchObject({
      artifactId: promoted.output?.artifactId,
      kind: "document.pdf",
      filename: "final.pdf",
      mimeType: "application/pdf"
    });
    const artifact = await harness.store.getManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      artifactId: promoted.artifacts![0]!.artifactId
    });
    expect(artifact).toMatchObject({
      kind: "document.pdf",
      objectKey: "workspace/reports/final.pdf",
      filename: "final.pdf"
    });

    const listed = await harness.runTool("workspace.list_files", {});
    expect(listed.status).toBe("success");
    if (listed.status !== "success") {
      throw new Error("Expected list_files to succeed");
    }
    expect(listed.artifacts).toBeUndefined();
    expect(listed.output?.files).toEqual([
      expect.objectContaining({
        path: "reports/draft.pdf",
        promotedArtifacts: undefined
      }),
      expect.objectContaining({
        path: "reports/final.pdf",
        promotedArtifacts: [
          expect.objectContaining({
            artifactId: promoted.output?.artifactId,
            kind: "document.pdf"
          })
        ]
      })
    ]);
  });

  it("shapes command stdout and stderr to configured bounds", () => {
    const output = shapeWorkspaceCommandOutput(
      {
        exitCode: 0,
        stdout: "a".repeat(20),
        stderr: "short",
        durationMs: 25,
        changedFiles: [{ path: "out.txt", byteSize: 3, checksum: "sha256:out" }]
      },
      {
        timeoutSeconds: 60,
        maxStdoutBytes: 5,
        maxStderrBytes: 64
      }
    );

    expect(output).toMatchObject({
      exitCode: 0,
      stdoutPreview: "aaaaa",
      stderrPreview: "short",
      truncated: {
        stdout: true,
        stderr: false
      },
      changedFiles: [{ path: "out.txt", byteSize: 3, checksum: "sha256:out" }]
    });
  });
});

async function expectToolFailure(
  toolName: string,
  input: unknown,
  code: string,
  message: RegExp
) {
  const harness = await createWorkspaceHarness();
  const result = await harness.runTool(toolName, input);
  expect(result.status).toBe("failed");
  if (result.status === "failed") {
    expect(result.error.code).toBe(code);
    expect(result.error.message).toMatch(message);
  }
}

async function createWorkspaceHarness(input: {
  agentToolNames?: string[];
  limits?: ConstructorParameters<typeof WorkspaceCommandService>[0]["limits"];
} = {}) {
  const clientInstanceId = asClientInstanceId(`workspace_tools_${globalThis.crypto.randomUUID()}`);
  const ownerUserId = "user-1";
  const store = new InMemoryPlatformStore();
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId,
    ownerExternalUserId: ownerUserId,
    title: "Workspace tools test",
    retainedUntil: "2026-07-29T00:00:00.000Z"
  });
  const objectStore = new TestWorkspaceObjectStore();
  const service = new WorkspaceCommandService({
    store,
    objectStore,
    limits: input.limits,
    now: () => "2026-06-29T12:00:00.000Z"
  });
  const tools = createWorkspaceToolDefinitions({ service });
  const agentToolNames = input.agentToolNames ?? tools.map((tool) => tool.name);
  const execution = new InProcessToolExecution({
    registry: new ToolRegistry({ tools }),
    getAgentToolNames: () => agentToolNames
  });
  const context = createToolContext(clientInstanceId);
  return {
    clientInstanceId,
    ownerUserId,
    store,
    conversation,
    objectStore,
    execution,
    context,
    createRequest(toolName: string, requestInput: unknown) {
      return createToolRequest(conversation, toolName, requestInput);
    },
    async runTool(toolName: string, requestInput: unknown) {
      const request = createToolRequest(conversation, toolName, requestInput);
      const decision = await execution.authorize(request, context);
      if (decision.status !== "allowed") {
        return {
          status: "failed" as const,
          error: {
            code: "not_allowed" as const,
            message: decision.reason
          }
        };
      }
      return execution.execute({ ...request, authorization: decision }, context);
    },
    async putWorkspaceFile(file: {
      path: string;
      objectKey: string;
      bytes: string | Uint8Array;
      mimeType?: string;
    }) {
      const workspace = await store.ensureExecutionWorkspace({
        clientInstanceId,
        conversationId: conversation.id,
        ownerUserId,
        now: "2026-06-29T12:00:00.000Z"
      });
      const bytes = typeof file.bytes === "string" ? new TextEncoder().encode(file.bytes) : file.bytes;
      objectStore.putObject(file.objectKey, bytes);
      return store.upsertWorkspaceFile({
        clientInstanceId,
        workspaceId: workspace.id,
        path: file.path,
        objectKey: file.objectKey,
        byteSize: bytes.byteLength,
        checksum: `sha256:${file.path}`,
        mimeType: file.mimeType,
        updatedAt: "2026-06-29T12:01:00.000Z"
      });
    },
    async seedActiveCommand(seed: { ownerUserId: string }) {
      const seededConversation = await store.createConversation({
        clientInstanceId,
        ownerUserId: seed.ownerUserId,
        ownerExternalUserId: seed.ownerUserId,
        title: "Seeded active command",
        retainedUntil: "2026-07-29T00:00:00.000Z"
      });
      const workspace = await store.ensureExecutionWorkspace({
        clientInstanceId,
        conversationId: seededConversation.id,
        ownerUserId: seed.ownerUserId,
        now: "2026-06-29T12:00:00.000Z"
      });
      return store.enqueueWorkspaceCommand({
        clientInstanceId,
        workspaceId: workspace.id,
        ownerUserId: seed.ownerUserId,
        command: "sleep 60",
        limits: { timeoutSeconds: 60 },
        queuedAt: "2026-06-29T12:02:00.000Z"
      });
    }
  };
}

function createToolContext(clientInstanceId: ClientInstanceId): ToolExecutionContext {
  return {
    clientInstanceId,
    correlationId: "corr_workspace_tools",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "Workspace Tools User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
}

function createToolRequest(conversation: Conversation, toolName: string, input: unknown) {
  return {
    toolName,
    toolCallId: asToolCallId(`toolcall_${globalThis.crypto.randomUUID()}`),
    agentRunId: asAgentRunId(`run_${globalThis.crypto.randomUUID()}`),
    conversationId: conversation.id,
    agentName: "workspace_agent",
    input
  };
}

class TestWorkspaceObjectStore implements WorkspaceObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  putObject(key: string, body: Uint8Array): void {
    this.objects.set(key, body);
  }

  async getObject(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Object '${key}' not found`);
    }
    return object;
  }
}
