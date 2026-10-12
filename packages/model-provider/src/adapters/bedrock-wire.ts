/**
 * The wire format of Claude on Bedrock Runtime: the Anthropic Messages format inside
 * `InvokeModel` and `InvokeModelWithResponseStream`. Nothing outside the adapter reads it.
 * Every field the adapter reads is optional and every union is open: a block or an event of a
 * type that is not listed here is passed over, never refused.
 */

export const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

export type BedrockContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type BedrockRequestBlock =
  | BedrockContentBlock
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
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
}

export interface BedrockUsage {
  /** The input that was neither read from nor written to a cache. */
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

/** A block of an answer. `type` is open: thinking and later block types are passed over. */
interface BedrockResponseBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
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
    stop_reason?: string | null;
  };
  usage?: BedrockUsage;
  error?: { type?: string; message?: string };
}
