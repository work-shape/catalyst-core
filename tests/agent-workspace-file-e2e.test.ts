import { createTestInstance } from "./support/test-instance";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asClientInstanceId, asManagedFileId, type RuntimeCallContext } from "@vivd-catalyst/core";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { LocalAgentRuntime } from "@vivd-catalyst/agent-runtime";
import { modelContentText, type ModelProvider } from "@vivd-catalyst/model-provider";
import {
  createLocalWorkspaceFileByteStore,
  createWorkspaceToolDefinitions,
  InProcessToolExecution,
  LocalWorkspaceCommandResultSource,
  LocalWorkspaceCommandRunner,
  ToolRegistry,
  WorkspaceCommandService
} from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

describe("agent workspace file e2e", () => {
  it("imports an uploaded file, executes a read command, and answers from stdout", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "agent-workspace-file-e2e-"));
    try {
      const clientInstanceId = asClientInstanceId("agent-workspace-file-e2e-client");
      const store = (await createTestInstance()).stores;
      const conversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: "user-1",
        createdByExternalUserId: "user-1",
        title: "Read uploaded deck",
        retainedUntil: "2026-07-29T00:00:00.000Z"
      });
      const inputMessage = await store.conversations.appendMessage({
        clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "Can you read the uploaded file?"
      });
      const context: RuntimeCallContext = {
        clientInstanceId,
        correlationId: "corr-agent-workspace-file-e2e",
        user: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "Workspace User",
          roles: ["user"],
          permissionRefs: [],
          clientInstanceId,
          authSource: "test"
        }
      };
      const sourceFile = {
        fileId: asManagedFileId("file_status_deck"),
        filename: "status-deck.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode(
          [
            "MUSTERBAU",
            "KI-Agentenplattform",
            "Status update: workspace file reading works."
          ].join("\n")
        )
      };
      const byteStore = createLocalWorkspaceFileByteStore({
        rootDirectory: join(rootDirectory, "objects")
      });
      const runner = new LocalWorkspaceCommandRunner({
        store,
        byteStore,
        tempRootDirectory: join(rootDirectory, "commands")
      });
      const service = new WorkspaceCommandService({
        store,
        objectStore: byteStore,
        fileStore: byteStore,
        sourceFileReader: {
          async readSourceFile(input) {
            expect(input.fileId).toBe(sourceFile.fileId);
            return { ...sourceFile, byteSize: sourceFile.bytes.byteLength };
          }
        },
        commandResults: new LocalWorkspaceCommandResultSource(runner),
        execResultWaitMs: 5000,
        execResultPollIntervalMs: 10
      });
      const tools = createWorkspaceToolDefinitions({ service });
      const toolExecution = new InProcessToolExecution({
        registry: new ToolRegistry({ tools }),
        getAgentToolNames: () => tools.map((tool) => tool.name)
      });
      let modelStep = 0;
      let sawImportOutput = false;
      let sawExecStdout = false;
      const modelProvider: ModelProvider = {
        id: "test-provider",
        async complete(request) {
          modelStep += 1;
          if (modelStep === 1) {
            return {
              text: "I will import the uploaded file.",
              toolCalls: [
                {
                  toolCallId: "call_import",
                  toolName: "workspace.import_files",
                  input: {
                    files: [{ fileId: sourceFile.fileId }]
                  }
                }
              ],
              usage: noReportedUsage()
            };
          }

          if (modelStep === 2) {
            const importOutput = toolOutputText(request.messages, "call_import");
            expect(importOutput).toContain("status-deck.txt");
            expect(importOutput).not.toContain("execution-workspaces/");
            const imported = JSON.parse(importOutput) as {
              importedFiles?: Array<{ path?: string }>;
            };
            const importedPath = imported.importedFiles?.[0]?.path;
            expect(importedPath).toBe("inputs/status-deck.txt");
            const script = [
              "const fs=require('node:fs');",
              `const text=fs.readFileSync(${JSON.stringify(importedPath)},'utf8');`,
              "console.log(JSON.stringify({title:text.split('\\n')[0], containsStatus:text.includes('Status update')}));"
            ].join(" ");
            sawImportOutput = true;
            return {
              text: "I will read the imported workspace file.",
              toolCalls: [
                {
                  toolCallId: "call_read",
                  toolName: "workspace.exec",
                  input: {
                    command: `node -e ${JSON.stringify(script)}`
                  }
                }
              ],
              usage: noReportedUsage()
            };
          }

          if (modelStep === 3) {
            const execOutput = toolOutputText(request.messages, "call_read");
            expect(execOutput).toContain("stdoutPreview");
            expect(execOutput).toContain("MUSTERBAU");
            expect(execOutput).toContain("containsStatus");
            sawExecStdout = true;
            return {
              text: "I can read the uploaded file. Title: MUSTERBAU.",
              toolCalls: [],
              usage: noReportedUsage()
            };
          }

          throw new Error(`Unexpected model step ${modelStep}`);
        }
      };
      const runtime = new LocalAgentRuntime({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "workspace_file_agent",
              displayName: "Workspace File Agent",
              instructions:
                "Import uploaded files with workspace.import_files, inspect them with workspace.exec, and answer from stdout.",
              modelProviderId: "test-provider",
              toolNames: tools.map((tool) => tool.name),
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [
          {
            id: "test-provider",
            type: "deterministic",
            model: "test-model"
          }
        ],
        defaultModelProvider: {
          id: "test-provider",
          type: "deterministic",
          model: "test-model"
        },
        conversationHistory: store.conversations,
        agentRunStore: store.agentRuns,
        runObservationStore: store.agentRuns,
        modelProvider,
        toolRegistry: new ToolRegistry({ tools }),
        toolExecution,
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      });

      const run = await runtime.start(
        {
          agentName: "workspace_file_agent",
          conversationId: conversation.id,
          inputMessageId: inputMessage.id,
          message: {
            text: "Can you read the uploaded file?"
          }
        },
        context
      );

      const completedMessages: string[] = [];
      for await (const event of runtime.observe(run.runId, context)) {
        if (event.type === "message_completed") {
          completedMessages.push(event.message.text);
        }
      }

      expect(sawImportOutput).toBe(true);
      expect(sawExecStdout).toBe(true);
      expect(completedMessages.at(-1)).toBe(
        "I can read the uploaded file. Title: MUSTERBAU."
      );
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});

function toolOutputText(
  messages: Parameters<ModelProvider["complete"]>[0]["messages"],
  toolCallId: string
): string {
  const message = messages.find(
    (candidate) => candidate.role === "tool" && candidate.toolCallId === toolCallId
  );
  return modelContentText(message?.content ?? "");
}

function noReportedUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source: "not_reported" as const,
    webSearchCallCount: 0
  };
}
