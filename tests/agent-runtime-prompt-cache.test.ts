import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asClientInstanceId,
  asConversationId,
  type ConversationId,
  type ModelProviderConfig,
  type RuntimeCallContext,
  type StartAgentRunInput
} from "@work-shape/catalyst-core";
import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  ModelProviderError,
  modelContentText,
  type ModelCompletion,
  type ModelCompletionRequest
} from "@work-shape/catalyst-model-provider";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { withTestModelGateway, type FakeModelProvider } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance, type TestStore } from "./support/test-instance";
import { createTestToolRunner } from "./support/tool-runner";

const clientInstanceId = asClientInstanceId("prompt-cache-runtime");
const context: RuntimeCallContext = {
  clientInstanceId,
  correlationId: "corr-prompt-cache-runtime",
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

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  source: "not_reported" as const,
  webSearchCallCount: 0
};

/**
 * A model that calls `test.lookup` once on each new message and then answers. Every answer ends
 * with a continuation of its own, as a provider's encrypted reasoning does.
 */
function lookupThenAnswer(requests: ModelCompletionRequest[]): FakeModelProvider {
  return {
    id: "test-provider",
    async complete(request) {
      requests.push(request);
      const continuation = {
        providerId: "test-provider",
        state: { kind: "test_reasoning", call: requests.length }
      };
      if (request.messages.at(-1)?.role === "user") {
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: `call_${requests.length}`,
              toolName: "test.lookup",
              input: { id: "r1" }
            }
          ],
          continuation,
          usage
        };
      }
      return { text: '{"found":true}', toolCalls: [], continuation, usage };
    }
  };
}

/** A result far above the bound of 12,000 tokens a tool result is cut at. */
const BIG = Array.from({ length: 15_000 }, (_, index) => `row ${index}`).join("\n");

/** A model that answers each request with the next of `steps`, given the request. */
function scripted(
  requests: ModelCompletionRequest[],
  steps: Array<(request: ModelCompletionRequest) => Pick<ModelCompletion, "text" | "toolCalls">>
): FakeModelProvider {
  return {
    id: "test-provider",
    async complete(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const step = steps.shift();
      return { ...(step ? step(request) : { text: "Done.", toolCalls: [] }), usage };
    }
  };
}

const lastToolText = (request: ModelCompletionRequest | undefined) =>
  modelContentText(request?.messages.findLast((message) => message.role === "tool")?.content ?? "");

function runtimeOn(
  store: TestStore,
  model: string,
  requests: ModelCompletionRequest[],
  modelProvider: FakeModelProvider = lookupThenAnswer(requests)
) {
  const provider: ModelProviderConfig = { id: "test-provider", type: "deterministic", model };
  const tools = new ToolRegistry({
    tools: [
      defineTool({
        name: "test.lookup",
        description: "Look up a record.",
        effect: "reading",
        inputSchema: z.object({ id: z.string() }),
        execute: ({ id }) => toolSuccess(id === "big" ? BIG : { value: 1, id })
      })
    ]
  });
  return new LocalAgentRuntime(
    withTestModelGateway({
      assetSource: createStaticConfigAssetSource({
        agents: [
          {
            skillNames: [],
            name: "lookup_agent",
            displayName: "Lookup Agent",
            instructions: "Look things up.",
            modelProviderId: "test-provider",
            toolNames: ["test.lookup"],
            initialPrompts: []
          }
        ]
      }),
      modelProviders: [provider],
      defaultModelProvider: provider,
      conversationHistory: store.conversations,
      modelProviderContinuationStore: store.conversations,
      agentRunStore: store.agentRuns,
      runObservationStore: store.agentRuns,
      modelProvider,
      toolRegistry: tools,
      runTool: createTestToolRunner({ registry: tools, getAgentToolNames: () => ["test.lookup"] }),
      usageGovernance: new ModelUsageGovernance({ store: store.usage, budget: {}, safeguards: {} })
    })
  );
}

async function turn(
  store: TestStore,
  runtime: LocalAgentRuntime,
  conversationId: ConversationId,
  text: string
) {
  const message = await store.conversations.appendMessage({
    clientInstanceId,
    conversationId,
    role: "user",
    text
  });
  const run = await runtime.start(
    { agentName: "lookup_agent", conversationId, inputMessageId: message.id, message: { text } },
    context
  );
  for await (const event of runtime.observe(run.runId, context)) {
    if (event.type === "run_completed" || event.type === "run_failed") break;
  }
}

describe("model requests of a conversation", () => {
  it("share one cache key, and a turn on the same model goes on with the reasoning the last one ended with", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "user-1",
      title: "Prompt cache",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });
    const requests: ModelCompletionRequest[] = [];
    const onModelA = runtimeOn(store, "model-a", requests);

    await turn(store, onModelA, conversation.id, "Look up r1");
    await turn(store, onModelA, conversation.id, "And again");

    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.cacheKey)).toEqual(
      requests.map(() => conversation.id)
    );
    expect(requests[0]?.continuation).toBeUndefined();
    // The second turn starts with what the first one's last call ended with.
    expect(requests[2]?.continuation).toEqual({
      providerId: "test-provider",
      state: { kind: "test_reasoning", call: 2 }
    });
    expect(
      await store.conversations.getModelProviderTurnContinuation({
        clientInstanceId,
        conversationId: conversation.id,
        providerId: "test-provider"
      })
    ).toMatchObject({ model: "model-a", state: { kind: "test_reasoning", call: 4 } });

    // Another model could not read that reasoning: its turn goes on from history alone.
    await turn(store, runtimeOn(store, "model-b", requests), conversation.id, "Once more");

    expect(requests[4]?.continuation).toBeUndefined();
    expect(requests[4]?.cacheKey).toBe(conversation.id);
  });

  it("of a subagent share its parent conversation's key, of a Workflow step its run's", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "user-1",
      title: "Prompt cache keys",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });
    const parentConversationId = asConversationId("conv_parent");
    const requests: ModelCompletionRequest[] = [];
    const runtime = runtimeOn(store, "model-a", requests);
    const runWith = async (input: Partial<StartAgentRunInput>) => {
      const message = await store.conversations.appendMessage({
        clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "Look up r1"
      });
      const run = await runtime.start(
        {
          agentName: "lookup_agent",
          conversationId: conversation.id,
          inputMessageId: message.id,
          message: { text: message.text },
          ...input
        },
        context
      );
      for await (const event of runtime.observe(run.runId, context)) {
        if (event.type === "run_completed" || event.type === "run_failed") break;
      }
    };

    await runWith({ parentConversationId });
    const ofSubagent = requests.splice(0);
    await runWith({
      workflowAgent: {
        workflowRunId: "wfr_one",
        instructions: "Look things up.",
        toolNames: ["test.lookup"],
        outputSchema: { type: "object" }
      }
    });

    expect(ofSubagent.map((request) => request.cacheKey)).toEqual(["conv_parent", "conv_parent"]);
    expect(requests.map((request) => request.cacheKey)).toEqual(["wfr_one", "wfr_one"]);
  });

  it("read a cut result of their own conversation in parts, and none of another", async () => {
    const store = (await createTestInstance()).stores;
    const newConversation = (title: string) =>
      store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: "user-1",
        createdByExternalUserId: "user-1",
        title,
        retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
      });
    const own = await newConversation("Cut result");
    const other = await newConversation("Another conversation");
    const requests: ModelCompletionRequest[] = [];
    let leftOutFrom = -1;
    const steps: Parameters<typeof scripted>[1] = [
      () => ({
        text: "",
        toolCalls: [{ toolCallId: "call_big", toolName: "test.lookup", input: { id: "big" } }]
      }),
      (request) => {
        leftOutFrom = Number(/"offset":(\d+)/u.exec(lastToolText(request))?.[1]);
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: "call_read",
              toolName: "tool_result.read",
              input: { id: "call_big", offset: leftOutFrom }
            }
          ]
        };
      },
      () => ({ text: "Read it.", toolCalls: [] }),
      () => ({
        text: "",
        toolCalls: [
          { toolCallId: "call_other", toolName: "tool_result.read", input: { id: "call_big" } }
        ]
      }),
      () => ({ text: "Nothing there.", toolCalls: [] })
    ];
    const runtime = runtimeOn(store, "model-a", requests, scripted(requests, steps));

    await turn(store, runtime, own.id, "Read the big record");
    await turn(store, runtime, other.id, "Read the other one's");

    // Offered always and last, so the tool list stays the same for the cache.
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "test.lookup",
      "tool_result.read"
    ]);
    const cut = lastToolText(requests[1]);
    expect(cut).toContain(`[Result cut for the model: ${BIG.length} characters`);
    expect(cut).toContain(`tool_result.read {"id":"call_big","offset":${leftOutFrom}}`);
    expect(leftOutFrom).toBeGreaterThan(0);
    const page = lastToolText(requests[2]);
    const header =
      /^\[Result call_big, characters (\d+) to (\d+) of (\d+)\. Go on with offset (\d+)\.\]\n/u.exec(
        page
      );
    expect(header?.slice(1).map(Number)).toEqual([
      leftOutFrom,
      Number(header?.[2]),
      BIG.length,
      Number(header?.[2])
    ]);
    expect(page.slice(header?.[0].length)).toBe(BIG.slice(leftOutFrom, Number(header?.[2])));
    // A run reads only what its own conversation holds.
    const refused = lastToolText(requests[4]);
    expect(refused).toContain("No tool result 'call_big' in this conversation.");
    expect(refused).not.toContain("row 1");
  });

  it("drops the last turn's continuation with the checkpoint when the provider refuses it", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "user-1",
      title: "Prompt cache refused",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });
    await turn(store, runtimeOn(store, "model-a", []), conversation.id, "Look up r1");
    const key = { clientInstanceId, conversationId: conversation.id, providerId: "test-provider" };
    expect(await store.conversations.getModelProviderTurnContinuation(key)).toBeDefined();

    await store.conversations.deleteModelProviderContinuation(key);

    expect(await store.conversations.getModelProviderTurnContinuation(key)).toBeUndefined();
  });

  it("drops only refused reasoning and goes on from the compaction checkpoint, which it keeps", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "user-1",
      title: "Reasoning refused",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });
    const at = { clientInstanceId, conversationId: conversation.id };
    await store.conversations.appendMessage({ ...at, role: "user", text: "Before the checkpoint" });
    await store.conversations.appendAssistantMessage({
      ...at,
      text: "Compacted.",
      providerContinuation: { providerId: "test-provider", state: { kind: "checkpoint" } }
    });
    await store.conversations.appendMessage({ ...at, role: "user", text: "After the checkpoint" });
    await store.conversations.appendAssistantMessage({
      ...at,
      text: "Answered.",
      turnContinuation: {
        providerId: "test-provider",
        model: "model-a",
        state: { kind: "reasoning" }
      }
    });
    const requests: ModelCompletionRequest[] = [];
    const provider: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "model-a",
      contextManagement: { compaction: { compactThresholdTokens: 200_000 } }
    };
    const tools = new ToolRegistry({ tools: [] });
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "lookup_agent",
              displayName: "Lookup Agent",
              instructions: "Answer.",
              modelProviderId: "test-provider",
              toolNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [provider],
        defaultModelProvider: provider,
        conversationHistory: store.conversations,
        modelProviderContinuationStore: store.conversations,
        agentRunStore: store.agentRuns,
        runObservationStore: store.agentRuns,
        modelProvider: {
          id: "test-provider",
          async complete(request) {
            requests.push(request);
            if (JSON.stringify(request.continuation?.state) === '{"kind":"reasoning"}') {
              throw new ModelProviderError({
                kind: "continuation_rejected",
                message: "The model provider refused the continuation",
                status: 400,
                providerCode: "invalid_encrypted_content"
              });
            }
            return { text: "Done.", toolCalls: [], usage };
          }
        },
        toolRegistry: tools,
        runTool: createTestToolRunner({ registry: tools, getAgentToolNames: () => [] }),
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );

    await turn(store, runtime, conversation.id, "Now");

    expect(requests.map((request) => request.continuation?.state)).toEqual([
      { kind: "reasoning" },
      { kind: "checkpoint" }
    ]);
    // Sent again from the checkpoint on: what came before it stays in the checkpoint.
    const sent = requests[1]?.messages.map((message) => modelContentText(message.content));
    expect(sent).not.toContain("Before the checkpoint");
    expect(sent).toContain("After the checkpoint");
    const key = { ...at, providerId: "test-provider" };
    expect(await store.conversations.getModelProviderContinuation(key)).toMatchObject({
      state: { kind: "checkpoint" }
    });
    expect(await store.conversations.getModelProviderTurnContinuation(key)).toBeUndefined();
  });
});
