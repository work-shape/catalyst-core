import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asExecutionWorkspaceId,
  asManagedArtifactId,
  asManagedFileId,
  asToolCallId,
  asWorkspaceCommandId,
  StoreBackedAuditRecorder,
  type ClientInstanceId,
  type Conversation,
  type ToolExecutionContext,
  type WorkspaceCommand
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { createModelVisibleToolOutput } from "../packages/agent-runtime/src/model-context-projection";
import {
  createWorkspaceToolDefinitions,
  LocalWorkspaceCommandRunner,
  shapeWorkspaceCommandOutput,
  workspaceExecInputJsonSchema,
  WorkspaceCommandService,
  WorkspaceCommandWorker,
  type WorkspaceArtifactPreviewGenerator,
  type WorkspaceCommandTelemetry,
  type WorkspaceFileByteStore,
  type WorkspaceObjectStore
} from "@vivd-catalyst/tool-execution";
import { InProcessToolExecution, ToolRegistry } from "@vivd-catalyst/tool-execution";

describe("workspace tools", () => {
  it("describes safe shell command shape to the model", async () => {
    const harness = await createWorkspaceHarness();
    const execTool = harness.tools.find((tool) => tool.name === "workspace.exec");

    expect(execTool?.description).toContain("put `set -e` on its own line");
    expect(execTool?.description).toContain("`--view`, `--spec`, `--out`, `--range`, `--page`, or `--sheet`");
    expect(execTool?.description).toContain("`cat` or `ls`");
    expect(workspaceExecInputJsonSchema).toMatchObject({
      properties: {
        command: {
          description: expect.stringContaining("Do not pass helper flags")
        }
      }
    });
  });

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
      { command: "set -e -f" },
      "validation_failed",
      /shell setup without a command/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "set -e pptx_inspect deck.pptx --view summary" },
      "validation_failed",
      /set -e on its own line/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "set -e pptx_render deck.pptx --out previews/slides" },
      "validation_failed",
      /set -e on its own line/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "set -e pptx_render deck.pptx --out previews/slides && ls -lh deck.pptx" },
      "validation_failed",
      /set -e on its own line/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "set -e pptx_inspect deck.pptx --view summary; ls -lh deck.pptx" },
      "validation_failed",
      /set -e on its own line/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "cat -lh file.pptx" },
      "validation_failed",
      /Run the artifact helper directly/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "cat --view summary deck.pptx" },
      "validation_failed",
      /Run the artifact helper directly/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "cat --spec report.json --out report.pdf" },
      "validation_failed",
      /Run the artifact helper directly/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "ls --out previews/slides" },
      "validation_failed",
      /Run the artifact helper directly/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "ls --range \"Summary!A1:H30\" source.xlsx" },
      "validation_failed",
      /Run the artifact helper directly/u
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

    const strictScript = await createWorkspaceHarness();
    const strictQueued = await strictScript.runTool("workspace.exec", {
      command: "set -e\npptx_inspect deck.pptx --view summary"
    });
    expect(strictQueued.status).toBe("success");

    const directHelperHarness = await createWorkspaceHarness();
    const directHelper = await directHelperHarness.runTool("workspace.exec", {
      command: "pptx_render deck.pptx --out previews/slides"
    });
    expect(directHelper.status).toBe("success");

    const simpleCatHarness = await createWorkspaceHarness();
    const simpleCat = await simpleCatHarness.runTool("workspace.exec", {
      command: "cat notes.txt"
    });
    expect(simpleCat.status).toBe("success");

    const simpleLsHarness = await createWorkspaceHarness();
    const simpleLs = await simpleLsHarness.runTool("workspace.exec", {
      command: "ls -lh deck.pptx"
    });
    expect(simpleLs.status).toBe("success");
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

  it("records minimized workspace command queue audit and telemetry without command payloads", async () => {
    const telemetryEvents: Parameters<WorkspaceCommandTelemetry["record"]>[0][] = [];
    const harness = await createWorkspaceHarness({
      withAuditRecorder: true,
      telemetry: {
        record(event) {
          telemetryEvents.push(event);
        }
      }
    });

    const result = await harness.runTool("workspace.exec", {
      command: "printf 'do-not-audit-this-payload'",
      timeoutSeconds: 45
    });

    expect(result.status).toBe("success");
    const auditEvents = await harness.store.listAuditEvents({
      clientInstanceId: harness.clientInstanceId,
      limit: 20
    });
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "workspace_command.queued",
          status: "success",
          metadata: expect.objectContaining({
            timeoutSeconds: 45,
            expectedOutputCount: 0,
            cwdProvided: false
          })
        }),
        expect.objectContaining({
          type: "tool.completed",
          metadata: expect.objectContaining({
            auditAction: "workspace.exec",
            resultStatus: "success"
          })
        })
      ])
    );
    expect(JSON.stringify(auditEvents)).not.toContain("do-not-audit-this-payload");
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        type: "queued",
        status: "queued",
        activeCounts: expect.objectContaining({
          queued: 1
        })
      })
    );
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

  it("waits for a worker-backed workspace.exec result before returning to the model", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "workspace-tools-worker-"));
    const harness = await createWorkspaceHarness({
      execResultWaitMs: 5000,
      execResultPollIntervalMs: 10
    });
    const runner = new LocalWorkspaceCommandRunner({
      store: harness.store,
      byteStore: harness.objectStore,
      tempRootDirectory: tempRoot
    });
    const worker = new WorkspaceCommandWorker({
      clientInstanceId: harness.clientInstanceId,
      store: harness.store,
      runner,
      pollIntervalMs: 10,
      tempStateCleanupIntervalMs: 60_000
    });
    const workerLoop = worker.start();

    try {
      const result = await harness.runTool("workspace.exec", {
        command: "printf 'ready' > result.txt",
        expectedOutputs: [{ path: "result.txt" }]
      });

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error("Expected exec to succeed");
      }
      expect(result.output).toMatchObject({
        status: "completed",
        exitCode: 0,
        changedFiles: [expect.objectContaining({ path: "result.txt" })]
      });

      const read = await harness.runTool("workspace.read_file", { path: "result.txt" });
      expect(read.status).toBe("success");
      if (read.status !== "success") {
        throw new Error("Expected read_file to succeed");
      }
      expect(read.output.contentPreview).toBe("ready");
    } finally {
      await worker.stop({ cancelActive: true, reason: "test complete" });
      await workerLoop;
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails and cancels workspace.exec when no worker completes the command before the wait limit", async () => {
    const harness = await createWorkspaceHarness({
      execResultWaitMs: 20,
      execResultPollIntervalMs: 5
    });

    const result = await harness.runTool("workspace.exec", { command: "sleep 60" });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected exec to fail without a worker");
    }
    expect(result.error.message).toMatch(/did not complete/u);
    expect(result.error.details).toMatchObject({
      status: "cancelled"
    });
    const commandId = result.error.details?.commandId;
    expect(typeof commandId).toBe("string");
    const command = await harness.store.getWorkspaceCommand({
      clientInstanceId: harness.clientInstanceId,
      commandId: asWorkspaceCommandId(commandId as string)
    });
    expect(command?.status).toBe("cancelled");
  });

  it("returns terminal output when command completion races wait-expiry cancellation", async () => {
    const leaseToken = "race-lease";
    const harness = await createWorkspaceHarness({
      execResultWaitMs: 1,
      execResultPollIntervalMs: 1,
      serviceStore(store) {
        return new Proxy(store, {
          get(target, property, receiver) {
            if (property === "requestWorkspaceCommandCancellation") {
              return async (input: Parameters<typeof store.requestWorkspaceCommandCancellation>[0]) => {
                const claimed = await store.claimNextWorkspaceCommand({
                  clientInstanceId: input.clientInstanceId,
                  workerId: "race-worker",
                  leaseToken,
                  now: "2026-06-29T12:00:01.000Z",
                  leaseExpiresAt: "2026-06-29T12:05:01.000Z"
                });
                expect(claimed?.id).toBe(input.commandId);
                if (!claimed) {
                  throw new Error("Expected queued command to be claimable");
                }
                await store.completeWorkspaceCommand({
                  clientInstanceId: input.clientInstanceId,
                  commandId: input.commandId,
                  leaseToken,
                  output: shapeWorkspaceCommandOutput(
                    {
                      exitCode: 0,
                      stdout: "finished before cancellation",
                      stderr: "",
                      durationMs: 17
                    },
                    claimed.limits
                  ),
                  completedAt: "2026-06-29T12:00:02.000Z"
                });
                return store.requestWorkspaceCommandCancellation(input);
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      }
    });

    const result = await harness.runTool("workspace.exec", {
      command: "printf 'finished before cancellation'"
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected exec to return the raced terminal command");
    }
    expect(result.output).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdoutPreview: "finished before cancellation",
      stderrPreview: "",
      durationMs: 17
    });
    const command = await harness.store.getWorkspaceCommand({
      clientInstanceId: harness.clientInstanceId,
      commandId: asWorkspaceCommandId(result.output.commandId)
    });
    expect(command?.status).toBe("completed");
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

  it("imports uploaded managed files into workspace storage without leaking object keys", async () => {
    const sourceBytes = new TextEncoder().encode("name,total\nAda,42\n");
    const harness = await createWorkspaceHarness({
      sourceFiles: {
        file_source_csv: {
          filename: "source.csv",
          mimeType: "text/csv",
          bytes: sourceBytes
        }
      }
    });

    const imported = await harness.runTool("workspace.import_files", {
      files: [{ fileId: "file_source_csv", path: "inputs/source.csv" }]
    });

    expect(imported.status).toBe("success");
    if (imported.status !== "success") {
      throw new Error("Expected import_files to succeed");
    }
    expect(imported.output).toMatchObject({
      workspaceId: expect.any(String),
      importedFiles: [
        {
          fileId: "file_source_csv",
          path: "inputs/source.csv",
          filename: "source.csv",
          byteSize: sourceBytes.byteLength,
          mimeType: "text/csv"
        }
      ]
    });
    expect(JSON.stringify(imported)).not.toContain("objectKey");

    const workspaceFiles = await harness.store.listWorkspaceFiles({
      clientInstanceId: harness.clientInstanceId,
      workspaceId: asExecutionWorkspaceId(imported.output.workspaceId)
    });
    expect(workspaceFiles).toEqual([
      expect.objectContaining({
        path: "inputs/source.csv",
        byteSize: sourceBytes.byteLength,
        mimeType: "text/csv",
        metadata: expect.objectContaining({
          source: "managed_file_upload",
          sourceFileId: "file_source_csv",
          filename: "source.csv"
        })
      })
    ]);
    const storedBytes = await harness.objectStore.getObject(workspaceFiles[0]!.objectKey);
    expect(new TextDecoder().decode(storedBytes)).toBe("name,total\nAda,42\n");
  });

  it("projects workspace command changed files without raw object storage keys", async () => {
    const harness = await createWorkspaceHarness({
      commandResults: {
        async resolveWorkspaceCommand({ command }) {
          return {
            ...command,
            status: "completed",
            output: shapeWorkspaceCommandOutput(
              {
                exitCode: 0,
                stdout: "created report",
                stderr: "",
                durationMs: 12,
                changedFiles: [
                  {
                    path: "reports/final.csv",
                    objectKey: "execution-workspaces/private/final.csv",
                    byteSize: 12,
                    checksum: "sha256:final",
                    mimeType: "text/csv"
                  }
                ]
              },
              command.limits
            )
          } satisfies WorkspaceCommand;
        }
      }
    });

    const executed = await harness.runTool("workspace.exec", {
      command: "node scripts/build-report.js"
    });

    expect(executed.status).toBe("success");
    if (executed.status !== "success") {
      throw new Error("Expected exec to succeed");
    }
    expect(executed.output.changedFiles).toEqual([
      {
        path: "reports/final.csv",
        byteSize: 12,
        checksum: "sha256:final",
        mimeType: "text/csv"
      }
    ]);
    expect(JSON.stringify(executed)).not.toContain("objectKey");
    expect(JSON.stringify(executed)).not.toContain("execution-workspaces/private");
  });

  it("promotes a workspace file as a managed artifact while unpromoted files stay hidden", async () => {
    const harness = await createWorkspaceHarness();
    await harness.putWorkspaceFile({
      path: "reports/final.docx",
      objectKey: "workspace/reports/final.docx",
      bytes: "docx-preview",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
    await harness.putWorkspaceFile({
      path: "reports/draft.pdf",
      objectKey: "workspace/reports/draft.pdf",
      bytes: "%PDF-draft",
      mimeType: "application/pdf"
    });

    const promoted = await harness.runTool("workspace.promote_artifact", {
      path: "reports/final.docx",
      kind: "document.docx",
      filename: "final.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });

    expect(promoted.status).toBe("success");
    if (promoted.status !== "success") {
      throw new Error("Expected promote_artifact to succeed");
    }
    expect(promoted.artifacts).toHaveLength(1);
    expect(promoted.artifacts?.[0]).toMatchObject({
      artifactId: promoted.output?.artifactId,
      kind: "document.docx",
      filename: "final.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
    const artifact = await harness.store.getManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      artifactId: promoted.artifacts![0]!.artifactId
    });
    expect(artifact).toMatchObject({
      kind: "document.docx",
      objectKey: "workspace/reports/final.docx",
      filename: "final.docx"
    });
    const previewJob = await harness.store.getArtifactPreviewJob({
      clientInstanceId: harness.clientInstanceId,
      sourceArtifactId: promoted.artifacts![0]!.artifactId
    });
    expect(previewJob).toMatchObject({
      status: "pending",
      conversationId: harness.conversation.id,
      sourceChecksum: "sha256:reports/final.docx",
      sourceMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
        path: "reports/final.docx",
        promotedArtifacts: [
          expect.objectContaining({
            artifactId: promoted.output?.artifactId,
            kind: "document.docx"
          })
        ]
      })
    ]);
  });

  it("attaches derived image-page previews when explicitly promoting office artifacts", async () => {
    const previewGenerator = new TestArtifactPreviewGenerator([
      {
        bytes: encode("slide-1"),
        filename: "deck-slide-1.png",
        mimeType: "image/png",
        slideNumber: 1
      }
    ]);
    const harness = await createWorkspaceHarness({ artifactPreviewGenerator: previewGenerator });
    await harness.putWorkspaceFile({
      path: "deck.pptx",
      objectKey: "workspace/deck.pptx",
      bytes: "pptx-bytes",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    });

    const promoted = await harness.runTool("workspace.promote_artifact", {
      path: "deck.pptx",
      kind: "presentation.pptx",
      filename: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    });

    expect(promoted.status).toBe("success");
    if (promoted.status !== "success") {
      throw new Error("Expected promote_artifact to succeed");
    }
    expect(previewGenerator.calls).toEqual([
      expect.objectContaining({
        filename: "deck.pptx",
        kind: "presentation.pptx",
        previewKind: "presentation"
      })
    ]);
    expect(promoted.artifacts?.[0]?.metadata).toMatchObject({
      preview: {
        type: "image_pages",
        format: "png",
        pages: [
          expect.objectContaining({
            filename: "deck-slide-1.png",
            kind: "presentation.preview_slide_image",
            mimeType: "image/png",
            slideNumber: 1
          })
        ]
      }
    });
    expect(promoted.output?.metadata).toEqual({
      preview: promoted.artifacts?.[0]?.metadata?.preview
    });
    const previewPage = promoted.artifacts?.[0]?.metadata?.preview?.pages[0];
    const previewArtifact = await harness.store.getManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      artifactId: asManagedArtifactId(previewPage!.artifactId)
    });
    expect(previewArtifact).toMatchObject({
      kind: "presentation.preview_slide_image",
      objectKey: expect.stringContaining("deck-slide-1.png"),
      metadata: expect.objectContaining({
        source: "execution_workspace",
        workspacePath: "deck.pptx",
        previewRole: "slide_image"
      })
    });
    await expect(harness.objectStore.getObject(previewArtifact!.objectKey)).resolves.toEqual(encode("slide-1"));
  });

  it("loads ready preview images as model-visible artifacts without exposing internal storage", async () => {
    const harness = await createWorkspaceHarness();
    const source = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "document.pdf",
      objectKey: "execution-workspaces/private/report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 128,
      checksum: "sha256:report"
    });
    const previewBytes = encode("page-1-png");
    harness.objectStore.putObject("artifact-previews/private/report-page-1.png", previewBytes);
    const previewPage = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "document.preview_page_image",
      objectKey: "artifact-previews/private/report-page-1.png",
      filename: "report-page-1.png",
      mimeType: "image/png",
      byteSize: previewBytes.byteLength,
      checksum: "sha256:preview-page-1",
      metadata: {
        sourceArtifactId: source.id,
        previewRole: "page",
        pageNumber: 1
      }
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: source.id,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: previewPage.id,
          mimeType: "image/png",
          pageNumber: 1,
          width: 640,
          height: 480
        }
      ],
      writtenAt: "2026-06-29T12:02:00.000Z"
    });

    const result = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      pages: [1],
      maxImages: 1
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected preview_images to succeed");
    }
    expect(result.output).toEqual({
      artifactId: source.id,
      status: "ready",
      maxImages: 1,
      images: [
        {
          sourceArtifactId: source.id,
          imageArtifactId: previewPage.id,
          mimeType: "image/png",
          status: "ready",
          pageNumber: 1,
          width: 640,
          height: 480
        }
      ],
      warnings: []
    });
    expect(result.artifacts).toEqual([
      {
        artifactId: previewPage.id,
        kind: "document.preview_page_image",
        filename: "report-page-1.png",
        mimeType: "image/png",
        modelVisibility: {
          type: "image",
          mimeType: "image/png"
        },
        metadata: {
          sourceArtifactId: source.id,
          status: "ready",
          pageNumber: 1,
          width: 640,
          height: 480
        }
      }
    ]);
    expect(JSON.stringify(result)).not.toContain("objectKey");
    expect(JSON.stringify(result)).not.toContain("artifact-previews/private");

    const modelOutput = await createModelVisibleToolOutput(result, {
      clientInstanceId: harness.clientInstanceId,
      toolOutput: { maxTokens: 60_000 },
      artifactReader: {
        async readArtifact(input) {
          const artifact = await harness.store.getManagedArtifact({
            clientInstanceId: input.clientInstanceId,
            artifactId: input.artifactId
          });
          if (!artifact) {
            throw new Error("Missing artifact");
          }
          return {
            bytes: await harness.objectStore.getObject(artifact.objectKey),
            mimeType: artifact.mimeType
          };
        }
      }
    });
    expect(Array.isArray(modelOutput.content)).toBe(true);
    const imageParts = Array.isArray(modelOutput.content)
      ? modelOutput.content.filter((part) => part.type === "image")
      : [];
    expect(imageParts).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: previewBytes
      }
    ]);
    expect(modelOutput.text).toContain("[Visual context loaded]");
    expect(modelOutput.text).toContain("page: 1");
    expect(modelOutput.text).toContain("size: 640x480");
  });

  it("loads ready spreadsheet sheet and range previews as model-visible artifacts", async () => {
    const harness = await createWorkspaceHarness();
    const source = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.xlsx",
      objectKey: "execution-workspaces/private/workbook.xlsx",
      filename: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 128,
      checksum: "sha256:workbook"
    });
    const previewBytes = encode("summary-range-png");
    harness.objectStore.putObject("artifact-previews/private/workbook-summary-range.png", previewBytes);
    const previewRange = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.preview_range_image",
      objectKey: "artifact-previews/private/workbook-summary-range.png",
      filename: "workbook-summary-range.png",
      mimeType: "image/png",
      byteSize: previewBytes.byteLength,
      checksum: "sha256:preview-range",
      metadata: {
        sourceArtifactId: source.id,
        previewRole: "range",
        sheet: "Summary",
        range: "Summary!A1:H10"
      }
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: source.id,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: previewRange.id,
          mimeType: "image/png",
          sheet: "Summary",
          range: "Summary!A1:H10",
          width: 900,
          height: 520
        }
      ],
      writtenAt: "2026-06-29T12:02:00.000Z"
    });

    const result = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      sheets: ["Summary"],
      ranges: ["Summary!A1:H10"],
      maxImages: 1
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected preview_images to succeed");
    }
    expect(result.output).toEqual({
      artifactId: source.id,
      status: "ready",
      maxImages: 1,
      images: [
        {
          sourceArtifactId: source.id,
          imageArtifactId: previewRange.id,
          mimeType: "image/png",
          status: "ready",
          sheet: "Summary",
          range: "Summary!A1:H10",
          width: 900,
          height: 520
        }
      ],
      warnings: []
    });
    expect(result.artifacts).toEqual([
      {
        artifactId: previewRange.id,
        kind: "spreadsheet.preview_range_image",
        filename: "workbook-summary-range.png",
        mimeType: "image/png",
        modelVisibility: {
          type: "image",
          mimeType: "image/png"
        },
        metadata: {
          sourceArtifactId: source.id,
          status: "ready",
          sheet: "Summary",
          range: "Summary!A1:H10",
          width: 900,
          height: 520
        }
      }
    ]);

    const modelOutput = await createModelVisibleToolOutput(result, {
      clientInstanceId: harness.clientInstanceId,
      toolOutput: { maxTokens: 60_000 },
      artifactReader: {
        async readArtifact(input) {
          const artifact = await harness.store.getManagedArtifact({
            clientInstanceId: input.clientInstanceId,
            artifactId: input.artifactId
          });
          if (!artifact) {
            throw new Error("Missing artifact");
          }
          return {
            bytes: await harness.objectStore.getObject(artifact.objectKey),
            mimeType: artifact.mimeType
          };
        }
      }
    });
    const imageParts = Array.isArray(modelOutput.content)
      ? modelOutput.content.filter((part) => part.type === "image")
      : [];
    expect(imageParts).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: previewBytes
      }
    ]);
    expect(JSON.stringify(result)).not.toContain("objectKey");
    expect(JSON.stringify(result)).not.toContain("artifact-previews/private");
  });

  it("canonicalizes unqualified spreadsheet ranges with a single sheet selector", async () => {
    const harness = await createWorkspaceHarness();
    const source = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.xlsx",
      objectKey: "execution-workspaces/private/workbook.xlsx",
      filename: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 128,
      checksum: "sha256:workbook"
    });

    const pending = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      sheets: ["Summary"],
      ranges: ["A1:B4"],
      maxImages: 1
    });
    expect(pending.status).toBe("success");
    if (pending.status !== "success") {
      throw new Error("Expected pending preview_images result");
    }
    expect(pending.output).toMatchObject({
      artifactId: source.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });

    const previewBytes = encode("summary-a1-b4-png");
    harness.objectStore.putObject("artifact-previews/private/workbook-summary-a1-b4.png", previewBytes);
    const previewRange = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.preview_range_image",
      objectKey: "artifact-previews/private/workbook-summary-a1-b4.png",
      filename: "workbook-summary-a1-b4.png",
      mimeType: "image/png",
      byteSize: previewBytes.byteLength,
      checksum: "sha256:preview-summary-a1-b4",
      metadata: {
        sourceArtifactId: source.id,
        previewRole: "range",
        sheet: "Summary",
        range: "Summary!A1:B4"
      }
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: source.id,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: previewRange.id,
          mimeType: "image/png",
          sheet: "Summary",
          range: "Summary!A1:B4",
          width: 400,
          height: 240
        }
      ]
    });

    const ready = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      sheets: ["Summary"],
      ranges: ["A1:B4"],
      maxImages: 1
    });

    expect(ready.status).toBe("success");
    if (ready.status !== "success") {
      throw new Error("Expected ready preview_images result");
    }
    expect(ready.output).toEqual({
      artifactId: source.id,
      status: "ready",
      maxImages: 1,
      images: [
        {
          sourceArtifactId: source.id,
          imageArtifactId: previewRange.id,
          mimeType: "image/png",
          status: "ready",
          sheet: "Summary",
          range: "Summary!A1:B4",
          width: 400,
          height: 240
        }
      ],
      warnings: []
    });
    expect(ready.artifacts).toEqual([
      expect.objectContaining({
        artifactId: previewRange.id,
        modelVisibility: {
          type: "image",
          mimeType: "image/png"
        },
        metadata: expect.objectContaining({
          sheet: "Summary",
          range: "Summary!A1:B4"
        })
      })
    ]);
  });

  it("rejects selector requests that exceed maxImages before queueing", async () => {
    const harness = await createWorkspaceHarness();
    const source = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.xlsx",
      objectKey: "execution-workspaces/private/workbook.xlsx",
      filename: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 128,
      checksum: "sha256:workbook"
    });

    const result = await harness.runTool("workspace.preview_images", {
      artifactId: source.id,
      sheets: ["Summary", "Detail"],
      ranges: ["Summary!A1:B4", "Detail!A1:B4"],
      maxImages: 1
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") {
      throw new Error("Expected selector validation failure");
    }
    expect(result.error).toMatchObject({
      code: "handler_failed",
      message: "workspace.preview_images selector count exceeds maxImages"
    });
    await expect(
      harness.store.getArtifactPreviewJob({
        clientInstanceId: harness.clientInstanceId,
        sourceArtifactId: source.id
      })
    ).resolves.toBeUndefined();
  });

  it("attaches image artifacts directly as model-visible preview images", async () => {
    const harness = await createWorkspaceHarness();
    const image = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "image.png",
      objectKey: "execution-workspaces/private/chart.png",
      filename: "chart.png",
      mimeType: "image/png",
      byteSize: 16,
      checksum: "sha256:chart"
    });

    const result = await harness.runTool("workspace.preview_images", {
      artifactId: image.id,
      maxImages: 1
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected preview_images to succeed");
    }
    expect(result.output).toEqual({
      artifactId: image.id,
      status: "ready",
      maxImages: 1,
      images: [
        {
          sourceArtifactId: image.id,
          imageArtifactId: image.id,
          mimeType: "image/png",
          status: "ready"
        }
      ],
      warnings: []
    });
    expect(result.artifacts).toEqual([
      {
        artifactId: image.id,
        kind: "image.png",
        filename: "chart.png",
        mimeType: "image/png",
        modelVisibility: {
          type: "image",
          mimeType: "image/png"
        },
        metadata: {
          sourceArtifactId: image.id,
          status: "ready"
        }
      }
    ]);
  });

  it("queues selector-specific previews when an existing manifest does not cover the request", async () => {
    const harness = await createWorkspaceHarness();
    const pdf = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "document.pdf",
      objectKey: "execution-workspaces/private/report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 128,
      checksum: "sha256:report"
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: pdf.id,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: asManagedArtifactId("art_pdf_page_1"),
          mimeType: "image/png",
          pageNumber: 1
        }
      ]
    });

    const pdfPage2 = await harness.runTool("workspace.preview_images", {
      artifactId: pdf.id,
      pages: [2],
      maxImages: 1
    });
    expect(pdfPage2.status).toBe("success");
    if (pdfPage2.status !== "success") {
      throw new Error("Expected pending PDF preview result");
    }
    expect(pdfPage2.output).toMatchObject({
      artifactId: pdf.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });

    const deck = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "presentation.pptx",
      objectKey: "execution-workspaces/private/deck.pptx",
      filename: "deck.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      byteSize: 128,
      checksum: "sha256:deck"
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: deck.id,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: asManagedArtifactId("art_deck_slide_1"),
          mimeType: "image/png",
          slideNumber: 1
        }
      ]
    });

    const slide2 = await harness.runTool("workspace.preview_images", {
      artifactId: deck.id,
      slides: [2],
      maxImages: 1
    });
    expect(slide2.status).toBe("success");
    if (slide2.status !== "success") {
      throw new Error("Expected pending slide preview result");
    }
    expect(slide2.output).toMatchObject({
      artifactId: deck.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });

    const workbook = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.xlsx",
      objectKey: "execution-workspaces/private/workbook.xlsx",
      filename: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 128,
      checksum: "sha256:workbook"
    });
    await harness.store.writeArtifactPreviewManifest({
      status: "ready",
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      sourceArtifactId: workbook.id,
      type: "image_pages",
      format: "png",
      pages: [
        {
          artifactId: asManagedArtifactId("art_summary_range"),
          mimeType: "image/png",
          sheet: "Summary",
          range: "Summary!A1:H10"
        }
      ]
    });

    const detail = await harness.runTool("workspace.preview_images", {
      artifactId: workbook.id,
      sheets: ["Detail"],
      ranges: ["Detail!A1:H10"],
      maxImages: 1
    });
    expect(detail.status).toBe("success");
    if (detail.status !== "success") {
      throw new Error("Expected pending spreadsheet preview result");
    }
    expect(detail.output).toMatchObject({
      artifactId: workbook.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });
    expect(JSON.stringify([pdfPage2, slide2, detail])).not.toContain("selection_empty");
  });

  it("reports pending and unsupported preview states without attaching images", async () => {
    const harness = await createWorkspaceHarness();
    const document = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "document.docx",
      objectKey: "execution-workspaces/private/report.docx",
      filename: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      byteSize: 128,
      checksum: "sha256:report-docx"
    });
    const pending = await harness.runTool("workspace.preview_images", {
      artifactId: document.id
    });
    expect(pending.status).toBe("success");
    if (pending.status !== "success") {
      throw new Error("Expected pending preview_images result");
    }
    expect(pending.output).toMatchObject({
      artifactId: document.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });
    expect(pending.artifacts).toBeUndefined();

    const workbook = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "spreadsheet.xlsx",
      objectKey: "execution-workspaces/private/workbook.xlsx",
      filename: "workbook.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      byteSize: 128,
      checksum: "sha256:workbook"
    });
    const workbookPending = await harness.runTool("workspace.preview_images", {
      artifactId: workbook.id,
      sheets: ["Summary"]
    });
    expect(workbookPending.status).toBe("success");
    if (workbookPending.status !== "success") {
      throw new Error("Expected pending workbook preview_images result");
    }
    expect(workbookPending.output).toMatchObject({
      artifactId: workbook.id,
      status: "pending",
      images: [],
      warnings: [expect.objectContaining({ code: "preview_pending" })]
    });
    expect(workbookPending.artifacts).toBeUndefined();

    const archive = await harness.store.createManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      kind: "archive.zip",
      objectKey: "execution-workspaces/private/archive.zip",
      filename: "archive.zip",
      mimeType: "application/zip",
      byteSize: 128,
      checksum: "sha256:archive"
    });
    const unsupported = await harness.runTool("workspace.preview_images", {
      artifactId: archive.id
    });
    expect(unsupported.status).toBe("success");
    if (unsupported.status !== "success") {
      throw new Error("Expected unsupported preview_images result");
    }
    expect(unsupported.output).toMatchObject({
      artifactId: archive.id,
      status: "unsupported",
      images: [],
      errorCode: "unsupported_type",
      warnings: [expect.objectContaining({ code: "unsupported_type" })]
    });
    expect(unsupported.artifacts).toBeUndefined();
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
  artifactPreviewGenerator?: WorkspaceArtifactPreviewGenerator;
  commandResults?: ConstructorParameters<typeof WorkspaceCommandService>[0]["commandResults"];
  execResultWaitMs?: ConstructorParameters<typeof WorkspaceCommandService>[0]["execResultWaitMs"];
  execResultPollIntervalMs?: ConstructorParameters<typeof WorkspaceCommandService>[0]["execResultPollIntervalMs"];
  limits?: ConstructorParameters<typeof WorkspaceCommandService>[0]["limits"];
  serviceStore?: (
    store: InMemoryPlatformStore
  ) => ConstructorParameters<typeof WorkspaceCommandService>[0]["store"];
  telemetry?: WorkspaceCommandTelemetry;
  withAuditRecorder?: boolean;
  sourceFiles?: Record<
    string,
    {
      filename: string;
      mimeType?: string;
      bytes: Uint8Array;
    }
  >;
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
  const auditRecorder = input.withAuditRecorder
    ? new StoreBackedAuditRecorder({ clientInstanceId, store })
    : undefined;
  const service = new WorkspaceCommandService({
    store: input.serviceStore?.(store) ?? store,
    objectStore,
    ...(input.sourceFiles || input.artifactPreviewGenerator
      ? {
          fileStore: objectStore,
          ...(input.artifactPreviewGenerator ? { artifactPreviewGenerator: input.artifactPreviewGenerator } : {}),
          ...(input.sourceFiles ? {
          sourceFileReader: {
            async readSourceFile(readInput) {
              const source = input.sourceFiles?.[readInput.fileId];
              if (!source) {
                throw new Error("Managed source file is not available");
              }
              return {
                fileId: asManagedFileId(readInput.fileId),
                filename: source.filename,
                ...(source.mimeType ? { mimeType: source.mimeType } : {}),
                byteSize: source.bytes.byteLength,
                bytes: source.bytes
              };
            }
          }
          } : {})
        }
      : {}),
    ...(input.commandResults ? { commandResults: input.commandResults } : {}),
    ...(auditRecorder ? { auditRecorder } : {}),
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    limits: input.limits,
    execResultWaitMs: input.execResultWaitMs ?? 0,
    execResultPollIntervalMs: input.execResultPollIntervalMs,
    now: () => "2026-06-29T12:00:00.000Z"
  });
  const tools = createWorkspaceToolDefinitions({ service });
  const agentToolNames = input.agentToolNames ?? tools.map((tool) => tool.name);
  const execution = new InProcessToolExecution({
    registry: new ToolRegistry({ tools }),
    getAgentToolNames: () => agentToolNames,
    ...(auditRecorder ? { auditRecorder } : {})
  });
  const context = createToolContext(clientInstanceId);
  return {
    clientInstanceId,
    ownerUserId,
    store,
    conversation,
    objectStore,
    tools,
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

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

class TestArtifactPreviewGenerator implements WorkspaceArtifactPreviewGenerator {
  readonly calls: Parameters<WorkspaceArtifactPreviewGenerator["generatePreviewImages"]>[0][] = [];

  constructor(
    private readonly images: Awaited<
      ReturnType<WorkspaceArtifactPreviewGenerator["generatePreviewImages"]>
    >
  ) {}

  async generatePreviewImages(
    input: Parameters<WorkspaceArtifactPreviewGenerator["generatePreviewImages"]>[0]
  ) {
    this.calls.push(input);
    return this.images;
  }
}

class TestWorkspaceObjectStore implements WorkspaceFileByteStore, WorkspaceObjectStore {
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

  async putWorkspaceFile(input: Parameters<WorkspaceFileByteStore["putWorkspaceFile"]>[0]) {
    const objectKey = [
      "execution-workspaces",
      input.clientInstanceId,
      input.conversationId,
      input.workspaceId,
      input.commandId,
      input.path
    ].join("/");
    this.putObject(objectKey, input.bytes);
    return { objectKey };
  }
}
