import { text, array, jsonObject, waitUntil } from "./support/assertions";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AGENT_RUN_IDLE_LIMIT_MS } from "@work-shape/catalyst-agent-runtime";
import {
  JOB_UNCLAIMED_MS,
  asExecutionWorkspaceId,
  asWorkspaceCommandId,
  type WorkspaceCommand
} from "@work-shape/catalyst-core";
import {
  LocalWorkspaceCommandRunner,
  shapeWorkspaceCommandOutput,
  type WorkspaceCommandTelemetry
} from "@work-shape/catalyst-tool-execution";
import {
  advanceFakeClockUntilSettled,
  settleOnFakeClock,
  useFakeClockBesidePostgres
} from "./support/fake-clock";
import { createCommandWorker } from "./support/workspace-command-jobs";
import { createWorkspaceHarness, encode } from "./support/workspace-tools-harness";

describe("workspace tools", () => {
  it("describes safe shell command shape to the model", async () => {
    const harness = await createWorkspaceHarness();
    const execTool = harness.tools.find((tool) => tool.name === "workspace.exec");

    expect(execTool?.description).toContain("Bash command from /workspace");
    expect(execTool?.description).toContain("Each call starts in /workspace");
    expect(execTool?.description).toContain("Files created or changed under /workspace persist");
    expect(execTool?.description).toContain(
      "standard project directories scripts, artifacts, previews, and tmp"
    );
    expect(execTool?.description).toContain(
      "For multiline create-and-verify commands, put `set -e` on its own line"
    );
    expect(execTool?.description).toContain(
      "`--view`, `--spec`, `--out`, `--range`, `--page`, or `--sheet`"
    );
    expect(execTool?.description).toContain("`cat`, `ls`, or `printf`");
    // The usage text stands once, in the description. Fails when the `command` parameter
    // repeats it, as it did before.
    expect(execTool?.inputJsonSchema).toMatchObject({
      properties: {
        command: {
          description: "Complete Bash command or multiline script."
        },
        cwd: {
          description: expect.stringContaining("does not persist")
        }
      }
    });
    const modelFacingExec = JSON.stringify([execTool?.description, execTool?.inputJsonSchema]);
    for (const usage of [
      "standard project directories scripts, artifacts, previews, and tmp",
      "Files created or changed under /workspace persist",
      "put `set -e` on its own line",
      "`cat`, `ls`, or `printf`"
    ]) {
      expect(modelFacingExec.split(usage)).toHaveLength(2);
    }
    const previewTool = harness.tools.find((tool) => tool.name === "workspace.preview_images");
    expect(previewTool?.description).toContain("/workspace/previews");
    const importTool = harness.tools.find((tool) => tool.name === "workspace.import_files");
    expect(importTool?.description).toContain(
      "returns a shell-safe workspace path in importedFiles[].path"
    );
    expect(importTool?.description).toContain("use that exact path in workspace.exec");
    expect(importTool?.description).toContain("do not invent shortened filenames");
    const promoteTool = harness.tools.find((tool) => tool.name === "workspace.promote_artifact");
    expect(promoteTool?.description).toContain(
      "automatically displays promoted artifacts as clickable download cards"
    );
    // The three sources are no `anyOf` at the root of the schema, which a model provider
    // refuses there: the description names the rule and the input schema keeps it.
    expect(previewTool?.inputJsonSchema).not.toHaveProperty("anyOf");
    expect(previewTool?.description).toContain(
      "Give exactly one source: artifactId, path, or paths."
    );
    expect(previewTool?.inputSchema.safeParse({}).success).toBe(false);
    expect(
      previewTool?.inputSchema.safeParse({ artifactId: "file_1", path: "previews/a.png" }).success
    ).toBe(false);
    expect(previewTool?.inputSchema.safeParse({ path: "previews/a.png" }).success).toBe(true);
    expect(importTool?.inputJsonSchema).toMatchObject({
      properties: {
        files: {
          items: {
            properties: {
              path: {
                description: expect.stringContaining("Usually omit this")
              }
            }
          }
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

    const longScript = await createWorkspaceHarness();
    const longScriptCommand = [
      "mkdir -p scripts",
      "cat > scripts/build_artifact.py <<'PY'",
      `# ${"realistic script body ".repeat(700)}`,
      "print('ok')",
      "PY"
    ].join("\n");
    expect(longScriptCommand.length).toBeGreaterThan(8192);
    const longScriptQueued = await longScript.runTool("workspace.exec", {
      command: longScriptCommand
    });
    expect(longScriptQueued.status).toBe("success");

    await expectToolFailure("workspace.exec", { command: "   " }, "validation_failed", /blank/u);
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
      { command: 'ls --range "Summary!A1:H30" source.xlsx' },
      "validation_failed",
      /Run the artifact helper directly/u
    );
    await expectToolFailure(
      "workspace.exec",
      { command: "printf --spec report.json --out report.pdf" },
      "validation_failed",
      /cat, ls, or printf/u
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
        'ls --range "Summary!A1:H30" source.xlsx',
        "printf --spec report.json --out report.pdf",
        "EOF"
      ].join("\n")
    });
    expect(hereDoc.status).toBe("success");
  });

  // Fails without the tool path on `runOperation`: the allowlist is asked there, per call.
  it("refuses a tool outside the agent's allowlist as a failed tool result", async () => {
    const harness = await createWorkspaceHarness({
      agentToolNames: ["workspace.list_files"]
    });

    const result = await harness.runTool("workspace.exec", { command: "pwd" });

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "not_allowed",
        message:
          "This agent is not set up for this action here. Nothing ran. Ask the person who built this agent or an instance administrator."
      }
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
    const auditEvents = await harness.store.audit.listAuditEvents({
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
          type: "operation.completed",
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

  it("queues concurrent workspace.exec calls without admission limits", async () => {
    const harness = await createWorkspaceHarness();

    const results = await Promise.all([
      harness.runTool("workspace.exec", { command: "sleep 1" }),
      harness.runTool("workspace.exec", { command: "sleep 2" })
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === "success")).toBe(true);
    await expect(
      harness.store.executionWorkspaces.countActiveWorkspaceCommands({
        clientInstanceId: harness.clientInstanceId,
        conversationId: harness.conversation.id
      })
    ).resolves.toMatchObject({ queued: 2, total: 2 });
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
    const worker = createCommandWorker(harness.store, harness.clientInstanceId, { runner });
    worker.start();

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
      expect(jsonObject(read.output).contentPreview).toBe("ready");

      const verified = await harness.runTool("workspace.exec", {
        command: "printf 'verified\\n'",
        expectedOutputs: [{ path: "result.txt" }]
      });
      expect(verified.status).toBe("success");
      if (verified.status !== "success") {
        throw new Error("Expected unchanged expected output to satisfy postcondition");
      }
      expect(verified.output).toMatchObject({
        status: "completed",
        exitCode: 0,
        stdoutPreview: "verified\n",
        changedFiles: []
      });

      const directoryPostcondition = await harness.runTool("workspace.exec", {
        command: "mkdir -p previews/deck && printf 'preview' > previews/deck/slide-1.png",
        expectedOutputs: [{ path: "previews/deck", kind: "directory" }]
      });
      expect(directoryPostcondition.status).toBe("success");
      if (directoryPostcondition.status !== "success") {
        throw new Error("Expected directory expected output to satisfy postcondition");
      }
      expect(jsonObject(directoryPostcondition.output).changedFiles).toEqual([
        expect.objectContaining({ path: "previews/deck/slide-1.png" })
      ]);

      const existingDirectoryPostcondition = await harness.runTool("workspace.exec", {
        command: "printf 'directory still present\\n'",
        expectedOutputs: [{ path: "previews/deck", kind: "directory" }]
      });
      expect(existingDirectoryPostcondition.status).toBe("success");
      if (existingDirectoryPostcondition.status !== "success") {
        throw new Error("Expected existing directory expected output to satisfy postcondition");
      }
      expect(existingDirectoryPostcondition.output).toMatchObject({
        status: "completed",
        exitCode: 0,
        stdoutPreview: "directory still present\n",
        changedFiles: []
      });
    } finally {
      await worker.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails workspace.exec with the reason when no worker takes commands, and the run goes on", async () => {
    // As the product assembles it: the call waits for its command without a limit of its own.
    const harness = await createWorkspaceHarness({ execResultWaitMs: null });
    const request = harness.createRequest("workspace.exec", { command: "ls" });
    useFakeClockBesidePostgres();
    try {
      const startedAt = Date.now();

      const result = await advanceFakeClockUntilSettled(
        harness.execution(request, harness.context),
        250
      );

      // A result the agent reads, not a call that hangs or throws.
      expect(result).toMatchObject({
        status: "failed",
        error: {
          code: "handler_failed",
          message: expect.stringContaining(
            "code execution is unavailable on the platform right now"
          ),
          details: { reason: "no_worker" }
        }
      });
      if (result.status === "failed") {
        expect(result.error.message).toContain(
          "a technical problem of the platform, not of the person's input"
        );
        expect(result.error.message).toContain("suggest trying again later");
        expect(result.error.message).not.toMatch(/administrator has to/iu);
      }
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(JOB_UNCLAIMED_MS);
      expect(Date.now() - startedAt).toBeLessThan(AGENT_RUN_IDLE_LIMIT_MS);
    } finally {
      vi.useRealTimers();
    }
    await expect(
      harness.store.agentRuns.getAgentRun({
        clientInstanceId: harness.clientInstanceId,
        runId: request.agentRunId
      })
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      harness.store.executionWorkspaces.countActiveWorkspaceCommands({
        clientInstanceId: harness.clientInstanceId,
        conversationId: harness.conversation.id
      })
    ).resolves.toMatchObject({ total: 0 });
  });

  it("tells the agent that a sandbox which could not start is the platform's failure, without its cause", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "workspace-tools-sandbox-"));
    const harness = await createWorkspaceHarness({
      execResultWaitMs: 5000,
      execResultPollIntervalMs: 10
    });
    const runner = new LocalWorkspaceCommandRunner({
      store: harness.store,
      byteStore: harness.objectStore,
      tempRootDirectory: tempRoot,
      processExecutor: {
        execute: async () => ({
          exitCode: 125,
          stdoutPreview: "",
          stderrPreview: "docker: Error response from daemon: unauthorized.",
          truncated: { stdout: false, stderr: false },
          durationMs: 5,
          spawnError: new Error(
            "The runner container could not be started: docker: Error response from daemon: unauthorized."
          )
        })
      }
    });
    const worker = createCommandWorker(harness.store, harness.clientInstanceId, { runner });
    worker.start();

    try {
      const result = await harness.runTool("workspace.exec", { command: "ls" });

      expect(result).toMatchObject({
        status: "failed",
        error: {
          code: "handler_failed",
          details: { reason: "sandbox_unavailable", commandId: expect.any(String) }
        }
      });
      if (result.status !== "failed") throw new Error("Expected a failed result");
      const details = jsonObject(result.error.details);
      const message = result.error.message;
      expect(message).toContain("the platform's sandbox for commands could not start");
      expect(message).toContain("a technical problem of the platform, not of the person's input");
      expect(message).toContain("suggest trying again later");
      expect(message).not.toMatch(/operator|helpContact/iu);
      expect(message).toContain(`the command id (${text(details.commandId)})`);
      expect(message).toContain(`the time (${text(details.at)})`);
      expect(message).toContain("Do not name any person, administrator or contact");
      expect(message).toContain("Offer to continue another way");
      // The worker's cause names images, registries and hosts, and stays with the operator.
      expect(JSON.stringify(result)).not.toMatch(/docker|unauthorized|registry/iu);
    } finally {
      await worker.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not consume the execution timeout while a command is queued", async () => {
    useFakeClockBesidePostgres(new Date("2026-06-29T12:00:00.000Z"));
    try {
      let reads = 0;
      const leaseToken = "queued-wait-lease";
      const harness = await settleOnFakeClock(
        createWorkspaceHarness({
          execResultWaitMs: null,
          execResultPollIntervalMs: 1000,
          serviceStore(store) {
            return {
              ...store,
              executionWorkspaces: new Proxy(store.executionWorkspaces, {
                get(target, property, receiver) {
                  if (property === "getWorkspaceCommand") {
                    return async (
                      input: Parameters<typeof store.executionWorkspaces.getWorkspaceCommand>[0]
                    ) => {
                      reads += 1;
                      const current = await store.executionWorkspaces.getWorkspaceCommand(input);
                      if (!current || reads < 8) {
                        return current;
                      }
                      const claimed = await store.executionWorkspaces.claimWorkspaceCommand({
                        clientInstanceId: input.clientInstanceId,
                        commandId: input.commandId,
                        leaseOwnerId: "queued-wait-worker",
                        leaseToken,
                        leaseMs: 5 * 60 * 1000
                      });
                      if (claimed.status !== "claimed") {
                        throw new Error("Expected queued command to be claimable");
                      }
                      return store.executionWorkspaces.completeWorkspaceCommand({
                        clientInstanceId: input.clientInstanceId,
                        commandId: input.commandId,
                        leaseToken,
                        output: shapeWorkspaceCommandOutput(
                          {
                            exitCode: 0,
                            stdout: "started after queue wait",
                            stderr: "",
                            durationMs: 17
                          },
                          claimed.row.limits
                        ),
                        completedAt: "2026-06-29T12:00:08.000Z"
                      });
                    };
                  }
                  const value = Reflect.get(target, property, receiver);
                  return typeof value === "function" ? value.bind(target) : value;
                }
              })
            };
          }
        })
      );

      const resultPromise = harness.runTool("workspace.exec", {
        command: "printf 'started after queue wait'",
        timeoutSeconds: 1
      });
      const result = await advanceFakeClockUntilSettled(resultPromise, 1000);
      expect(reads).toBe(8);

      expect(result.status).toBe("success");
      if (result.status !== "success") {
        throw new Error("Expected queued command to complete");
      }
      expect(result.output).toMatchObject({
        status: "completed",
        stdoutPreview: "started after queue wait"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a queued workspace command when its agent run is cancelled", async () => {
    const controller = new AbortController();
    const harness = await createWorkspaceHarness({
      execResultWaitMs: null,
      execResultPollIntervalMs: 5
    });

    const cancelling = vi.spyOn(
      harness.store.executionWorkspaces,
      "requestWorkspaceCommandCancellation"
    );
    const resultPromise = harness.runTool(
      "workspace.exec",
      { command: "sleep 60" },
      {
        ...harness.context,
        signal: controller.signal
      }
    );
    await waitForQueuedCommand(harness);
    controller.abort("user_requested");

    const result = await resultPromise;

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "handler_failed",
        message: expect.stringContaining("check before calling again")
      }
    });
    // The operation answers first; the command's abort handler cancels its row afterwards.
    await waitUntil(async () => {
      const commandId = cancelling.mock.calls[0]?.[0].commandId;
      if (!commandId) return false;
      return (
        (
          await harness.store.executionWorkspaces.getWorkspaceCommand({
            clientInstanceId: harness.clientInstanceId,
            commandId
          })
        )?.status === "cancelled"
      );
    }, "the interrupted operation's command was cancelled");
    const commandId = cancelling.mock.calls[0]?.[0].commandId;
    if (!commandId) throw new Error("Expected queued workspace command cancellation");
    await expect(
      harness.store.executionWorkspaces.getWorkspaceCommand({
        clientInstanceId: harness.clientInstanceId,
        commandId: commandId
      })
    ).resolves.toMatchObject({
      status: "cancelled",
      cancellationReason: "Workspace command was cancelled with its agent run"
    });
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
    const commandId = jsonObject(result.error.details).commandId;
    expect(typeof commandId).toBe("string");
    const command = await harness.store.executionWorkspaces.getWorkspaceCommand({
      clientInstanceId: harness.clientInstanceId,
      commandId: asWorkspaceCommandId(text(commandId))
    });
    expect(command?.status).toBe("cancelled");
  });

  it("returns terminal output when command completion races wait-expiry cancellation", async () => {
    const leaseToken = "race-lease";
    const harness = await createWorkspaceHarness({
      execResultWaitMs: 1,
      execResultPollIntervalMs: 1,
      serviceStore(store) {
        return {
          ...store,
          executionWorkspaces: new Proxy(store.executionWorkspaces, {
            get(target, property, receiver) {
              if (property === "requestWorkspaceCommandCancellation") {
                return async (
                  input: Parameters<
                    typeof store.executionWorkspaces.requestWorkspaceCommandCancellation
                  >[0]
                ) => {
                  const claimed = await store.executionWorkspaces.claimWorkspaceCommand({
                    clientInstanceId: input.clientInstanceId,
                    commandId: input.commandId,
                    leaseOwnerId: "race-worker",
                    leaseToken,
                    leaseMs: 5 * 60 * 1000
                  });
                  if (claimed.status !== "claimed") {
                    throw new Error("Expected queued command to be claimable");
                  }
                  await store.executionWorkspaces.completeWorkspaceCommand({
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
                      claimed.row.limits
                    ),
                    completedAt: "2026-06-29T12:00:02.000Z"
                  });
                  return store.executionWorkspaces.requestWorkspaceCommandCancellation(input);
                };
              }
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
          })
        };
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
    const command = await harness.store.executionWorkspaces.getWorkspaceCommand({
      clientInstanceId: harness.clientInstanceId,
      commandId: asWorkspaceCommandId(text(jsonObject(result.output).commandId))
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
      expect(oversized.error.message).toMatch(/maxReadFileBytes, 64 bytes/u);
    }
  });

  it.each([
    {
      toolName: "workspace.import_files",
      input: { files: [{ fileId: "file_source_csv", path: "inputs/source.csv" }] }
    }
  ])(
    "$toolName removes the bytes of a file whose record is refused because the conversation was deleted",
    async ({ toolName, input }) => {
      const harness = await createWorkspaceHarness({
        sourceFiles: {
          file_source_csv: { filename: "source.csv", mimeType: "text/csv", bytes: encode("a,b\n") }
        }
      });
      // The Conversation is deleted between the bytes and the record.
      harness.objectStore.afterPutWorkspaceFile = async () => {
        await harness.store.conversations.deleteConversation({
          clientInstanceId: harness.clientInstanceId,
          conversationId: harness.conversation.id,
          deletedAt: "2026-06-29T12:00:01.000Z"
        });
      };

      const result = await harness.runTool(toolName, input);

      expect(result).toMatchObject({ status: "failed" });
      expect(harness.objectStore.deletedKeys).toHaveLength(1);
      expect(harness.objectStore.keys()).toEqual([]);
    }
  );

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

    const workspaceFiles = await harness.store.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId: harness.clientInstanceId,
      workspaceId: asExecutionWorkspaceId(text(jsonObject(imported.output).workspaceId))
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
    const storedBytes = harness.objectStore.bytes(workspaceFiles[0]!.objectKey);
    expect(new TextDecoder().decode(storedBytes)).toBe("name,total\nAda,42\n");
  });

  it("imports uploaded managed files to shell-safe default paths", async () => {
    const sourceBytes = encode("pdf bytes");
    const harness = await createWorkspaceHarness({
      sourceFiles: {
        file_boardingpass_pdf: {
          filename: "Boardingpass - YCX5CS.pdf",
          mimeType: "application/pdf",
          bytes: sourceBytes
        }
      }
    });

    const imported = await harness.runTool("workspace.import_files", {
      files: [{ fileId: "file_boardingpass_pdf" }]
    });

    expect(imported.status).toBe("success");
    if (imported.status !== "success") {
      throw new Error("Expected import_files to succeed");
    }
    expect(array(jsonObject(imported.output).importedFiles)[0]).toMatchObject({
      fileId: "file_boardingpass_pdf",
      path: "inputs/Boardingpass-YCX5CS.pdf",
      filename: "Boardingpass - YCX5CS.pdf",
      mimeType: "application/pdf"
    });

    const workspaceFiles = await harness.store.executionWorkspaces.listWorkspaceFiles({
      clientInstanceId: harness.clientInstanceId,
      workspaceId: asExecutionWorkspaceId(text(jsonObject(imported.output).workspaceId))
    });
    expect(workspaceFiles[0]).toMatchObject({
      path: "inputs/Boardingpass-YCX5CS.pdf",
      metadata: expect.objectContaining({
        filename: "Boardingpass - YCX5CS.pdf"
      })
    });
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
    expect(jsonObject(executed.output).changedFiles).toEqual([
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
    const sourceFile = await harness.putWorkspaceFile({
      path: "reports/final.docx",
      objectKey: "workspace/reports/final.docx",
      bytes: "docx-preview",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      metadata: { purpose: "final" }
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
      artifactId: jsonObject(promoted.output).artifactId,
      kind: "document.docx",
      filename: "final.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
    const artifact = await harness.store.files.getManagedArtifact({
      clientInstanceId: harness.clientInstanceId,
      artifactId: promoted.artifacts![0]!.artifactId
    });
    expect(artifact).toMatchObject({
      kind: "document.docx",
      objectKey: "workspace/reports/final.docx",
      filename: "final.docx",
      metadata: {
        source: "execution_workspace",
        workspaceId: expect.any(String),
        workspacePath: "reports/final.docx"
      }
    });
    expect(artifact?.metadata).not.toHaveProperty("preview");
    const previewJob = await harness.store.files.getArtifactPreviewJob({
      clientInstanceId: harness.clientInstanceId,
      sourceArtifactId: promoted.artifacts![0]!.artifactId
    });
    expect(previewJob).toMatchObject({
      status: "pending",
      conversationId: harness.conversation.id,
      sourceChecksum: "sha256:reports/final.docx",
      sourceMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
    const promotedFile = (
      await harness.store.executionWorkspaces.listWorkspaceFiles({
        clientInstanceId: harness.clientInstanceId,
        workspaceId: sourceFile.workspaceId
      })
    ).find((file) => file.path === "reports/final.docx");
    expect(promotedFile?.metadata).toMatchObject({
      purpose: "final",
      promotedArtifacts: [expect.objectContaining({ artifactId: artifact?.id })]
    });

    const listed = await harness.runTool("workspace.list_files", {});
    expect(listed.status).toBe("success");
    if (listed.status !== "success") {
      throw new Error("Expected list_files to succeed");
    }
    expect(listed.artifacts).toBeUndefined();
    expect(jsonObject(listed.output).files).toEqual([
      expect.objectContaining({
        path: "reports/draft.pdf",
        promotedArtifacts: undefined
      }),
      expect.objectContaining({
        path: "reports/final.docx",
        promotedArtifacts: [
          expect.objectContaining({
            artifactId: jsonObject(promoted.output).artifactId,
            kind: "document.docx"
          })
        ]
      })
    ]);
  });

  it("supports script-first preview then promotion from previews and artifacts directories", async () => {
    const harness = await createWorkspaceHarness();
    await harness.putWorkspaceFile({
      path: "artifacts/final-report.docx",
      objectKey: "execution-workspaces/private/artifacts/final-report.docx",
      bytes: "docx-bytes",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
    await harness.putWorkspaceFile({
      path: "previews/final-report/page-1.png",
      objectKey: "execution-workspaces/private/previews/final-report/page-1.png",
      bytes: encode("page-1"),
      mimeType: "image/png"
    });
    await harness.putWorkspaceFile({
      path: "scripts/build-report.py",
      objectKey: "execution-workspaces/private/scripts/build-report.py",
      bytes: "print('build')",
      mimeType: "text/x-python"
    });

    const previewed = await harness.runTool("workspace.preview_images", {
      paths: ["/workspace/previews/final-report/page-1.png"],
      maxImages: 1
    });

    expect(previewed.status).toBe("success");
    if (previewed.status !== "success") {
      throw new Error("Expected preview_images to succeed");
    }
    expect(previewed.output).toMatchObject({
      status: "ready",
      images: [
        expect.objectContaining({
          mimeType: "image/png",
          status: "ready"
        })
      ],
      warnings: []
    });
    expect(previewed.artifacts).toEqual([
      expect.objectContaining({
        filename: "page-1.png",
        modelVisibility: { type: "image", mimeType: "image/png" },
        metadata: expect.objectContaining({
          workspacePath: "previews/final-report/page-1.png"
        })
      })
    ]);

    const promoted = await harness.runTool("workspace.promote_artifact", {
      path: "/workspace/artifacts/final-report.docx",
      kind: "document.docx",
      filename: "final-report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });

    expect(promoted.status).toBe("success");
    if (promoted.status !== "success") {
      throw new Error("Expected promote_artifact to succeed");
    }
    expect(promoted.output).toMatchObject({
      path: "artifacts/final-report.docx",
      kind: "document.docx",
      filename: "final-report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
    expect(promoted.artifacts).toEqual([
      expect.objectContaining({
        artifactId: jsonObject(promoted.output).artifactId,
        kind: "document.docx",
        filename: "final-report.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      })
    ]);
    expect(JSON.stringify([previewed, promoted])).not.toContain("objectKey");
    expect(JSON.stringify([previewed, promoted])).not.toContain("execution-workspaces/private");

    const listed = await harness.runTool("workspace.list_files", {});
    expect(listed.status).toBe("success");
    if (listed.status !== "success") {
      throw new Error("Expected list_files to succeed");
    }
    expect(jsonObject(listed.output).files).toEqual([
      expect.objectContaining({
        path: "artifacts/final-report.docx",
        promotedArtifacts: [
          expect.objectContaining({ artifactId: jsonObject(promoted.output).artifactId })
        ]
      }),
      expect.objectContaining({
        path: "previews/final-report/page-1.png",
        promotedArtifacts: undefined
      }),
      expect.objectContaining({
        path: "scripts/build-report.py",
        promotedArtifacts: undefined
      })
    ]);
  });

  it("reuses the artifact of an unchanged preview image and adds one when the file changes", async () => {
    const harness = await createWorkspaceHarness();
    const workspace = await harness.store.executionWorkspaces.ensureExecutionWorkspace({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      ownerUserId: harness.ownerUserId,
      now: "2026-06-29T12:00:00.000Z"
    });
    const putVersion = async (version: string) => {
      const bytes = encode(`page-1 ${version}`);
      const objectKey = `execution-workspaces/private/previews/report/page-1.${version}.png`;
      harness.objectStore.seed(objectKey, bytes);
      await harness.store.executionWorkspaces.upsertWorkspaceFile({
        clientInstanceId: harness.clientInstanceId,
        workspaceId: workspace.id,
        path: "previews/report/page-1.png",
        objectKey,
        byteSize: bytes.byteLength,
        checksum: `sha256:${version}`,
        mimeType: "image/png",
        updatedAt: "2026-06-29T12:01:00.000Z"
      });
    };
    const look = async () => {
      const previewed = await harness.runTool("workspace.preview_images", {
        path: "previews/report/page-1.png"
      });
      if (previewed.status !== "success") {
        throw new Error("Expected preview_images to succeed");
      }
      return text(array(jsonObject(previewed.output).images).map(jsonObject)[0]?.imageArtifactId);
    };
    const storedArtifacts = () =>
      harness.store.files.listConversationManagedArtifacts({
        clientInstanceId: harness.clientInstanceId,
        conversationId: harness.conversation.id
      });

    await putVersion("first");
    const firstLook = await look();
    const secondLook = await look();

    expect(secondLook).toBe(firstLook);
    expect((await storedArtifacts()).map((artifact) => artifact.id)).toEqual([firstLook]);

    await putVersion("second");
    const changedLook = await look();

    expect(changedLook).not.toBe(firstLook);
    const stored = await storedArtifacts();
    expect(stored.map((artifact) => artifact.id).sort()).toEqual([firstLook, changedLook].sort());
    expect(stored.find((artifact) => artifact.id === changedLook)).toMatchObject({
      checksum: "sha256:second",
      metadata: { workspaceId: workspace.id, workspacePath: "previews/report/page-1.png" }
    });
  });

  it("asks to recreate a preview whose bytes are gone after an earlier successful look", async () => {
    const harness = await createWorkspaceHarness();
    const objectKey = "execution-workspaces/private/previews/gone/page-1.png";
    await harness.putWorkspaceFile({
      path: "previews/gone/page-1.png",
      objectKey,
      bytes: encode("page-1"),
      mimeType: "image/png"
    });
    const first = await harness.runTool("workspace.preview_images", {
      path: "previews/gone/page-1.png"
    });
    expect(first.status).toBe("success");

    await harness.objectStore.delete(objectKey);
    const second = await harness.runTool("workspace.preview_images", {
      path: "previews/gone/page-1.png"
    });

    expect(second).toMatchObject({
      status: "failed",
      error: {
        code: "handler_failed",
        message: expect.stringContaining("Recreate the preview before inspecting it")
      }
    });
    expect(JSON.stringify(second)).not.toContain('"status":"ready"');
  });

  it("does not register a ready preview artifact when workspace bytes are missing", async () => {
    const harness = await createWorkspaceHarness();
    const workspace = await harness.store.executionWorkspaces.ensureExecutionWorkspace({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id,
      ownerUserId: harness.ownerUserId,
      now: "2026-06-29T12:00:00.000Z"
    });
    await harness.store.executionWorkspaces.upsertWorkspaceFile({
      clientInstanceId: harness.clientInstanceId,
      workspaceId: workspace.id,
      path: "previews/missing/page-1.png",
      objectKey: "execution-workspaces/missing/page-1.png",
      byteSize: 123,
      checksum: "sha256:missing-preview",
      mimeType: "image/png",
      updatedAt: "2026-06-29T12:01:00.000Z"
    });

    const previewed = await harness.runTool("workspace.preview_images", {
      path: "previews/missing/page-1.png"
    });

    expect(previewed).toMatchObject({
      status: "failed",
      error: {
        code: "handler_failed",
        message: expect.stringContaining("not available in durable storage")
      }
    });
    expect(
      await harness.store.files.listConversationManagedArtifacts({
        clientInstanceId: harness.clientInstanceId,
        conversationId: harness.conversation.id
      })
    ).toEqual([]);
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

async function expectToolFailure(toolName: string, input: unknown, code: string, message: RegExp) {
  const harness = await createWorkspaceHarness();
  const result = await harness.runTool(toolName, input);
  expect(result.status).toBe("failed");
  if (result.status === "failed") {
    expect(result.error.code).toBe(code);
    expect(result.error.message).toMatch(message);
  }
}

async function waitForQueuedCommand(
  harness: Awaited<ReturnType<typeof createWorkspaceHarness>>
): Promise<void> {
  await waitUntil(async () => {
    const counts = await harness.store.executionWorkspaces.countActiveWorkspaceCommands({
      clientInstanceId: harness.clientInstanceId,
      conversationId: harness.conversation.id
    });
    return counts.queued === 1;
  }, "the workspace command is queued before cancelling its run");
}
