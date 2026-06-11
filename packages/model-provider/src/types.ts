import type { JsonObject, ModelTokenUsage, RuntimeCallContext } from "@vivd-catalyst/core";

export interface ModelTool {
  name: string;
  description: string;
  inputJsonSchema?: JsonObject;
}

export interface ModelToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type ModelMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ModelToolCall[];
    }
  | {
      role: "tool";
      content: string;
      toolCallId: string;
    };

export interface ModelCompletionRequest {
  providerId: string;
  model: string;
  messages: ModelMessage[];
  tools: ModelTool[];
}

export interface ModelCompletion {
  text: string;
  toolCalls: ModelToolCall[];
  usage: ModelTokenUsage;
}

export type ModelCompletionStreamEvent =
  | {
      type: "text_delta";
      delta: string;
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
