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

export type ModelContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      mimeType: "image/png";
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
