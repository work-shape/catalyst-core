import type {
  JsonObject,
  MessageCitation,
  ModelTokenUsage,
  ReasoningEffortConfig,
  RuntimeCallContext,
  SupportedImageMimeType,
  WebSource
} from "@vivd-catalyst/core";

export const OPENAI_WEB_SEARCH_PROVIDER_TOOL_ID = "openai.web_search";
export const WEB_SEARCH_MODEL_TOOL_NAME = "web_search";

export type ModelProviderNativeToolId = typeof OPENAI_WEB_SEARCH_PROVIDER_TOOL_ID;

export interface ModelFunctionTool {
  kind?: "function";
  name: string;
  description: string;
  inputJsonSchema?: JsonObject;
}

export interface ModelProviderNativeTool {
  kind: "provider";
  id: ModelProviderNativeToolId;
  name: typeof WEB_SEARCH_MODEL_TOOL_NAME;
}

export type ModelTool = ModelFunctionTool | ModelProviderNativeTool;

export function isModelFunctionTool(tool: ModelTool): tool is ModelFunctionTool {
  return tool.kind !== "provider";
}

export function isModelProviderNativeTool(tool: ModelTool): tool is ModelProviderNativeTool {
  return tool.kind === "provider";
}

export interface ModelToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  inputParseError?: {
    code: "invalid_json";
    message: string;
    rawInput?: string;
  };
}

export type ModelContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      mimeType: SupportedImageMimeType;
      data: Uint8Array;
    };

export type ModelContent = string | ModelContentPart[];

export type ModelMessage =
  | {
      role: "system" | "user";
      content: ModelContent;
    }
  | {
      role: "assistant";
      content: ModelContent;
      toolCalls?: ModelToolCall[];
    }
  | {
      role: "tool";
      content: ModelContent;
      toolCallId: string;
    };

export interface ModelCompletionRequest {
  providerId: string;
  model: string;
  reasoningEffort?: ReasoningEffortConfig;
  messages: ModelMessage[];
  tools: ModelTool[];
}

export interface ModelCompletion {
  text: string;
  toolCalls: ModelToolCall[];
  sources?: WebSource[];
  citations?: MessageCitation[];
  usage: ModelTokenUsage & {
    webSearchCallCount: number;
  };
}

export type ModelCompletionStreamEvent =
  | {
      type: "text_delta";
      delta: string;
    }
  | {
      type: "reasoning_delta";
      id: string;
      delta: string;
    }
  | {
      type: "provider_tool_started";
      toolCallId: string;
      toolName: string;
      input?: unknown;
    }
  | {
      type: "provider_tool_completed";
      toolCallId: string;
      toolName: string;
      output?: unknown;
    }
  | {
      type: "completed";
      completion: ModelCompletion;
    };

export interface ModelProvider {
  readonly id: string;
  complete(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): Promise<ModelCompletion>;
  stream?(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): AsyncIterable<ModelCompletionStreamEvent>;
}

export function modelContentText(content: ModelContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is Extract<ModelContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function modelContentImages(
  content: ModelContent
): Extract<ModelContentPart, { type: "image" }>[] {
  if (typeof content === "string") {
    return [];
  }
  return content.filter((part): part is Extract<ModelContentPart, { type: "image" }> => part.type === "image");
}
