import type { Message } from "@vivd-catalyst/api-client";
import { readAssistantModelContextSnapshot } from "@vivd-catalyst/core";

const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;
const APPROXIMATE_MESSAGE_OVERHEAD_TOKENS = 4;

export function resolveContextUsage(
  messages: Message[],
  compactThresholdTokens: number | undefined
): { inputTokens: number; compactThresholdTokens: number } | undefined {
  if (!compactThresholdTokens) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const snapshot = readAssistantModelContextSnapshot(messages[index]?.metadata);
    if (snapshot && snapshot.inputTokens > 0) {
      return {
        inputTokens:
          snapshot.inputTokens + estimateMessageTokens(messages.slice(index)),
        compactThresholdTokens
      };
    }
  }

  return {
    inputTokens: estimateMessageTokens(messages),
    compactThresholdTokens
  };
}

function estimateMessageTokens(messages: Message[]): number {
  return messages.reduce((total, message) => {
    if (!message.text) {
      return total;
    }
    return (
      total +
      Math.ceil(message.text.length / APPROXIMATE_CHARACTERS_PER_TOKEN) +
      APPROXIMATE_MESSAGE_OVERHEAD_TOKENS
    );
  }, 0);
}
