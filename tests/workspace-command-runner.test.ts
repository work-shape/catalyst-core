import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asExecutionWorkspaceId,
  asManagedArtifactId,
  asToolCallId,
  asWorkspaceCommandId,
  StoreBackedAuditRecorder,
  type ClientInstanceId,
  type Conversation,
  type ToolExecutionContext,
  type WorkspaceCommandLimits
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import {
  createLocalWorkspaceFileByteStore,
  createObjectStoreWorkspaceFileByteStore,
  LocalWorkspaceCommandResultSource,
  LocalWorkspaceCommandRunner,
  normalizeWorkspaceFilePath,
  WorkspaceCommandService,
  type WorkspaceArtifactPreviewGenerator,
  type WorkspaceCommandTelemetry,
  type WorkspaceObjectStorage
} from "@vivd-catalyst/tool-execution";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  cleanupDirectories.length = 0;
});

describe("local workspace command runner", () => {
  it("runs Bash script-first workflows from the workspace root and persists generated files", async () => {
    const harness = await createRunnerHarness();

    const built = await harness.exec({
      command: [
        "mkdir -p scripts artifacts",
        "touch scripts/empty.txt",
        "export REPORT_NAME=alpha",
        "cat > scripts/build-report.bash <<'BASH'",
        "set -euo pipefail",
        "mkdir -p artifacts",
        "echo \"$REPORT_NAME\" | tr '[:lower:]' '[:upper:]' > artifacts/report.txt",
        "printf 'script stderr\\n' >&2",
        "BASH",
        "bash scripts/build-report.bash",
        "printf 'script stdout\\n'"
      ].join("\n")
    });

    expect(built.status).toBe("success");
    if (built.status !== "success") {
      throw new Error("Expected Bash workflow to succeed");
    }
    expect(built.output).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdoutPreview: "script stdout\n",
      stderrPreview: "script stderr\n",
      changedFiles: expect.arrayContaining([
        expect.objectContaining({ path: "artifacts/report.txt", mimeType: "text/plain" }),
        expect.objectContaining({ path: "scripts/build-report.bash" }),
        expect.objectContaining({ path: "scripts/empty.txt" })
      ])
    });

    const report = await harness.service.readFile({ path: "artifacts/report.txt" }, harness.context);
    expect(report.status).toBe("success");
    if (report.status !== "success") {
      throw new Error("Expected report to be readable");
    }
    expect(report.output?.contentPreview).toBe("ALPHA\n");
  });

  it("starts each workspace.exec call from the workspace root instead of a persisted cwd", async () => {
    const harness = await createRunnerHarness();

    const nested = await harness.exec({
      command: "mkdir -p nested && cd nested && printf 'inside' > inside.txt"
    });
    expect(nested.status).toBe("success");
    if (nested.status !== "success") {
      throw new Error("Expected nested command to succeed");
    }

    const rootDefault = await harness.exec({
      command: "test -f nested/inside.txt && test ! -e inside.txt && printf 'root' > root.txt"
    });

    expect(rootDefault.status).toBe("success");
    if (rootDefault.status !== "success") {
      throw new Error("Expected default cwd command to succeed");
    }
    expect(rootDefault.output).toMatchObject({
      status: "completed",
      exitCode: 0,
      changedFiles: [expect.objectContaining({ path: "root.txt", byteSize: 4 })]
    });
  });

  it("does not source persisted Bash login profiles before later workspace commands", async () => {
    const harness = await createRunnerHarness();

    const profile = await harness.exec({
      command: [
        "mkdir -p nested",
        "cat > .bash_profile <<'BASH'",
        "cd nested",
        "export PROFILE_RAN=1",
        "BASH"
      ].join("\n")
    });
    expect(profile.status).toBe("success");
    if (profile.status !== "success") {
      throw new Error("Expected profile seed command to succeed");
    }

    const next = await harness.exec({
      command: [
        "test \"${PROFILE_RAN-unset}\" = \"unset\"",
        "printf 'root\\n' > profile-check.txt"
      ].join("\n")
    });

    expect(next.status).toBe("success");
    if (next.status !== "success") {
      throw new Error("Expected non-login Bash command to succeed");
    }
    expect(next.output).toMatchObject({
      status: "completed",
      changedFiles: [expect.objectContaining({ path: "profile-check.txt" })]
    });
    expect(next.output.changedFiles).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "nested/profile-check.txt" })])
    );

    const check = await harness.service.readFile({ path: "profile-check.txt" }, harness.context);
    expect(check.status).toBe("success");
    if (check.status !== "success") {
      throw new Error("Expected profile check file to be readable");
    }
    expect(check.output?.contentPreview).toBe("root\n");
  });

  it("runs commands through an explicit local result source and persists files across disposable execution directories", async () => {
    const harness = await createRunnerHarness();

    const created = await harness.exec({
      command: "printf 'alpha' > notes.txt"
    });
    expect(created.status).toBe("success");
    if (created.status !== "success") {
      throw new Error("Expected create command to succeed");
    }
    expect(created.output).toMatchObject({
      status: "completed",
      exitCode: 0,
      changedFiles: [
        expect.objectContaining({
          path: "notes.txt",
          byteSize: 5,
          mimeType: "text/plain"
        })
      ]
    });
    await expect(harness.commandExecutionDirectories()).resolves.toEqual([]);

    const modified = await harness.exec({
      command: "cat notes.txt > previous.txt && printf '%s' '-beta' >> notes.txt"
    });
    expect(modified.status).toBe("success");
    if (modified.status !== "success") {
      throw new Error("Expected modify command to succeed");
    }
    expect(modified.output).toMatchObject({
      status: "completed",
      changedFiles: expect.arrayContaining([
        expect.objectContaining({ path: "notes.txt", byteSize: 10 }),
        expect.objectContaining({ path: "previous.txt", byteSize: 5 })
      ])
    });

    const notes = await harness.service.readFile({ path: "notes.txt" }, harness.context);
    expect(notes.status).toBe("success");
    if (notes.status !== "success") {
      throw new Error("Expected notes to be readable");
    }
    expect(notes.output?.contentPreview).toBe("alpha-beta");
  });

  it("persists file deletion across later workspace hydrations", async () => {
    const harness = await createRunnerHarness();

    const created = await harness.exec({
      command: "printf 'alpha' > notes.txt"
    });
    expect(created.status).toBe("success");
    if (created.status !== "success") {
      throw new Error("Expected create command to succeed");
    }
    const workspace = await harness.workspace();
    const beforeDelete = await harness.store.listWorkspaceFiles({
      clientInstanceId: harness.clientInstanceId,
      workspaceId: workspace.id
    });
    const createdFile = beforeDelete.find((file) => file.path === "notes.txt");
    expect(createdFile?.objectKey).toEqual(expect.any(String));

    const deleted = await harness.exec({
      command: "rm notes.txt"
    });
    expect(deleted.status).toBe("success");
    if (deleted.status !== "success") {
      throw new Error("Expected delete command to succeed");
    }
    expect(deleted.output).toMatchObject({
      status: "completed",
      exitCode: 0,
      changedFiles: []
    });
    await expect(
      harness.byteStore.getObject(createdFile!.objectKey).then((bytes) => new TextDecoder().decode(bytes))
    ).resolves.toBe("alpha");

    const listedAfterDelete = await harness.store.listWorkspaceFiles({
      clientInstanceId: harness.clientInstanceId,
      workspaceId: workspace.id
    });
    expect(listedAfterDelete.map((file) => file.path)).not.toContain("notes.txt");
    await expect(
      harness.service.readFile({ path: "notes.txt" }, harness.context)
    ).resolves.toMatchObject({
      status: "failed",
      error: {
        code: "handler_failed",
        message: "Workspace file 'notes.txt' was not found"
      }
    });

    const later = await harness.exec({
      command: "test ! -e notes.txt && printf 'still gone' > after-delete.txt"
    });
    expect(later.status).toBe("success");
    if (later.status !== "success") {
      throw new Error("Expected later command to succeed");
    }
    expect(later.output).toMatchObject({
      status: "completed",
      changedFiles: [expect.objectContaining({ path: "after-delete.txt" })]
    });
  });

  it("syncs changed files when the shell command exits non-zero", async () => {
    const harness = await createRunnerHarness();

    const result = await harness.exec({
      command: "printf 'partial' > failed.txt; exit 7"
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected command result to be returned");
    }
    expect(result.output).toMatchObject({
      status: "failed",
      exitCode: 7,
      changedFiles: [expect.objectContaining({ path: "failed.txt", byteSize: 7 })]
    });
    const command = await harness.store.getWorkspaceCommand({
      clientInstanceId: harness.clientInstanceId,
      commandId: result.output!.commandId
    });
    expect(command).toMatchObject({
      status: "failed",
      error: {
        code: "WORKSPACE_COMMAND_EXIT_NONZERO",
        category: "runner_error"
      }
    });

    const file = await harness.service.readFile({ path: "failed.txt" }, harness.context);
    expect(file.status).toBe("success");
    if (file.status !== "success") {
      throw new Error("Expected failed command output file to be readable");
    }
    expect(file.output?.contentPreview).toBe("partial");
  });

  it("runs a multiline strict-mode helper script when set -e is on its own line", async () => {
    const harness = await createRunnerHarness();

    const result = await harness.exec({
      command: [
        "set -e",
        "cat > pptx_render <<'SH'",
        "#!/bin/sh",
        "out=",
        "while [ \"$#\" -gt 0 ]; do",
        "  if [ \"$1\" = \"--out\" ]; then",
        "    shift",
        "    out=\"$1\"",
        "  fi",
        "  shift",
        "done",
        "mkdir -p \"$out\"",
        "printf 'rendered\\n' > \"$out/slide-1.txt\"",
        "SH",
        "chmod +x pptx_render",
        "PATH=\"$PWD:$PATH\" pptx_render deck.pptx --out previews/slides"
      ].join("\n"),
      expectedOutputs: [{ path: "previews/slides/slide-1.txt" }]
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected helper script result");
    }
    expect(result.output).toMatchObject({
      status: "completed",
      exitCode: 0,
      changedFiles: expect.arrayContaining([
        expect.objectContaining({ path: "previews/slides/slide-1.txt" })
      ])
    });
    const rendered = await harness.service.readFile({ path: "previews/slides/slide-1.txt" }, harness.context);
    expect(rendered.status).toBe("success");
    if (rendered.status !== "success") {
      throw new Error("Expected rendered helper output to be readable");
    }
    expect(rendered.output?.contentPreview).toBe("rendered\n");
  });

  it("rejects manifest path traversal and symlink escape attempts", async () => {
    const traversal = await createRunnerHarness({ useResultSource: false });
    const unsafeWorkspace = await traversal.workspace();
    const bytes = encode("secret");
    const stored = await traversal.byteStore.putWorkspaceFile({
      clientInstanceId: traversal.clientInstanceId,
      conversationId: traversal.conversation.id,
      workspaceId: unsafeWorkspace.id,
      commandId: asWorkspaceCommandId("wcmd_seed"),
      path: "seed.txt",
      bytes,
      checksum: checksum(bytes)
    });
    await traversal.store.upsertWorkspaceFile({
      clientInstanceId: traversal.clientInstanceId,
      workspaceId: unsafeWorkspace.id,
      path: "../escape.txt",
      objectKey: stored.objectKey,
      byteSize: bytes.byteLength,
      checksum: checksum(bytes)
    });
    await traversal.enqueue("true");
    const traversalResult = await traversal.runner.runNextCommand({
      clientInstanceId: traversal.clientInstanceId
    });
    expect(traversalResult).toMatchObject({
      status: "failed",
      error: {
        code: "WORKSPACE_FILE_PATH_REJECTED"
      }
    });

    const symlink = await createRunnerHarness();
    const symlinkResult = await symlink.exec({
      command: "ln -s /tmp outside-link"
    });
    expect(symlinkResult.status).toBe("success");
    if (symlinkResult.status !== "success") {
      throw new Error("Expected symlink command result");
    }
    expect(symlinkResult.output).toMatchObject({
      status: "failed",
      changedFiles: []
    });
    const symlinkCommand = await symlink.store.getWorkspaceCommand({
      clientInstanceId: symlink.clientInstanceId,
      commandId: symlinkResult.output!.commandId
    });
    expect(symlinkCommand).toMatchObject({
      error: {
        code: "WORKSPACE_SYMLINK_REJECTED"
      }
    });
  });

  it("enforces stdout and stderr preview truncation", async () => {
    const harness = await createRunnerHarness({
      limits: {
        maxStdoutBytes: 5,
        maxStderrBytes: 4
      }
    });

    const result = await harness.exec({
      command: "printf '123456789'; printf 'abcdef' >&2"
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected command result");
    }
    expect(result.output).toMatchObject({
      stdoutPreview: "12345",
      stderrPreview: "abcd",
      truncated: {
        stdout: true,
        stderr: true
      }
    });
  });

  it("fails commands on wall-clock and idle timeouts", async () => {
    const wallClock = await createRunnerHarness({
      limits: {
        idleTimeoutSeconds: 10
      }
    });
    const wallClockResult = await wallClock.exec({
      command: "sleep 2",
      timeoutSeconds: 1
    });
    expect(wallClockResult.status).toBe("success");
    if (wallClockResult.status !== "success") {
      throw new Error("Expected wall-clock timeout result");
    }
    expect(wallClockResult.output).toMatchObject({
      status: "failed",
      exitCode: 124
    });
    const wallClockCommand = await wallClock.store.getWorkspaceCommand({
      clientInstanceId: wallClock.clientInstanceId,
      commandId: wallClockResult.output!.commandId
    });
    expect(wallClockCommand?.error).toMatchObject({
      code: "WORKSPACE_COMMAND_TIMEOUT",
      category: "timeout"
    });

    const idle = await createRunnerHarness({
      limits: {
        idleTimeoutSeconds: 1
      }
    });
    const idleResult = await idle.exec({
      command: "sleep 2",
      timeoutSeconds: 5
    });
    expect(idleResult.status).toBe("success");
    if (idleResult.status !== "success") {
      throw new Error("Expected idle timeout result");
    }
    const idleCommand = await idle.store.getWorkspaceCommand({
      clientInstanceId: idle.clientInstanceId,
      commandId: idleResult.output!.commandId
    });
    expect(idleCommand?.error).toMatchObject({
      code: "WORKSPACE_COMMAND_IDLE_TIMEOUT",
      category: "timeout"
    });
  });

  it("records terminal timeout audit and telemetry without stdout payloads", async () => {
    const telemetryEvents: Parameters<WorkspaceCommandTelemetry["record"]>[0][] = [];
    const harness = await createRunnerHarness({
      withAuditRecorder: true,
      telemetry: {
        record(event) {
          telemetryEvents.push(event);
        }
      },
      limits: {
        idleTimeoutSeconds: 10
      }
    });

    const result = await harness.exec({
      command: "printf 'secret-output-not-for-audit'; sleep 2",
      timeoutSeconds: 1
    });

    expect(result.status).toBe("success");
    const auditEvents = await harness.store.listAuditEvents({
      clientInstanceId: harness.clientInstanceId,
      limit: 20
    });
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "workspace_command.timed_out",
          status: "failed",
          metadata: expect.objectContaining({
            errorCode: "WORKSPACE_COMMAND_TIMEOUT",
            errorCategory: "timeout",
            changedFileCount: 0
          })
        })
      ])
    );
    expect(JSON.stringify(auditEvents)).not.toContain("secret-output-not-for-audit");
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        type: "timed_out",
        errorCode: "WORKSPACE_COMMAND_TIMEOUT",
        errorCategory: "timeout"
      })
    );
  });

  it("enforces the workspace byte-size limit before syncing oversized files", async () => {
    const harness = await createRunnerHarness({
      limits: {
        maxWorkspaceBytes: 10
      }
    });

    const result = await harness.exec({
      command: "printf '12345678901' > large.txt"
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected workspace-size result");
    }
    expect(result.output).toMatchObject({
      status: "failed",
      exitCode: 0,
      changedFiles: []
    });
    const listed = await harness.service.listFiles({}, harness.context);
    expect(listed.status).toBe("success");
    if (listed.status !== "success") {
      throw new Error("Expected list_files result");
    }
    expect(listed.output?.files).toEqual([]);
    const command = await harness.store.getWorkspaceCommand({
      clientInstanceId: harness.clientInstanceId,
      commandId: result.output!.commandId
    });
    expect(command?.error).toMatchObject({
      code: "WORKSPACE_SIZE_LIMIT_EXCEEDED"
    });
  });

  it("promotes expected outputs after syncing the changed file manifest", async () => {
    const harness = await createRunnerHarness();

    const result = await harness.exec({
      command: "printf '%s' 'pptx-placeholder' > deck.pptx",
      expectedOutputs: [{ path: "deck.pptx", kind: "presentation.pptx", promote: true }]
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected promoted output result");
    }
    expect(result.artifacts).toHaveLength(1);
    expect(result.output).toMatchObject({
      status: "completed",
      changedFiles: [expect.objectContaining({ path: "deck.pptx", artifactId: expect.any(String) })],
      promotedArtifacts: [expect.objectContaining({ path: "deck.pptx", kind: "presentation.pptx" })]
    });
    expect(result.output.changedFiles[0]).not.toHaveProperty("objectKey");
    const workspaceFiles = await harness.store.listWorkspaceFiles({
      clientInstanceId: harness.clientInstanceId,
      workspaceId: asExecutionWorkspaceId(result.output.workspaceId)
    });
    const deckFile = workspaceFiles.find((file) => file.path === "deck.pptx");
    expect(deckFile).toBeDefined();
    const artifact = await harness.store.getManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      artifactId: result.output!.promotedArtifacts[0]!.artifactId
    });
    expect(artifact).toMatchObject({
      kind: "presentation.pptx",
      objectKey: deckFile?.objectKey
    });
    const previewJob = await harness.store.getArtifactPreviewJob({
      clientInstanceId: harness.clientInstanceId,
      sourceArtifactId: result.output!.promotedArtifacts[0]!.artifactId
    });
    expect(previewJob).toMatchObject({
      status: "pending",
      conversationId: harness.conversation.id,
      sourceChecksum: deckFile?.checksum,
      sourceMimeType: artifact?.mimeType
    });
  });

  it("keeps promoted artifact bytes when the source workspace path is later deleted", async () => {
    const harness = await createRunnerHarness();

    const created = await harness.exec({
      command: "printf '%s' 'final-bytes' > final.pdf"
    });
    expect(created.status).toBe("success");
    if (created.status !== "success") {
      throw new Error("Expected create command to succeed");
    }
    const promoted = await harness.service.promoteArtifact(
      {
        path: "final.pdf",
        kind: "document.pdf"
      },
      harness.context
    );
    expect(promoted.status).toBe("success");
    if (promoted.status !== "success") {
      throw new Error("Expected promote_artifact result");
    }
    const workspaceId = asExecutionWorkspaceId(created.output.workspaceId);
    const artifactId = promoted.output.artifactId;
    const artifact = await harness.store.getManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      artifactId: asManagedArtifactId(artifactId)
    });
    expect(artifact?.objectKey).toEqual(expect.any(String));

    const deleted = await harness.exec({
      command: "rm final.pdf"
    });
    expect(deleted.status).toBe("success");
    if (deleted.status !== "success") {
      throw new Error("Expected delete command to succeed");
    }
    expect(deleted.output).toMatchObject({
      status: "completed",
      exitCode: 0,
      changedFiles: []
    });

    await expect(
      harness.store.listWorkspaceFiles({
        clientInstanceId: harness.clientInstanceId,
        workspaceId
      })
    ).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ path: "final.pdf" })]));
    const later = await harness.exec({
      command: "test ! -e final.pdf && printf ok > after-promoted-delete.txt"
    });
    expect(later.status).toBe("success");
    if (later.status !== "success") {
      throw new Error("Expected later hydration command to succeed");
    }
    await expect(
      harness.byteStore.getObject(artifact!.objectKey).then((bytes) => new TextDecoder().decode(bytes))
    ).resolves.toBe("final-bytes");
  });

  it("attaches derived image-page previews to promoted office outputs", async () => {
    const previewGenerator = new TestArtifactPreviewGenerator([
      {
        bytes: encode("page-1"),
        filename: "memo-page-1.png",
        mimeType: "image/png",
        pageNumber: 1
      }
    ]);
    const harness = await createRunnerHarness({ artifactPreviewGenerator: previewGenerator });

    const result = await harness.exec({
      command: "printf '%s' 'docx-bytes' > memo.docx",
      expectedOutputs: [{ path: "memo.docx", kind: "document.docx", promote: true }]
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected office output promotion to succeed");
    }
    expect(previewGenerator.calls).toEqual([
      expect.objectContaining({
        filename: "memo.docx",
        kind: "document.docx",
        previewKind: "document"
      })
    ]);
    expect(result.artifacts?.[0]?.metadata).toMatchObject({
      preview: {
        type: "image_pages",
        format: "png",
        pages: [
          expect.objectContaining({
            kind: "document.preview_page_image",
            filename: "memo-page-1.png",
            mimeType: "image/png",
            pageNumber: 1
          })
        ]
      }
    });
    expect(result.output?.promotedArtifacts[0]?.metadata).toEqual({
      preview: result.artifacts?.[0]?.metadata?.preview
    });
    const previewPage = result.artifacts?.[0]?.metadata?.preview?.pages[0];
    expect(previewPage?.artifactId).toEqual(expect.any(String));
    const previewArtifact = await harness.store.getManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      artifactId: asManagedArtifactId(previewPage!.artifactId)
    });
    expect(previewArtifact).toMatchObject({
      kind: "document.preview_page_image",
      filename: "memo-page-1.png",
      mimeType: "image/png",
      metadata: expect.objectContaining({
        source: "execution_workspace",
        workspacePath: "memo.docx",
        previewRole: "page_image"
      })
    });
    await expect(
      harness.byteStore.getObject(previewArtifact!.objectKey).then((bytes) => new TextDecoder().decode(bytes))
    ).resolves.toBe("page-1");
  });

  it("proves the PR9 workspace readiness flow with Python persistence and promoted-only artifacts", async () => {
    const harness = await createRunnerHarness();

    const calculated = await harness.exec({
      command: [
        "PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'",
        "from pathlib import Path",
        "value = sum([13, 21, 8])",
        "Path('analysis.txt').write_text(f'value={value}\\n', encoding='utf-8')",
        "PY"
      ].join("\n")
    });
    expect(calculated.status).toBe("success");
    if (calculated.status !== "success") {
      throw new Error("Expected Python calculation command to succeed");
    }
    expect(calculated.output).toMatchObject({
      status: "completed",
      changedFiles: [expect.objectContaining({ path: "analysis.txt" })]
    });

    const modified = await harness.exec({
      command: [
        "PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'",
        "from pathlib import Path",
        "analysis = Path('analysis.txt').read_text(encoding='utf-8')",
        "Path('analysis.txt').write_text(analysis + 'adjusted=43\\n', encoding='utf-8')",
        "Path('internal/runner.log').parent.mkdir(parents=True, exist_ok=True)",
        "Path('internal/runner.log').write_text('internal command log\\n', encoding='utf-8')",
        "Path('final-report.txt').write_text('Final answer: 43\\n', encoding='utf-8')",
        "PY"
      ].join("\n"),
      expectedOutputs: [{ path: "final-report.txt", kind: "text/plain", promote: true }]
    });
    expect(modified.status).toBe("success");
    if (modified.status !== "success") {
      throw new Error("Expected modification command to succeed");
    }
    expect(modified.artifacts).toEqual([
      expect.objectContaining({
        kind: "text/plain",
        filename: "final-report.txt"
      })
    ]);
    expect(JSON.stringify(modified.artifacts)).not.toContain("internal/runner.log");
    expect(modified.output).toMatchObject({
      status: "completed",
      changedFiles: expect.arrayContaining([
        expect.objectContaining({ path: "analysis.txt" }),
        expect.objectContaining({ path: "internal/runner.log" }),
        expect.objectContaining({ path: "final-report.txt", artifactId: expect.any(String) })
      ]),
      promotedArtifacts: [expect.objectContaining({ path: "final-report.txt", kind: "text/plain" })]
    });

    const analysis = await harness.service.readFile({ path: "analysis.txt" }, harness.context);
    expect(analysis.status).toBe("success");
    if (analysis.status !== "success") {
      throw new Error("Expected analysis file to be readable");
    }
    expect(analysis.output?.contentPreview).toContain("value=42");
    expect(analysis.output?.contentPreview).toContain("adjusted=43");

    const listed = await harness.service.listFiles({}, harness.context);
    expect(listed.status).toBe("success");
    if (listed.status !== "success") {
      throw new Error("Expected list_files to succeed");
    }
    expect(listed.artifacts).toBeUndefined();
    expect(listed.output?.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["analysis.txt", "internal/runner.log", "final-report.txt"])
    );
    const finalFile = listed.output?.files.find((file) => file.path === "final-report.txt");
    expect(finalFile?.promotedArtifacts).toEqual([
      expect.objectContaining({
        kind: "text/plain"
      })
    ]);
    const internalFile = listed.output?.files.find((file) => file.path === "internal/runner.log");
    expect(internalFile?.promotedArtifacts).toBeUndefined();
  });

  it("validates workspace paths through the shared safe relative path helper", () => {
    expect(normalizeWorkspaceFilePath("reports/../notes.txt", { maxPathLength: 512 })).toEqual({
      status: "success",
      value: "notes.txt"
    });
    expect(normalizeWorkspaceFilePath("/workspace/artifacts/report.pdf", { maxPathLength: 512 })).toEqual({
      status: "success",
      value: "artifacts/report.pdf"
    });
    expect(normalizeWorkspaceFilePath("/tmp/notes.txt", { maxPathLength: 512 })).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/relative/u)
    });
    expect(normalizeWorkspaceFilePath("../notes.txt", { maxPathLength: 512 })).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/traverse/u)
    });
    expect(normalizeWorkspaceFilePath("notes/", { maxPathLength: 512 })).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/slash/u)
    });
  });

  it("wraps a generic object store as workspace file byte storage", async () => {
    const objectStorage = new MemoryObjectStorage();
    const byteStore = createObjectStoreWorkspaceFileByteStore({
      objectStore: objectStorage,
      keyFactory: {
        createWorkspaceFileObjectKey: () => "workspace/custom-key.txt"
      }
    });
    const bytes = encode("stored");

    const result = await byteStore.putWorkspaceFile({
      clientInstanceId: asClientInstanceId("client_object_store"),
      conversationId: asConversationId("conv_object_store"),
      workspaceId: asExecutionWorkspaceId("ews_object_store"),
      commandId: asWorkspaceCommandId("wcmd_object_store"),
      path: "custom-key.txt",
      bytes,
      checksum: checksum(bytes),
      mimeType: "text/plain"
    });

    expect(result.objectKey).toBe("workspace/custom-key.txt");
    await expect(byteStore.getObject(result.objectKey)).resolves.toEqual(bytes);
    expect(objectStorage.contentType(result.objectKey)).toBe("text/plain");
  });
});

async function createRunnerHarness(input: {
  artifactPreviewGenerator?: WorkspaceArtifactPreviewGenerator;
  limits?: ConstructorParameters<typeof WorkspaceCommandService>[0]["limits"];
  telemetry?: WorkspaceCommandTelemetry;
  useResultSource?: boolean;
  withAuditRecorder?: boolean;
} = {}) {
  const clientInstanceId = asClientInstanceId(`workspace_runner_${globalThis.crypto.randomUUID()}`);
  const ownerUserId = "user-1";
  const store = new InMemoryPlatformStore();
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId,
    ownerExternalUserId: ownerUserId,
    title: "Workspace runner test",
    retainedUntil: "2026-07-29T00:00:00.000Z"
  });
  const rootDirectory = await mkdtemp(join(tmpdir(), "catalyst-runner-test-"));
  cleanupDirectories.push(rootDirectory);
  const commandRootDirectory = join(rootDirectory, "commands");
  const byteStore = createLocalWorkspaceFileByteStore({
    rootDirectory: join(rootDirectory, "objects")
  });
  const auditRecorder = input.withAuditRecorder
    ? new StoreBackedAuditRecorder({ clientInstanceId, store })
    : undefined;
  const runner = new LocalWorkspaceCommandRunner({
    store,
    byteStore,
    tempRootDirectory: commandRootDirectory,
    ...(input.artifactPreviewGenerator ? { artifactPreviewGenerator: input.artifactPreviewGenerator } : {}),
    ...(auditRecorder ? { auditRecorder } : {}),
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    now: () => new Date().toISOString()
  });
  const service = new WorkspaceCommandService({
    store,
    objectStore: byteStore,
    commandResults: input.useResultSource === false
      ? undefined
      : new LocalWorkspaceCommandResultSource(runner),
    ...(auditRecorder ? { auditRecorder } : {}),
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    limits: input.limits
  });
  const context = createToolContext(clientInstanceId, conversation);
  const ensureWorkspace = () =>
    store.ensureExecutionWorkspace({
      clientInstanceId,
      conversationId: conversation.id,
      ownerUserId
    });
  return {
    clientInstanceId,
    ownerUserId,
    store,
    conversation,
    byteStore,
    runner,
    service,
    context,
    async exec(input: {
      command: string;
      cwd?: string;
      timeoutSeconds?: number;
      expectedOutputs?: Array<{ path: string; kind?: string; promote?: boolean }>;
    }) {
      return service.exec(input, context);
    },
    async workspace() {
      return ensureWorkspace();
    },
    async enqueue(command: string, limits: Partial<WorkspaceCommandLimits> = {}) {
      const workspace = await ensureWorkspace();
      return store.enqueueWorkspaceCommand({
        clientInstanceId,
        workspaceId: workspace.id,
        ownerUserId,
        command,
        limits: {
          timeoutSeconds: 5,
          idleTimeoutSeconds: 5,
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 64 * 1024,
          maxWorkspaceBytes: 100 * 1024 * 1024,
          ...limits
        }
      });
    },
    async commandExecutionDirectories() {
      try {
        return await readdir(commandRootDirectory);
      } catch {
        return [];
      }
    }
  };
}

function createToolContext(
  clientInstanceId: ClientInstanceId,
  conversation: Conversation
): ToolExecutionContext {
  return {
    clientInstanceId,
    correlationId: "corr_workspace_runner",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "Workspace Runner User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    },
    toolRequest: {
      toolName: "workspace.exec",
      toolCallId: asToolCallId(`toolcall_${globalThis.crypto.randomUUID()}`),
      agentRunId: asAgentRunId(`run_${globalThis.crypto.randomUUID()}`),
      conversationId: conversation.id,
      agentName: "workspace_agent",
      input: {}
    }
  };
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

class MemoryObjectStorage implements WorkspaceObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly contentTypes = new Map<string, string | undefined>();

  async putObject(input: {
    key: string;
    body: Uint8Array;
    contentType?: string;
  }): Promise<void> {
    this.objects.set(input.key, input.body);
    this.contentTypes.set(input.key, input.contentType);
  }

  async getObject(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Object '${key}' not found`);
    }
    return object;
  }

  contentType(key: string): string | undefined {
    return this.contentTypes.get(key);
  }
}
