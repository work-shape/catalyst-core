import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  readAssistantModelFallback,
  type AgentConfig,
  type AgentRuntimeEvent,
  type ConversationId,
  type ModelBindingConfig,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  ModelProviderError,
  type ModelCompletionRequest
} from "@work-shape/catalyst-model-provider";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import {
  createRecordingGovernance,
  withTestModelGateway,
  type FakeModelProvider,
  type RecordingGovernance
} from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance, type TestStore } from "./support/test-instance";
import { createTestToolRunner } from "./support/tool-runner";

const clientInstanceId = asClientInstanceId("model-fallback-runtime");
const context: RuntimeCallContext = {
  clientInstanceId,
  correlationId: "corr-model-fallback",
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
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  source: "provider_reported" as const,
  webSearchCallCount: 0
};

const provider: ModelProviderConfig = {
  id: "test-provider",
  type: "deterministic",
  model: "model-a",
  region: "eu"
};
const elsewhere: ModelProviderConfig = {
  id: "other-provider",
  type: "deterministic",
  model: "model-c",
  region: "global"
};
const bindings: ModelBindingConfig[] = [
  {
    id: "primary",
    providerId: "test-provider",
    model: "model-a",
    label: "Model A",
    fallback: "backup"
  },
  {
    id: "backup",
    providerId: "test-provider",
    model: "model-b",
    label: "Model B",
    fallback: "primary"
  },
  { id: "abroad", providerId: "other-provider", model: "model-c", fallback: "primary" }
];

/** A rate limit whose pause outlasts the gateway's wait, so a call without a fallback fails at once. */
const rateLimit = () =>
  new ModelProviderError({
    kind: "rate_limit",
    message: "Model provider rate limit reached",
    status: 429,
    retryAfterMs: 120_000
  });

/** model-a answers with `onPrimary`; every other model answers "From <model>.". */
function routes(
  requests: ModelCompletionRequest[],
  onPrimary: () => Error | undefined
): FakeModelProvider {
  return {
    id: "test-provider",
    async complete(request) {
      requests.push(request);
      const failure = request.model === "model-a" ? onPrimary() : undefined;
      if (failure) throw failure;
      return {
        text: `From ${request.model}.`,
        toolCalls: [],
        // Reasoning only the model that wrote it can read.
        continuation: { providerId: "test-provider", state: { reasoningOf: request.model } },
        usage
      };
    }
  };
}

function runtimeWith(
  store: TestStore,
  input: {
    modelProvider: FakeModelProvider;
    governance?: RecordingGovernance;
    agent?: Partial<AgentConfig>;
    workspaceModelBindings?: readonly string[];
  }
) {
  const tools = new ToolRegistry({ tools: [] });
  return new LocalAgentRuntime(
    withTestModelGateway({
      assetSource: createStaticConfigAssetSource({
        agents: [
          {
            name: "fixed_agent",
            displayName: "Fixed Agent",
            instructions: "Answer.",
            modelBindingId: "primary",
            toolNames: [],
            skillNames: [],
            initialPrompts: [],
            ...input.agent
          }
        ]
      }),
      modelProviders: [provider, elsewhere],
      modelBindings: bindings,
      defaultModelProvider: provider,
      conversationHistory: store.conversations,
      modelProviderContinuationStore: store.conversations,
      agentRunStore: store.agentRuns,
      runObservationStore: store.agentRuns,
      modelProvider: input.modelProvider,
      toolRegistry: tools,
      runTool: createTestToolRunner({ registry: tools, getAgentToolNames: () => [] }),
      usageGovernance: input.governance ?? createRecordingGovernance(),
      ...(input.workspaceModelBindings
        ? { workspaceModelBindings: async () => input.workspaceModelBindings }
        : {})
    })
  );
}

async function newConversation(store: TestStore) {
  return store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: "user-1",
    createdByExternalUserId: "user-1",
    title: "Model fallback",
    retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
  });
}

async function turn(
  store: TestStore,
  runtime: LocalAgentRuntime,
  conversationId: ConversationId,
  text = "Hello"
): Promise<AgentRuntimeEvent> {
  const message = await store.conversations.appendMessage({
    clientInstanceId,
    conversationId,
    role: "user",
    text
  });
  const run = await runtime.start(
    { agentName: "fixed_agent", conversationId, inputMessageId: message.id, message: { text } },
    context
  );
  for await (const event of runtime.observe(run.runId, context)) {
    if (event.type === "run_completed" || event.type === "run_failed") return event;
  }
  throw new Error("The run ended without a terminal event");
}

async function lastAnswer(store: TestStore, conversationId: ConversationId) {
  const messages = await store.conversations.listMessages({ clientInstanceId, conversationId });
  return messages.findLast((message) => message.role === "assistant");
}

describe("a run whose model binding names a fallback", () => {
  it("answers on the fallback at once on a rate limit, records usage there and starts the next run on its binding", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await newConversation(store);
    const requests: ModelCompletionRequest[] = [];
    const governance = createRecordingGovernance();
    let limited = true;
    const runtime = runtimeWith(store, {
      modelProvider: routes(requests, () => (limited ? rateLimit() : undefined)),
      governance
    });

    const started = Date.now();
    const ended = await turn(store, runtime, conversation.id);

    expect(ended.type).toBe("run_completed");
    // No wait for the minute: the Retry-After of two minutes was never waited out.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(requests.map((request) => request.model)).toEqual(["model-a", "model-b"]);
    const answer = await lastAnswer(store, conversation.id);
    expect(answer?.text).toBe("From model-b.");
    expect(readAssistantModelFallback(answer?.metadata)).toEqual({
      from: { bindingId: "primary", model: "model-a", label: "Model A" },
      to: { bindingId: "backup", model: "model-b", label: "Model B" },
      reason: "rate_limit"
    });
    // The refused call used nothing; the answer is counted on the binding that gave it.
    expect(governance.recorded.map((record) => [record.bindingId, record.outputTokens])).toEqual([
      ["primary", 0],
      ["backup", 5]
    ]);

    // The run's reasoning is kept for the model that wrote it.
    const key = { clientInstanceId, conversationId: conversation.id, providerId: "test-provider" };
    expect(await store.conversations.getModelProviderTurnContinuation(key)).toMatchObject({
      model: "model-b",
      state: { reasoningOf: "model-b" }
    });

    limited = false;
    await turn(store, runtime, conversation.id, "Again");

    expect(requests.map((request) => request.model)).toEqual(["model-a", "model-b", "model-a"]);
    // The primary is never sent the fallback's reasoning.
    expect(requests[2]?.continuation).toBeUndefined();
    expect(readAssistantModelFallback((await lastAnswer(store, conversation.id))?.metadata)).toBe(
      undefined
    );
  });

  it("does not switch once the failed call has shown the person anything", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await newConversation(store);
    const models: string[] = [];
    const runtime = runtimeWith(store, {
      modelProvider: {
        id: "test-provider",
        complete: () => Promise.reject(new Error("streamed only")),
        async *stream(request) {
          models.push(request.model);
          yield { type: "text_delta", delta: "Half an ans" };
          throw new ModelProviderError({
            kind: "server_error",
            message: "Model provider server error",
            status: 502
          });
        }
      }
    });

    const ended = await turn(store, runtime, conversation.id);

    expect(ended.type).toBe("run_failed");
    expect(models).toEqual(["model-a"]);
  });

  it("is never called where the agent turns it off", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await newConversation(store);
    const requests: ModelCompletionRequest[] = [];
    const runtime = runtimeWith(store, {
      modelProvider: routes(requests, rateLimit),
      agent: { useModelFallback: false }
    });

    const ended = await turn(store, runtime, conversation.id);

    expect(ended).toMatchObject({ type: "run_failed", error: { code: "RATE_LIMITED" } });
    expect(requests.map((request) => request.model)).toEqual(["model-a"]);
  });

  it("is never called where the agent's workspace has a model list without it", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await newConversation(store);
    const requests: ModelCompletionRequest[] = [];
    const runtime = runtimeWith(store, {
      modelProvider: routes(requests, rateLimit),
      workspaceModelBindings: ["primary"]
    });

    const ended = await turn(store, runtime, conversation.id);

    expect(ended).toMatchObject({ type: "run_failed", error: { code: "RATE_LIMITED" } });
    expect(requests.map((request) => request.model)).toEqual(["model-a"]);
  });

  it("is called where the workspace's list holds it", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await newConversation(store);
    const requests: ModelCompletionRequest[] = [];
    const runtime = runtimeWith(store, {
      modelProvider: routes(requests, rateLimit),
      workspaceModelBindings: ["primary", "backup"]
    });

    expect((await turn(store, runtime, conversation.id)).type).toBe("run_completed");
    expect(requests.map((request) => request.model)).toEqual(["model-a", "model-b"]);
  });

  it("is never called in another region", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await newConversation(store);
    const requests: ModelCompletionRequest[] = [];
    const runtime = runtimeWith(store, {
      modelProvider: {
        id: "test-provider",
        async complete(request) {
          requests.push(request);
          if (request.model === "model-c") throw rateLimit();
          return { text: `From ${request.model}.`, toolCalls: [], usage };
        }
      },
      agent: { modelBindingId: "abroad" }
    });

    const ended = await turn(store, runtime, conversation.id);

    expect(ended.type).toBe("run_failed");
    expect(requests.map((request) => request.model)).toEqual(["model-c"]);
  });

  it("switches after the retries on a server error, and the rest of the run stays on the fallback", async () => {
    const store = (await createTestInstance()).stores;
    const conversation = await newConversation(store);
    const models: string[] = [];
    const runtime = runtimeWith(store, {
      modelProvider: {
        id: "test-provider",
        async complete(request) {
          models.push(request.model);
          if (request.model === "model-a") {
            throw new ModelProviderError({
              kind: "server_error",
              message: "Model provider server error",
              status: 503,
              // The provider names a short pause, so the test does not wait the full retries.
              retryAfterMs: 10
            });
          }
          return { text: `From ${request.model}.`, toolCalls: [], usage };
        }
      }
    });

    const ended = await turn(store, runtime, conversation.id);

    expect(ended.type).toBe("run_completed");
    // The first call and its two retries, then the fallback.
    expect(models).toEqual(["model-a", "model-a", "model-a", "model-b"]);
    expect(
      readAssistantModelFallback((await lastAnswer(store, conversation.id))?.metadata)?.reason
    ).toBe("unavailable");
  });
});
