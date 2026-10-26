import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  asAgentRunId,
  asClientInstanceId,
  type ChatMessage,
  type JsonObject,
  type RuntimeCallContext,
  type ToolOperationRunner
} from "@work-shape/catalyst-core";
import { type TestStore } from "../support/test-instance";

export async function createConversationWithMessages(
  store: TestStore,
  input: {
    clientInstanceId: ChatMessage["clientInstanceId"];
    messages: Array<{ role: ChatMessage["role"]; text: string; metadata?: JsonObject }>;
  }
): Promise<ChatMessage["conversationId"]> {
  const conversation = await store.createConversationForTesting({
    clientInstanceId: input.clientInstanceId,
    createdByUserId: "user-1",
    createdByExternalUserId: "user-1",
    title: "Test conversation",
    retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
  });
  for (const message of input.messages) {
    await store.conversations.appendMessage({
      clientInstanceId: input.clientInstanceId,
      conversationId: conversation.id,
      role: message.role,
      text: message.text,
      metadata: message.metadata
    });
  }
  return conversation.id;
}

export function createUnusedToolRunner(): ToolOperationRunner {
  return () => Promise.reject(new Error("Tool execution should not be used"));
}

export function noReportedUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source: "not_reported" as const,
    webSearchCallCount: 0
  };
}

export function modelContextOptions() {
  return {
    toolOutput: {
      maxTokens: 60000
    }
  };
}

export async function firstRunFailedEvent(
  runtime: LocalAgentRuntime,
  runId: ReturnType<typeof asAgentRunId>,
  context: RuntimeCallContext
) {
  for await (const event of runtime.observe(runId, context)) {
    if (event.type === "run_failed") {
      return event;
    }
  }
  throw new Error("Run did not fail");
}

export async function waitForPersistedRunStatus(
  store: TestStore,
  input: {
    clientInstanceId: ReturnType<typeof asClientInstanceId>;
    runId: ReturnType<typeof asAgentRunId>;
    status: string;
  }
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run = await store.agentRuns.getAgentRun({
      clientInstanceId: input.clientInstanceId,
      runId: input.runId
    });
    if (run?.status === input.status) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Run did not reach status '${input.status}'`);
}

export {
  createAssistantToolCallsMetadata,
  createModelVisibleToolOutput,
  readAssistantReasoningSummaries,
  createToolResultMetadata
} from "../../packages/agent-runtime/src/model-context-projection";
