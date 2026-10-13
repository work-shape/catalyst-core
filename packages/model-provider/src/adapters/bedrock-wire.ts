/**
 * The wire format of Claude on Bedrock Runtime: the Anthropic Messages format inside
 * `InvokeModel` and `InvokeModelWithResponseStream`. Nothing outside the adapter reads it.
 * Every field the adapter reads is optional and every union is open: a block or an event of a
 * type that is not listed here is passed over, never refused.
 */

export const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

export type BedrockContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    };

/**
 * What the model thought before or between its tool calls. `signature` and `data` are opaque:
 * Bedrock checks them when the block comes back, so a block is sent as it arrived or not at all.
 */
export type BedrockThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export type BedrockRequestBlock =
  | BedrockContentBlock
  | BedrockThinkingBlock
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content?: BedrockContentBlock[] };

export interface BedrockRequestMessage {
  role: "user" | "assistant";
  content: BedrockRequestBlock[];
}

export interface BedrockMessagesRequest {
  anthropic_version: typeof BEDROCK_ANTHROPIC_VERSION;
  max_tokens: number;
  system?: { type: "text"; text: string }[];
  messages: BedrockRequestMessage[];
  /** The model decides whether and how much it thinks; `output_config.effort` guides it. */
  thinking?: { type: "adaptive" };
  output_config?: {
    effort?: BedrockEffort;
    /** The answer is one text block of JSON that follows the schema. */
    format?: { type: "json_schema"; schema: Record<string, unknown> };
  };
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
}

/** The efforts the Messages format takes on every model this adapter is checked against. */
export type BedrockEffort = "low" | "medium" | "high";

export interface BedrockUsage {
  /** The input that was neither read from nor written to a cache. */
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** What the model wrote, its thinking included: Bedrock bills thinking as output. */
  output_tokens?: number;
}

/** A block of an answer. `type` is open: a block type of a later release is passed over. */
export interface BedrockResponseBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
  /** The content of a `redacted_thinking` block. */
  data?: string;
}

export interface BedrockMessagesResponse {
  content?: BedrockResponseBlock[];
  stop_reason?: string | null;
  usage?: BedrockUsage;
}

/** One event of a streamed answer, as the `bytes` of a `chunk` message hold it. */
export interface BedrockStreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: BedrockUsage };
  content_block?: BedrockResponseBlock;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string | null;
  };
  usage?: BedrockUsage;
  error?: { type?: string; message?: string };
}
