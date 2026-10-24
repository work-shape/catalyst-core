import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  personalDataConversation,
  createOperationRegistry,
  type AgentRunModelOrigin,
  type AgentRuntimeEvent,
  type ConversationId,
  type OperationDefinition,
  type RuntimeCallContext,
  type ToolOperationRunner,
  type WebAccessConfig
} from "@work-shape/catalyst-core";
import type { ModelCompletionRequest, ModelToolCall } from "@work-shape/catalyst-model-provider";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import {
  createRecordingGovernance,
  silentTestLogger,
  withTestModelGateway
} from "./support/model-gateway";
import { usePostgresSuite } from "./support/postgres-suite";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createSubagentFixture } from "./support/subagent-runs";

// MODEL-REGION-3: once the root chat carries the personal-data mark, every model request of a
// run in the conversation goes only to a route whose region is in the list. Checked before
// each request in the runtime, so a later turn, a sibling's mark mid-run and a subagent's
// parent are all held to it. A subagent's routes include those of the run above it.

const SHARED = "connection.shared.read";
const call = (toolName: string): ModelToolCall => ({ toolName, toolCallId: toolName, input: {} });
const webAccess: WebAccessConfig = {
  enabled: true,
  search: { enabled: true },
  fetch: {
    enabled: true,
    timeoutMs: 1000,
    maxResponseBytes: 1024,
    maxTextCharacters: 1024,
    maxRedirects: 0
  }
};

describe("MODEL-REGION-3 a marked conversation keeps every model request on allowed routes", () => {
  const db = usePostgresSuite("personal_model_region");

  async function fixture() {
    const f = await createSubagentFixture(db, "model_region");
    const conversation = await f.createConversation("Personal data");
    const context: RuntimeCallContext = {
      clientInstanceId: f.clientInstanceId,
      correlationId: "personal-model-region",
      user: {
        id: f.user.id,
        externalUserId: "user_test",
        displayLabel: "Author",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId: f.clientInstanceId,
        authSource: "test"
      }
    };
    const operations = createOperationRegistry();
    const shared: OperationDefinition = {
      name: SHARED,
      effect: "reading",
      action: "connection.use",
      resource: () => ({ kind: "connection", id: SHARED }),
      timeoutMs: 1000,
      scope: null,
      auth: "principal",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      execute: async () => ({})
    };
    operations.addSource({
      resolve: async (name) => (name === SHARED ? shared : undefined),
      list: async () => ({ operations: [shared], truncated: [] })
    });
    const runTool = vi.fn<ToolOperationRunner>(async () => ({
      status: "success" as const,
      output: {}
    }));
    const mark = () =>
      db.store.conversations.markPersonalData({
        ...f.scope,
        conversationId: conversation.id,
        userId: f.user.id,
        at: "2026-10-25T10:00:00.000Z"
      });

    async function run(
      script: ModelToolCall[][],
      input: {
        conversationId?: ConversationId;
        modelBindingId?: string;
        agentName?: string;
        subagent?: boolean;
        ancestors?: AgentRunModelOrigin[];
        /** Release config's list; left out, the Connections module is off. */
        personalModelRegions?: readonly string[] | null;
        withoutReaders?: boolean;
        webAccessOn?: boolean;
        personalConversation?: (id: ConversationId) => Promise<boolean>;
        beforeRequest?: (step: number) => Promise<void>;
      } = {}
    ) {
      const requests: ModelCompletionRequest[] = [];
      const provider = { id: "test", type: "deterministic", model: "test", region: "eu" };
      const regions =
        input.personalModelRegions === null ? undefined : (input.personalModelRegions ?? ["eu"]);
      const agent = (name: string, modelBindingId: string) => ({
        name,
        displayName: { en: name, de: name },
        instructions: "Answer.",
        modelBindingId,
        userSelectableModelBindingIds: ["outside", "eu-default"],
        toolNames: [SHARED],
        skillNames: [],
        initialPrompts: []
      });
      const runtime = new LocalAgentRuntime(
        withTestModelGateway({
          logger: silentTestLogger,
          assetSource: createStaticConfigAssetSource({
            agents: [agent("test_agent", "eu-default"), agent("outsider", "outside")]
          }),
          defaultModelProvider: provider,
          modelProviders: [provider, { ...provider, id: "outside", region: "us" }],
          modelBindings: [
            { id: "eu-default", providerId: "test", agentSelectable: true },
            { id: "outside", providerId: "outside", agentSelectable: true }
          ],
          conversationHistory: db.store.conversations,
          ...(regions ? { personalModelRegions: regions } : {}),
          ...(input.withoutReaders
            ? {}
            : {
                personalData: {
                  personalConversation:
                    input.personalConversation ??
                    ((id) => personalDataConversation(db.store, f.scope.clientInstanceId, id)),
                  operations
                }
              }),
          ...(input.webAccessOn ? { webAccess } : {}),
          toolRegistry: new ToolRegistry({ tools: [] }),
          dataTools: {
            describe: async () => [
              {
                name: SHARED,
                description: SHARED,
                effect: "reading",
                inputJsonSchema: { type: "object" }
              }
            ]
          },
          usageGovernance: createRecordingGovernance(),
          modelProvider: {
            id: provider.id,
            async complete(request) {
              requests.push(structuredClone(request));
              await input.beforeRequest?.(requests.length);
              return {
                text: "done",
                toolCalls: script[requests.length - 1] ?? [],
                usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  source: "not_reported",
                  webSearchCallCount: 0
                }
              };
            }
          },
          runTool
        })
      );
      const conversationId = input.conversationId ?? conversation.id;
      const inputMessageId = (
        await db.store.conversations.appendMessage({
          ...f.scope,
          conversationId,
          role: "user",
          text: "Go on"
        })
      ).id;
      const handle = await runtime.start(
        {
          agentName: input.agentName ?? "test_agent",
          modelBindingId: input.modelBindingId,
          conversationId,
          inputMessageId,
          ...(input.ancestors ? { ancestors: input.ancestors } : {}),
          message: { text: "Go on" }
        },
        { ...context, ...(input.subagent ? { subagent: true } : {}) }
      );
      const events: AgentRuntimeEvent[] = [];
      for await (const event of runtime.observe(handle.runId, context)) events.push(event);
      const last = events.at(-1);
      return {
        requests,
        events,
        failure: last?.type === "run_failed" ? last.error : undefined,
        completed: last?.type === "run_completed"
      };
    }
    return { ...f, conversation, run, mark, runTool };
  }

  const refusedRegion = {
    code: "personal_data_model_region",
    category: "app_error",
    message:
      "This conversation holds data from a personal connection, so it can only use a model in a region allowed for that: eu. Choose another model or start a new conversation."
  };

  it("refuses the reviewer's later turn on a us model before anything reaches the gateway", async () => {
    const f = await fixture();
    // The first turn runs on eu and reads mail: the conversation carries the mark.
    expect((await f.run([[]])).completed).toBe(true);
    await f.mark();
    const picked = await f.run([[]], { modelBindingId: "outside" });
    expect(picked.failure).toEqual(refusedRegion);
    expect(picked.requests).toHaveLength(0);
    // A run that falls back to an agent's own us model is refused the same way.
    const fallback = await f.run([[]], { agentName: "outsider" });
    expect(fallback.failure).toEqual(refusedRegion);
    expect(fallback.requests).toHaveLength(0);
    // The refusal carries no content or route: only the reason and the allowed regions.
    expect(JSON.stringify(picked.events)).not.toMatch(/outside|"us"|Go on/u);
    // The same conversation goes on on eu.
    expect((await f.run([[]])).completed).toBe(true);
  });

  it("fails the next request of a us run when a sibling's personal call marks the root mid-run", async () => {
    const f = await fixture();
    const parent = await f.startParent(f.conversation);
    const child = await f.startChild(parent.run, "research");
    const result = await f.run([[call(SHARED)], []], {
      conversationId: child.threadId,
      subagent: true,
      modelBindingId: "outside",
      beforeRequest: async (step) => {
        if (step === 1) await f.mark();
      }
    });
    expect(result.requests).toHaveLength(1);
    expect(result.failure).toEqual(refusedRegion);
  });

  it("applies with web access off for the instance", async () => {
    const f = await fixture();
    await f.mark();
    expect((await f.run([[]], { modelBindingId: "outside" })).failure).toEqual(refusedRegion);
    expect((await f.run([[]], { modelBindingId: "outside", webAccessOn: true })).failure).toEqual(
      refusedRegion
    );
  });

  it("refuses a route outside the list where the mark cannot be read, and runs an allowed one", async () => {
    const f = await fixture();
    const unreadable = vi.fn(() => Promise.reject(new Error("mark unreadable")));
    const failClosed = (id: ConversationId) =>
      personalDataConversation(
        { conversations: { getConversation: unreadable } },
        f.scope.clientInstanceId,
        id
      );
    const outside = await f.run([[]], {
      modelBindingId: "outside",
      personalConversation: failClosed
    });
    expect(outside.failure).toEqual(refusedRegion);
    expect(outside.requests).toHaveLength(0);
    expect((await f.run([[]], { personalConversation: failClosed })).completed).toBe(true);
  });

  it("leaves unmarked conversations, instances without Connections and a widened list as before", async () => {
    const f = await fixture();
    expect((await f.run([[call(SHARED)], []], { modelBindingId: "outside" })).completed).toBe(true);
    await f.mark();
    expect(
      (await f.run([[]], { modelBindingId: "outside", personalModelRegions: null })).completed
    ).toBe(true);
    expect(
      (await f.run([[]], { modelBindingId: "outside", personalModelRegions: ["eu", "us"] }))
        .completed
    ).toBe(true);
  });

  it("requires the personal-data readers wherever the list is set", async () => {
    const f = await fixture();
    await expect(f.run([[]], { withoutReaders: true })).rejects.toThrow(
      "Personal model regions require personal-data readers"
    );
  });

  it("hands a subagent's calls its own route and the routes of the run above it", async () => {
    const f = await fixture();
    const parent = await f.startParent(f.conversation);
    const child = await f.startChild(parent.run, "research");
    await f.run([[call(SHARED)], []], {
      conversationId: child.threadId,
      subagent: true,
      ancestors: [{ agentName: "test_agent", modelBindingId: "outside" }]
    });
    expect(f.runTool.mock.calls[0]?.[1].modelRoutes).toEqual([
      { id: "test", region: "eu" },
      { id: "outside", region: "us" }
    ]);
    // A run above it whose model cannot be read is a route without a region.
    f.runTool.mockClear();
    await f.run([[call(SHARED)], []], {
      conversationId: child.threadId,
      subagent: true,
      ancestors: [{ agentName: "gone_agent" }]
    });
    expect(f.runTool.mock.calls[0]?.[1].modelRoutes).toEqual([
      { id: "test", region: "eu" },
      { id: "unread-ancestor" }
    ]);
  });
});
