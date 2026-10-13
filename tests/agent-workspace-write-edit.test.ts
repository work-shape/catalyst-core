import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalAgentRuntime } from "@vivd-catalyst/agent-runtime";
import {
  createPageBuildClient,
  createPageBundleJobs,
  createSandboxPageBuild
} from "@vivd-catalyst/chat-server";
import type { JobWorker, Logger } from "@vivd-catalyst/core";
import { modelContentText } from "@vivd-catalyst/model-provider";
import { createPostgresJobWorker } from "@vivd-catalyst/postgres-store";
import {
  createPageSaveTool,
  createWorkspaceToolDefinitions,
  LocalWorkspaceCommandProcessExecutor,
  ToolRegistry,
  WorkspaceCommandService
} from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { withTestModelGateway, type FakeModelProvider } from "./support/model-gateway";
import { htmlManifest, pageBuildCommandFromSource } from "./support/page-build";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestToolRunner } from "./support/tool-runner";
import { createWorkspaceHarness } from "./support/workspace-tools-harness";

// An agent run with a scripted model: the agent writes the files of a Page with
// `workspace.write_file`, changes one with `workspace.edit_file`, reads it back and saves the
// folder with `page.save`. The build runs as the instance runs it: a `page.bundle` job on
// Postgres, in the local sandbox.
//
// Fails without the change: the first two calls name tools that did not exist, so the model
// read "not registered" where it expects the written paths.

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

const toolOutputSchema = z.looseObject({
  path: z.string().optional(),
  created: z.boolean().optional(),
  editsApplied: z.number().optional(),
  contentPreview: z.string().optional(),
  number: z.number().optional(),
  errors: z.array(z.unknown()).optional()
});

let buildCommand: string;
let scratch: string;
const workers: JobWorker[] = [];

beforeAll(async () => {
  buildCommand = await pageBuildCommandFromSource();
  scratch = await mkdtemp(join(tmpdir(), "agent-write-edit-test-"));
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("an agent that writes and edits workspace files", () => {
  it("writes a Page's files, edits one, reads it back and saves the folder as a Page", async () => {
    const harness = await createWorkspaceHarness();
    const { store, clientInstanceId, objectStore, context } = harness;
    // The harness's own conversation has a run already, and a conversation has one at a time.
    const conversation = await store.conversations.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: harness.conversation.collaborationWorkspaceId,
      createdByUserId: harness.ownerUserId,
      createdByExternalUserId: harness.ownerUserId,
      title: "Report page",
      retainedUntil: "2026-07-29T00:00:00.000Z"
    });
    const service = new WorkspaceCommandService({
      store,
      objectStore,
      fileStore: objectStore,
      now: () => new Date().toISOString()
    });
    const pageObjects = new MemoryObjectStorage();
    const pageSave = createPageSaveTool({
      workspace: service.dependencies,
      builds: createPageBuildClient({ stores: store, pollIntervalMs: 20 })
    });
    const tools = [...createWorkspaceToolDefinitions({ service }), pageSave];
    const granted = [
      "workspace.write_file",
      "workspace.edit_file",
      "workspace.read_file",
      pageSave.name
    ];
    const runTool = createTestToolRunner({
      registry: new ToolRegistry({ tools }),
      getAgentToolNames: () => granted
    });
    const { handlers } = createPageBundleJobs({
      clientInstanceId,
      stores: store,
      pages: { objects: pageObjects },
      workspaceObjects: objectStore,
      logger: silent,
      build: createSandboxPageBuild({
        sandbox: new LocalWorkspaceCommandProcessExecutor(),
        tempRoot: join(scratch, "builds"),
        command: buildCommand
      })
    });
    const worker = createPostgresJobWorker({
      stores: store,
      clientInstanceId,
      logger: silent,
      handlers
    });
    workers.push(worker);
    worker.start();

    const outputs = (
      messages: Parameters<FakeModelProvider["complete"]>[0]["messages"],
      toolCallId: string
    ) => {
      const message = messages.find(
        (candidate) => candidate.role === "tool" && candidate.toolCallId === toolCallId
      );
      return toolOutputSchema.parse(JSON.parse(modelContentText(message?.content ?? "")));
    };
    let step = 0;
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete(request) {
        step += 1;
        const usage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          source: "not_reported" as const,
          webSearchCallCount: 0
        };
        switch (step) {
          case 1:
            return {
              text: "I write the files of the Page.",
              toolCalls: [
                {
                  toolCallId: "call_manifest",
                  toolName: "workspace.write_file",
                  input: { path: "report/app.yaml", content: htmlManifest }
                },
                {
                  toolCallId: "call_page",
                  toolName: "workspace.write_file",
                  input: {
                    path: "/workspace/report/index.html",
                    content: "<!doctype html>\n<title>Report</title>\n<h1>Draft</h1>\n"
                  }
                }
              ],
              usage
            };
          case 2:
            expect(outputs(request.messages, "call_manifest")).toMatchObject({
              path: "report/app.yaml",
              created: true
            });
            expect(outputs(request.messages, "call_page")).toMatchObject({
              path: "report/index.html",
              created: true
            });
            return {
              text: "I change the heading.",
              toolCalls: [
                {
                  toolCallId: "call_edit",
                  toolName: "workspace.edit_file",
                  input: {
                    path: "report/index.html",
                    edits: [{ oldText: "<h1>Draft</h1>", newText: "<h1>Revenue 2026</h1>" }]
                  }
                }
              ],
              usage
            };
          case 3:
            expect(outputs(request.messages, "call_edit")).toMatchObject({ editsApplied: 1 });
            return {
              text: "I read the file back.",
              toolCalls: [
                {
                  toolCallId: "call_read",
                  toolName: "workspace.read_file",
                  input: { path: "report/index.html" }
                }
              ],
              usage
            };
          case 4:
            expect(outputs(request.messages, "call_read").contentPreview).toBe(
              "<!doctype html>\n<title>Report</title>\n<h1>Revenue 2026</h1>\n"
            );
            return {
              text: "I save the Page.",
              toolCalls: [
                {
                  toolCallId: "call_save",
                  toolName: pageSave.name,
                  input: { name: "Report", directory: "report" }
                }
              ],
              usage
            };
          case 5: {
            const saved = outputs(request.messages, "call_save");
            expect(saved.errors).toBeUndefined();
            expect(saved.number).toBe(1);
            return { text: "The Page is saved.", toolCalls: [], usage };
          }
          default:
            throw new Error(`Unexpected model step ${step}`);
        }
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "workspace_agent",
              displayName: "Workspace Agent",
              instructions: "Write files, edit them and save the Page.",
              modelProviderId: "test-provider",
              toolNames: granted,
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [{ id: "test-provider", type: "deterministic", model: "test-model" }],
        defaultModelProvider: { id: "test-provider", type: "deterministic", model: "test-model" },
        conversationHistory: store.conversations,
        agentRunStore: store.agentRuns,
        runObservationStore: store.agentRuns,
        modelProvider,
        toolRegistry: new ToolRegistry({ tools }),
        runTool,
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );
    const inputMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "Build the report page."
    });

    const run = await runtime.start(
      {
        agentName: "workspace_agent",
        conversationId: conversation.id,
        inputMessageId: inputMessage.id,
        message: { text: "Build the report page." }
      },
      context
    );
    const completed: string[] = [];
    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "message_completed") {
        completed.push(event.message.text);
      }
    }

    expect(step).toBe(5);
    expect(completed.at(-1)).toBe("The Page is saved.");
    // The Page was built from the files as the two tools left them.
    const [page] = await store.pages.listPages({
      clientInstanceId,
      conversationId: conversation.id
    });
    if (!page) throw new Error("The save stored no Page");
    await expect(
      store.pages.getPageFileSet({ clientInstanceId, pageId: page.id })
    ).resolves.toMatchObject({ number: 1, manifest: { entry: "index.html" } });
    const builtKey = pageObjects.keys().find((key) => key.endsWith("index.html"));
    if (!builtKey) throw new Error("The built Page has no index.html");
    const chunks: Uint8Array[] = [];
    for await (const chunk of (await pageObjects.get(builtKey)).body) {
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toContain("<h1>Revenue 2026</h1>");
  }, 120_000);
});
