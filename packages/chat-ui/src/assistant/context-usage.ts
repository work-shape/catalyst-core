import type { AgentRunProjection, Message } from "@vivd-catalyst/api-client";
import {
  readAssistantFinalMetadata,
  readAssistantModelContextSnapshot,
  readAssistantToolCallsMetadata
} from "@vivd-catalyst/core";

const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;
const APPROXIMATE_MESSAGE_OVERHEAD_TOKENS = 4;

export function resolveContextUsage(
  messages: Message[],
  compactThresholdTokens: number | undefined,
  activeRun?: Pick<AgentRunProjection, "runId" | "text">
): { inputTokens: number; compactThresholdTokens: number } | undefined {
  if (!compactThresholdTokens) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const snapshot = readAssistantModelContextSnapshot(messages[index]?.metadata);
    if (snapshot && snapshot.inputTokens > 0) {
      return {
        inputTokens:
          snapshot.inputTokens +
          estimateMessageTokens(messages.slice(index)) +
          estimateActiveRunTokens(messages, activeRun),
        compactThresholdTokens
      };
    }
  }

  return {
    inputTokens: estimateMessageTokens(messages) + estimateActiveRunTokens(messages, activeRun),
    compactThresholdTokens
  };
}

function estimateActiveRunTokens(
  messages: Message[],
  activeRun: Pick<AgentRunProjection, "runId" | "text"> | undefined
): number {
  if (!activeRun?.text) {
    return 0;
  }

  const runMessages = messages.filter((message) => readAssistantRunId(message) === activeRun.runId);
  if (runMessages.some((message) => readAssistantFinalMetadata(message.metadata))) {
    return 0;
  }

  const persistedAssistantText = runMessages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("");
  const unpersistedText = activeRun.text.startsWith(persistedAssistantText)
    ? activeRun.text.slice(persistedAssistantText.length)
    : activeRun.text;
  return estimateTextTokens(unpersistedText);
}

function readAssistantRunId(message: Message): string | undefined {
  return (
    readAssistantFinalMetadata(message.metadata)?.runId ??
    readAssistantToolCallsMetadata(message.metadata)?.runId
  );
}

function estimateMessageTokens(messages: Message[]): number {
  return messages.reduce((total, message) => total + estimateTextTokens(message.text), 0);
}

function estimateTextTokens(text: string): number {
  return text
    ? Math.ceil(text.length / APPROXIMATE_CHARACTERS_PER_TOKEN) +
        APPROXIMATE_MESSAGE_OVERHEAD_TOKENS
    : 0;
}
