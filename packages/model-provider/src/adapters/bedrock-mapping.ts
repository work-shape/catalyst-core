import { createHash } from "node:crypto";
import { createProviderToolMetadata, type ProviderToolNames } from "../openai-compatible-mapping";
import type { ModelAdapterRequest, ModelCompletion, ModelContent, ModelToolCall } from "../types";
import {
  BEDROCK_ANTHROPIC_VERSION,
  type BedrockContentBlock,
  type BedrockMessagesRequest,
  type BedrockMessagesResponse,
  type BedrockRequestBlock,
  type BedrockRequestMessage,
  type BedrockUsage
} from "./bedrock-wire";

// The Messages format requires an output limit. Every Claude model offered on this route gives
// at least this much, so the limit cuts no answer a model would have finished; an answer that
// reaches it ends there and the user reads it cut off.
const BEDROCK_MAX_OUTPUT_TOKENS = 64_000;
// Protects a request from being refused whole over one image: Bedrock takes an image of at most
// 3.75 MB. A larger one is left out, and the model is told so in its place.
const BEDROCK_IMAGE_MAX_BYTES = 3_750_000;

/** A request in the Messages format, and the table that turns its tool names back. */
export function toBedrockRequest(request: ModelAdapterRequest): {
  body: BedrockMessagesRequest;
  toolNames: ProviderToolNames;
} {
  const tools = createProviderToolMetadata(request.tools);
  const system: { type: "text"; text: string }[] = [];
  const messages: BedrockRequestMessage[] = [];
  const push = (role: BedrockRequestMessage["role"], content: BedrockRequestBlock[]): void => {
    if (content.length === 0) return;
    const last = messages.at(-1);
    // The results of calls made together are one turn, and they stand directly after the turn
    // that made the calls: turns of one role in a row are sent as one.
    if (last?.role === role) {
      last.content.push(...content);
    } else {
      messages.push({ role, content });
    }
  };

  for (const message of request.messages) {
    if (message.role === "system") {
      system.push(...toTextBlocks(message.content));
    } else if (message.role === "assistant") {
      push("assistant", [
        ...toTextBlocks(message.content),
        ...(message.toolCalls ?? []).map((toolCall): BedrockRequestBlock => ({
          type: "tool_use",
          id: wireToolCallId(toolCall.toolCallId),
          name: tools.wireNameFor(toolCall.toolName),
          // The format takes an object. An input the model wrote as broken JSON has none.
          input: isRecord(toolCall.input) ? toolCall.input : {}
        }))
      ]);
    } else if (message.role === "tool") {
      const content = toContentBlocks(message.content);
      push("user", [
        {
          type: "tool_result",
          tool_use_id: wireToolCallId(message.toolCallId),
          ...(content.length > 0 ? { content } : {})
        }
      ]);
    } else {
      push("user", toContentBlocks(message.content));
    }
  }

  return {
    toolNames: tools,
    body: {
      anthropic_version: BEDROCK_ANTHROPIC_VERSION,
      max_tokens: BEDROCK_MAX_OUTPUT_TOKENS,
      ...(system.length > 0 ? { system } : {}),
      messages,
      ...(tools.providerTools.length > 0
        ? {
            tools: tools.providerTools.map(({ tool, providerName }) => ({
              name: providerName,
              description: tool.description,
              input_schema: tool.inputJsonSchema ?? { type: "object" }
            }))
          }
        : {})
    }
  };
}

/** The format refuses a text block that is empty or only white space, so none is sent. */
function toTextBlocks(content: ModelContent): { type: "text"; text: string }[] {
  const texts =
    typeof content === "string"
      ? [content]
      : content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  return texts.filter((text) => text.trim().length > 0).map((text) => ({ type: "text", text }));
}

/** Text and images in the order they were given. A document is refused before it gets here. */
function toContentBlocks(content: ModelContent): BedrockContentBlock[] {
  if (typeof content === "string") {
    return toTextBlocks(content);
  }
  const blocks: BedrockContentBlock[] = [];
  let omitted = 0;
  for (const part of content) {
    if (part.type === "text") {
      blocks.push(...toTextBlocks(part.text));
    } else if (part.type === "image") {
      if (part.data.byteLength > BEDROCK_IMAGE_MAX_BYTES) {
        omitted += 1;
        continue;
      }
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: part.mimeType,
          data: Buffer.from(part.data).toString("base64")
        }
      });
    }
  }
  if (omitted > 0) {
    blocks.push({
      type: "text",
      text:
        omitted === 1
          ? "[1 image was too large to include in the model input and was left out.]"
          : `[${omitted} images were too large to include in the model input and were left out.]`
    });
  }
  return blocks;
}

const WIRE_TOOL_CALL_ID = /^[a-zA-Z0-9_-]{1,64}$/u;

/**
 * The id of a tool call as the format takes it. A call another provider made earlier in the
 * conversation can carry an id with other characters; it is sent as a hash, the same in the
 * call and in its result.
 */
function wireToolCallId(toolCallId: string): string {
  return WIRE_TOOL_CALL_ID.test(toolCallId)
    ? toolCallId
    : `tc_${createHash("sha256").update(toolCallId, "utf8").digest("hex").slice(0, 32)}`;
}

/** What one answer holds. Blocks of any other type, such as thinking, are passed over. */
export function readBedrockAnswer(
  payload: BedrockMessagesResponse,
  toolNames: ProviderToolNames
): { text: string; toolCalls: ModelToolCall[] } {
  let text = "";
  const toolCalls: ModelToolCall[] = [];
  for (const block of Array.isArray(payload.content) ? payload.content : []) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      toolCalls.push({
        toolCallId: block.id,
        toolName: toolNames.productNameFor(block.name),
        input: isRecord(block.input) ? block.input : {}
      });
    }
  }
  return { text, toolCalls };
}

/** Stop reasons of an answer that is an answer: complete, cut at the output limit, or a call. */
const ANSWERED_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use"
]);

/**
 * Why an answer is none, as the provider's own identifier: a refusal, a paused turn or a stop
 * reason this adapter does not know, with neither text nor a tool call. Undefined for an answer.
 */
export function missingBedrockAnswerReason(
  answer: { text: string; toolCalls: ModelToolCall[] },
  stopReason: string | null | undefined
): string | undefined {
  if (answer.text.length > 0 || answer.toolCalls.length > 0) {
    return undefined;
  }
  if (typeof stopReason === "string" && ANSWERED_STOP_REASONS.has(stopReason)) {
    return undefined;
  }
  return typeof stopReason === "string" ? stopReason : "no_stop_reason";
}

/**
 * The usage Bedrock reported. Its `input_tokens` leaves out what was read from or written to a
 * cache; the product's input count holds all three, and the cached share is what was read. A
 * cache write has no rate of its own in the product. This adapter asks for no cache, so none is
 * written; a count that arrives anyway is billed as uncached input. Without an input count
 * nothing was reported, and the call's cost is then incomplete.
 */
export function toBedrockModelUsage(usage: BedrockUsage | undefined): ModelCompletion["usage"] {
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  if (!isRecord(usage) || typeof usage.input_tokens !== "number") {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      source: "not_reported",
      webSearchCallCount: 0
    };
  }
  const cachedInputTokens = count(usage.cache_read_input_tokens);
  const inputTokens =
    count(usage.input_tokens) + cachedInputTokens + count(usage.cache_creation_input_tokens);
  const outputTokens = count(usage.output_tokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    source: "provider_reported",
    webSearchCallCount: 0
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
