import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { LocalAgentRuntime } from "@vivd-catalyst/agent-runtime";
import { buildPage } from "@vivd-catalyst/app-build/build";
import { SkillMarkdownError, parseSkillMarkdown } from "@vivd-catalyst/asset-schemas";
import { loadSecretKeyring } from "@vivd-catalyst/connections";
import {
  asClientInstanceId,
  isAppError,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { createDataStores } from "@vivd-catalyst/data-stores";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { ToolRegistry } from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { readWorkflowManifest } from "@vivd-catalyst/workflows";
import { errorSchema } from "./support/access-instance";
import { setupAppInstance, type AppInstance } from "./support/app-instance";
import { putAgent, putSkill, setupRelease, syncAsService } from "./support/asset-release";
import {
  hostileDocuments,
  hostileJsonStrings,
  withinBound,
  type HostileDocument
} from "./support/hostile-input";
import {
  silentTestLogger,
  withTestModelGateway,
  type FakeModelProvider
} from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";
import { createTestToolRunner } from "./support/tool-runner";

// Every reader of untrusted input, each run through the same hostile documents: each answers a
// refusal that names the problem within the bound, and none hangs, crashes or answers a 500.

const lenient = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const indexHtml = { path: "index.html", text: "<!doctype html><title>Hostile</title><p>x</p>" };

describe.each(hostileDocuments)("the hostile document '$name'", (document: HostileDocument) => {
  it("is refused as the frontmatter of a SKILL.md", async () => {
    const thrown = await withinBound(document.name, () => {
      try {
        parseSkillMarkdown(
          `---\n${lenient(document.bytes)}\n---\nBody.`,
          "SKILL.md",
          "skills/hostile/SKILL.md"
        );
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(thrown).toBeInstanceOf(SkillMarkdownError);
  });

  it("is refused as workflow.yaml", async () => {
    const read = await withinBound(document.name, () =>
      readWorkflowManifest(lenient(document.bytes))
    );
    expect(read.ok).toBe(false);
  });

  it("is refused as app.yaml and as an App's action file by the build", async () => {
    const manifest = await withinBound(document.name, () =>
      buildPage({ files: [{ path: "app.yaml", bytes: document.bytes }] })
    );
    expect(manifest).toMatchObject({
      status: "errors",
      errors: [expect.objectContaining({ file: "app.yaml", code: "manifest_invalid" })]
    });
    const action = await withinBound(document.name, () =>
      buildPage({
        files: [
          {
            path: "app.yaml",
            bytes: new TextEncoder().encode("id: hostile\nname: Hostile\nkit: 1.0.0\n")
          },
          { path: "actions/hostile.action.yaml", bytes: document.bytes }
        ]
      })
    );
    expect(action).toMatchObject({
      status: "errors",
      errors: [
        expect.objectContaining({ file: "actions/hostile.action.yaml", code: "action_invalid" })
      ]
    });
  });

  it("is refused as store.yaml", async () => {
    const instance = await createTestInstance();
    const key = randomBytes(32).toString("base64");
    const dataStores = createDataStores({
      clientInstanceId: asClientInstanceId("hostile-input"),
      stores: instance.stores,
      databaseUrl: "postgres://unused.invalid/none",
      keyring: await loadSecretKeyring({
        keys: [{ id: "k1", ref: "HOSTILE_INPUT_TEST_KEY" }],
        secrets: { resolve: () => Promise.resolve(key) }
      }),
      limits: { sizeLimitBytes: 1024 ** 3, poolMaxConnections: 1 },
      logger: silentTestLogger
    });
    try {
      const thrown = await withinBound(document.name, () => {
        try {
          dataStores.readFiles([{ path: "store.yaml", bytes: document.bytes }]);
          return undefined;
        } catch (error) {
          return error;
        }
      });
      expect(isAppError(thrown) && thrown.code).toBe("VALIDATION_FAILED");
    } finally {
      await dataStores.close();
    }
  });
});

describe("a write of an App's files over the API", () => {
  let t: AppInstance;
  beforeAll(async () => {
    // The build is the real one, in this process: what the sandbox runs on the files.
    t = await setupAppInstance({ build: ({ files, signal }) => buildPage({ files, signal }) });
  }, 120_000);
  afterAll(async () => {
    await t.close();
  });

  it.each(hostileDocuments)("refuses '$name' as app.yaml with a 4xx", async (document) => {
    const response = await withinBound(document.name, () =>
      t.instance.call("assets.put", {
        params: { kind: "app", name: "hostile" },
        payload: {
          expectedRevision: null,
          workspaceId: t.workspaceId,
          files: [{ path: "app.yaml", base64: base64(document.bytes) }, indexHtml]
        },
        headers: { "x-test-user": t.admin.id }
      })
    );
    expect(response.statusCode).toBe(422);
    expect(errorSchema.parse(response.json()).error.code).toBe("VALIDATION_FAILED");
  });
});

describe("a config push through assets.sync", () => {
  let t: Awaited<ReturnType<typeof setupRelease>>;
  beforeAll(async () => {
    t = await setupRelease();
  }, 120_000);

  it.each(hostileJsonStrings)(
    "refuses a skill or an agent that holds a $name, and stores nothing",
    async ({ value }) => {
      const before = await t.version();
      for (const item of [
        putSkill("hostile-skill", value),
        putAgent("hostile-agent", { instructions: value })
      ]) {
        const response = await withinBound(value, () => syncAsService(t, [item]));
        expect(response.statusCode).toBe(422);
        expect(errorSchema.parse(response.json()).error).toMatchObject({
          code: "VALIDATION_FAILED",
          details: {
            reason: "sync_refused",
            issues: [expect.objectContaining({ message: expect.stringContaining("NUL character") })]
          }
        });
      }
      expect(await t.version()).toBe(before);
    }
  );

  it("takes the same skill without the text", async () => {
    const response = await syncAsService(t, [putSkill("hostile-skill", "plain")]);
    expect(response.statusCode).toBe(200);
  });

  it("refuses a nesting deeper than any config holds, and a body over the limit", async () => {
    let deep: unknown = "leaf";
    for (let level = 0; level < 5_000; level += 1) deep = [deep];
    const nested = await withinBound("deep", () =>
      syncAsService(t, [putAgent("hostile-agent", { instructions: deep })])
    );
    expect(nested.statusCode).toBeGreaterThanOrEqual(400);
    expect(nested.statusCode).toBeLessThan(500);

    const huge = await withinBound("huge", () =>
      syncAsService(t, [putSkill("hostile-skill", "x".repeat(21 * 1024 * 1024))])
    );
    expect(huge.statusCode).toBe(400);
    expect(errorSchema.parse(huge.json()).error.details).toMatchObject({
      reason: "body_too_large"
    });
  });
});

describe("a tool call whose arguments hold text Postgres cannot store", () => {
  const storedToolCallsSchema = z.looseObject({
    agentRuntime: z.looseObject({
      toolCalls: z.array(z.looseObject({ toolCallId: z.string(), input: z.unknown() }))
    })
  });

  it.each(hostileJsonStrings)(
    "is refused to the model as a tool error, with a $name, and the run goes on",
    async ({ value }) => {
      const clientInstanceId = asClientInstanceId("hostile-tool-input");
      const context: RuntimeCallContext = {
        clientInstanceId,
        correlationId: "corr-hostile-tool-input",
        user: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "User",
          roles: ["user"],
          permissionRefs: [],
          clientInstanceId,
          authSource: "test"
        }
      };
      const instance = await createTestInstance();
      const store = instance.stores;
      const conversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: "user-1",
        createdByExternalUserId: "user-1",
        title: "Hostile tool input",
        retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
      });
      let executions = 0;
      const tools = new ToolRegistry({
        tools: [
          defineTool({
            name: "test.note",
            description: "Keeps a note.",
            effect: "reading",
            inputSchema: z.object({ note: z.string() }),
            execute() {
              executions += 1;
              return toolSuccess({ kept: true });
            }
          })
        ]
      });
      const usage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        source: "not_reported" as const,
        webSearchCallCount: 0
      };
      let toolAnswer = "";
      const modelProvider: FakeModelProvider = {
        id: "test-provider",
        async complete(request) {
          const toolMessage = request.messages.find((message) => message.role === "tool");
          if (!toolMessage) {
            return {
              text: "I will keep a note.",
              toolCalls: [
                { toolCallId: "call_hostile", toolName: "test.note", input: { note: value } }
              ],
              usage
            };
          }
          toolAnswer = JSON.stringify(toolMessage.content);
          return { text: "Done without the note.", toolCalls: [], usage };
        }
      };
      const providerConfig: ModelProviderConfig = {
        id: "test-provider",
        type: "deterministic",
        model: "test-model"
      };
      const runtime = new LocalAgentRuntime(
        withTestModelGateway({
          assetSource: createStaticConfigAssetSource({
            agents: [
              {
                skillNames: [],
                name: "hostile_agent",
                displayName: "Hostile Agent",
                instructions: "Keep notes.",
                modelProviderId: "test-provider",
                toolNames: ["test.note"],
                initialPrompts: []
              }
            ]
          }),
          modelProviders: [providerConfig],
          defaultModelProvider: providerConfig,
          conversationHistory: store.conversations,
          modelProvider,
          toolRegistry: tools,
          runTool: createTestToolRunner({
            registry: tools,
            getAgentToolNames: () => ["test.note"]
          }),
          usageGovernance: new ModelUsageGovernance({
            store: store.usage,
            budget: {},
            safeguards: {}
          })
        })
      );

      const run = await runtime.start(
        { agentName: "hostile_agent", conversationId: conversation.id, message: { text: "Note." } },
        context
      );
      const failedTools: unknown[] = [];
      const ends: string[] = [];
      for await (const event of runtime.observe(run.runId, context)) {
        if (event.type === "tool_call_failed" && event.result.status !== "success") {
          failedTools.push(event.result.error);
        }
        if (event.type === "run_completed" || event.type === "run_failed") ends.push(event.type);
      }

      expect(ends).toEqual(["run_completed"]);
      expect(executions).toBe(0);
      expect(failedTools).toEqual([
        expect.objectContaining({
          code: "validation_failed",
          details: { issues: [expect.objectContaining({ code: "invalid_text" })] }
        })
      ]);
      expect(toolAnswer).toContain("invalid_text");
      const messages = await store.conversations.listMessages({
        clientInstanceId,
        conversationId: conversation.id
      });
      const stored = messages
        .map((message) => storedToolCallsSchema.safeParse(message.metadata))
        .flatMap((parsed) => (parsed.success ? parsed.data.agentRuntime.toolCalls : []));
      expect(stored).toEqual([{ toolCallId: "call_hostile", toolName: "test.note", input: {} }]);
      await instance.close();
    }
  );
});
