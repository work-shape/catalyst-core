import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  asExecutionWorkspaceId,
  asManagedArtifactId,
  asWorkspaceCommandId,
  type WorkspaceCommand
} from "@vivd-catalyst/core";
import {
  LocalWorkspaceCommandRunner,
  shapeWorkspaceCommandOutput,
  workspaceExecInputJsonSchema,
  WorkspaceCommandWorker,
  type WorkspaceCommandTelemetry
} from "@vivd-catalyst/tool-execution";
import { createWorkspaceHarness, encode, TestArtifactPreviewGenerator } from "./workspace-tools-harness";

describe("workspace tools", () => {
  it("describes safe shell command shape to the model", async () => {
    const harness = await createWorkspaceHarness();
    const execTool = harness.tools.find((tool) => tool.name === "workspace.exec");

    expect(execTool?.description).toContain("Bash command from /workspace");
    expect(execTool?.description).toContain("Each call starts in /workspace");
    expect(execTool?.description).toContain("Files created or changed under /workspace persist");
    expect(execTool?.description).toContain("put `set -e` on its own line");
    expect(execTool?.description).toContain("`--view`, `--spec`, `--out`, `--range`, `--page`, or `--sheet`");
    expect(execTool?.description).toContain("`cat` or `ls`");
    expect(workspaceExecInputJsonSchema).toMatchObject({
      properties: {
        command: {
          description: expect.stringContaining("Complete Bash command")
        },
        cwd: {
          description: expect.stringContaining("does not persist")
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

    const hereDocHarness = await createWorkspaceHarness();
    const hereDoc = await hereDocHarness.runTool("workspace.exec", {
      command: [
        "mkdir -p scripts",
        "cat > scripts/notes.txt <<'EOF'",
        "cat --spec report.json --out report.pdf",
        "ls --range \"Summary!A1:H30\" source.xlsx",
        "EOF"
      ].join("\n")
    });
    expect(hereDoc.status).toBe("success");
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
