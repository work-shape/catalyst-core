import type {
  BedrockCacheControl,
  BedrockMessagesRequest,
  BedrockRequestBlock,
  BedrockRequestMessage,
  BedrockThinkingBlock
} from "./bedrock-wire";

const BREAKPOINT: BedrockCacheControl = { type: "ephemeral" };

/** A block Bedrock takes a breakpoint on: any but a thinking block. */
type CacheableBlock = Exclude<BedrockRequestBlock, BedrockThinkingBlock>;

const takesBreakpoint = (block: BedrockRequestBlock): block is CacheableBlock =>
  block.type !== "thinking" && block.type !== "redacted_thinking";

/**
 * The request with its prompt cache breakpoints, for a call whose prompt the next call of its
 * conversation starts with (`ModelCall.cacheKey`). A call without one is sent as it is: a prompt
 * no later call repeats would pay for a cache write that is never read.
 *
 * Bedrock takes four breakpoints. They mark, in the order the prompt renders:
 * 1. the last tool, so the tools are read from the cache when the system prompt changed;
 * 2. the last block of the first system message, the agent's instructions, so a note a later
 *    system message adds does not cost the instructions their cache;
 * 3. the end of the previous request of the conversation, the turn before the model's latest
 *    answer, where that request wrote its cache: read there however long the latest turn is;
 * 4. the end of this request, which the next request of the conversation reads.
 * A prompt below the model's minimum is not cached and costs nothing more.
 */
export function withBedrockCacheBreakpoints(
  body: BedrockMessagesRequest,
  instructionsEnd: number | undefined
): BedrockMessagesRequest {
  const tools = body.tools?.map((tool, index, all) =>
    index === all.length - 1 ? { ...tool, cache_control: BREAKPOINT } : tool
  );
  const system = body.system?.map((block, index) =>
    index === instructionsEnd ? { ...block, cache_control: BREAKPOINT } : block
  );
  const last = body.messages.length - 1;
  const latestAnswer = body.messages.findLastIndex(
    (message, index) => index < last && message.role === "assistant"
  );
  const marked = new Set([last, ...(latestAnswer > 0 ? [latestAnswer - 1] : [])]);
  const messages = body.messages.map((message, index) =>
    marked.has(index) ? withBreakpoint(message) : message
  );
  return {
    ...body,
    ...(tools ? { tools } : {}),
    ...(system ? { system } : {}),
    messages
  };
}

/** The message with a breakpoint on its last block that takes one. */
function withBreakpoint(message: BedrockRequestMessage): BedrockRequestMessage {
  const index = message.content.findLastIndex(takesBreakpoint);
  if (index === -1) return message;
  return {
    ...message,
    content: message.content.map((block, position) =>
      position === index && takesBreakpoint(block) ? { ...block, cache_control: BREAKPOINT } : block
    )
  };
}
