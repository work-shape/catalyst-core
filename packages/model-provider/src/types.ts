import type {
  JsonObject,
  MessageCitation,
  ModelProviderConfig,
  ModelTokenUsage,
  ProviderCheckContext,
  ProviderCheckResult,
  ReasoningEffortConfig,
  SupportedImageMimeType,
  WebSource
} from "@vivd-catalyst/core";

export const WEB_SEARCH_MODEL_TOOL_NAME = "web_search";

/** A native tool of a provider, named by the product. Each adapter maps it to its own wire form. */
export type ModelNativeToolId = typeof WEB_SEARCH_MODEL_TOOL_NAME;

export interface ModelFunctionTool {
  kind?: "function";
  name: string;
  description: string;
  inputJsonSchema?: JsonObject;
}

/** A tool the provider runs itself. The call names it by its product id alone. */
export interface ModelProviderNativeTool {
  kind: "provider";
  name: ModelNativeToolId;
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
      /**
       * Where the image came from and what names it, for a request that has to leave it out. A
       * tool can load its own image again; an image the user attached cannot be loaded again.
       */
      source?: { kind: "tool_result" | "user_attachment"; label: string };
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

/** A request addressed to one provider entry by its id. The transports inside the adapters take it. */
export interface ModelCompletionRequest {
  providerId: string;
  model: string;
  reasoningEffort?: ReasoningEffortConfig;
  /** Requests the provider's fast processing tier. The adapter maps it to the provider parameter. */
  fastMode?: boolean;
  continuation?: ModelProviderContinuation;
  messages: ModelMessage[];
  tools: ModelTool[];
}

export interface ModelProviderContinuation {
  providerId: string;
  state: unknown;
}

export interface ModelCompletion {
  text: string;
  toolCalls: ModelToolCall[];
  continuation?: ModelProviderContinuation;
  contextManagement?: {
    compacted: boolean;
  };
  sources?: WebSource[];
  citations?: MessageCitation[];
  usage: ModelTokenUsage & {
    webSearchCallCount: number;
    /** Service tier the provider reported for this call, where it reports one. */
    providerServiceTier?: string;
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
      type: "tool_call_preparing";
      toolCallId: string;
      toolName: string;
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

/** What a transport is told about the call besides the request. */
export interface ModelTransportContext {
  signal?: AbortSignal;
  deadline?: Date;
}

/**
 * What one model of one provider entry can do, as its adapter declares it. The gateway refuses a
 * call that asks for more; callers read it instead of asking which provider serves the model.
 */
export interface ModelCapabilities {
  /** Reasoning efforts the model accepts. Empty when it takes none. */
  reasoningEfforts: readonly ReasoningEffortConfig[];
  nativeTools: readonly ModelNativeToolId[];
  /** The provider compacts the context itself and hands back a checkpoint. */
  serverCompaction: boolean;
  /** The provider accepts the continuation an earlier answer returned. */
  continuation: boolean;
  fastTier: boolean;
  imageInput: boolean;
  documentInput: boolean;
  structuredOutput: boolean;
  streaming: boolean;
}

/** The answer format a call asks for instead of free text. */
export interface ModelOutputFormat {
  jsonSchema: JsonObject;
}

/** One request to one model, as the gateway hands it to an adapter. */
export interface ModelAdapterRequest {
  model: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  output?: ModelOutputFormat;
  reasoningEffort?: ReasoningEffortConfig;
  fastTier?: boolean;
  continuation?: ModelProviderContinuation;
  /** Aborts when the caller stops the call or its deadline passes. The adapter stops with it. */
  signal?: AbortSignal;
  deadline?: Date;
}

/**
 * One provider entry, ready to be called. It owns its wire format and throws
 * `ModelProviderError`; it neither retries nor records usage, the gateway does both.
 */
/**
 * What the stream of an adapter gives: the events of the answer, and two that are for the
 * gateway alone and that it hands to no caller. `usage_reported` is the usage the provider
 * reported while the stream ran, so a stream that is cut off after it settles with it.
 * `tool_call_input_delta` is a piece of the input of a function call as it arrives, which no
 * event of the answer carries before the completion: the provider bills it as output.
 */
export type ModelAdapterStreamEvent =
  | ModelCompletionStreamEvent
  | { type: "usage_reported"; usage: ModelCompletion["usage"] }
  | { type: "tool_call_input_delta"; delta: string };

export interface ModelAdapter {
  capabilities(model: string): ModelCapabilities;
  complete(request: ModelAdapterRequest): Promise<ModelCompletion>;
  stream(request: ModelAdapterRequest): AsyncIterable<ModelAdapterStreamEvent>;
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
  return content.filter(
    (part): part is Extract<ModelContentPart, { type: "image" }> => part.type === "image"
  );
}

/**
 * What a model adapter hands back once its secrets are resolved: it builds the adapter for one
 * entry from the fields of the models port.
 */
export type ModelAdapterFactory = ((provider: ModelProviderConfig) => ModelAdapter) & {
  /**
   * Asks the endpoint whether it answers this credential, without a generation. Absent on a
   * provider that answers inside the process.
   */
  check?: (context: ProviderCheckContext) => Promise<ProviderCheckResult>;
};

declare module "@vivd-catalyst/core" {
  /** What the `models` port creates. */
  interface ProviderInstances {
    models: ModelAdapterFactory;
  }
}
