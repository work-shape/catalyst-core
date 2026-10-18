import {
  KNOWLEDGE_SEARCH_TOOL_NAME,
  readKnowledgeCitationSources,
  type KnowledgeCitationSource
} from "@work-shape/catalyst-core";
import type { ModelMessage } from "@work-shape/catalyst-model-provider";

/** Capture the search results of this turn before model-context compaction can discard them. */
export function collectKnowledgeCitations(
  messages: readonly ModelMessage[],
  kept: Map<string, KnowledgeCitationSource>
): void {
  const start = messages.findLastIndex((message) => message.role === "user");
  const calls = new Set(
    messages
      .slice(start + 1)
      .flatMap((message) =>
        message.role === "assistant"
          ? (message.toolCalls ?? [])
              .filter((call) => call.toolName === KNOWLEDGE_SEARCH_TOOL_NAME)
              .map((call) => call.toolCallId)
          : []
      )
  );
  for (const message of messages.slice(start + 1)) {
    if (message.role !== "tool" || !calls.has(message.toolCallId)) continue;
    const text = typeof message.content === "string" ? message.content : undefined;
    if (!text) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "object" || value === null || !("passages" in value)) continue;
      for (const source of readKnowledgeCitationSources(value.passages))
        kept.set(source.ref, source);
    } catch {
      // Most tools do not return JSON passages.
    }
  }
}
