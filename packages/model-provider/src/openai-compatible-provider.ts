import { AppError, type RuntimeCallContext } from "@vivd-stage/core";
import type {
  ModelCompletion,
  ModelCompletionRequest,
  ModelCompletionStreamEvent,
  ModelProvider
} from "./types";
import {
  createProviderToolMetadata,
  parseJsonObject,
  toModelUsage,
  toOpenAiChatMessage,
  type OpenAiCompatibleProviderTool
} from "./openai-compatible-mapping";
import { streamOpenAiCompatibleCompletion } from "./openai-compatible-stream";
import type { OpenAiCompatibleRequestBody, OpenAiCompatibleResponse } from "./openai-compatible-types";

export interface OpenAiCompatibleChatProviderOptions {
  id: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  organization?: string;
}

export class OpenAiCompatibleChatProvider implements ModelProvider {
  readonly id: string;
  private readonly options: OpenAiCompatibleChatProviderOptions;

  constructor(options: OpenAiCompatibleChatProviderOptions) {
    this.id = options.id;
    this.options = options;
  }

  async complete(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): Promise<ModelCompletion> {
    const { providerTools, toolNameMap } = createProviderToolMetadata(request.tools);
    const response = await this.postChatCompletion({
      body: this.createRequestBody(request, providerTools),
      signal: context.signal
    });

    if (!response.ok) {
      throw new AppError("INTERNAL", `Model provider request failed with ${response.status}`, {
        providerId: this.id
      });
    }

    const payload = (await response.json()) as OpenAiCompatibleResponse;
    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new AppError("INTERNAL", "Model provider returned no message");
    }

    return {
      text: message.content ?? "",
      toolCalls:
        message.tool_calls?.map((toolCall) => ({
          toolCallId: toolCall.id,
          toolName: toolNameMap.get(toolCall.function.name) ?? toolCall.function.name,
          input: parseJsonObject(toolCall.function.arguments)
        })) ?? [],
      usage: toModelUsage(payload.usage)
    };
  }

  async *stream(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): AsyncIterable<ModelCompletionStreamEvent> {
    const { providerTools, toolNameMap } = createProviderToolMetadata(request.tools);
    const response = await this.postChatCompletion({
      body: {
        ...this.createRequestBody(request, providerTools),
        stream: true,
        stream_options: {
          include_usage: true
        }
      },
      signal: context.signal
    });

    if (!response.ok) {
      throw new AppError("INTERNAL", `Model provider stream request failed with ${response.status}`, {
        providerId: this.id
      });
    }
    if (!response.body) {
      throw new AppError("INTERNAL", "Model provider stream returned no response body", {
        providerId: this.id
      });
    }

    yield* streamOpenAiCompatibleCompletion(response.body, toolNameMap);
  }

  private postChatCompletion(input: {
    body: OpenAiCompatibleRequestBody & {
      stream?: boolean;
      stream_options?: {
        include_usage: boolean;
      };
    };
    signal?: AbortSignal;
  }): Promise<Response> {
    return fetch(`${this.options.baseUrl.replace(/\/$/u, "")}/chat/completions`, {
      method: "POST",
      headers: this.createHeaders(),
      body: JSON.stringify(input.body),
      signal: input.signal
    });
  }

  private createHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.options.apiKey}`,
      ...(this.options.organization ? { "openai-organization": this.options.organization } : {})
    };
  }

  private createRequestBody(
    request: ModelCompletionRequest,
    providerTools: OpenAiCompatibleProviderTool[]
  ): OpenAiCompatibleRequestBody {
    return {
      model: request.model || this.options.model,
      messages: request.messages.map(toOpenAiChatMessage),
      tools: providerTools.map(({ tool, providerName }) => ({
        type: "function",
        function: {
          name: providerName,
          description: tool.description,
          parameters: tool.inputJsonSchema ?? {
            type: "object",
            additionalProperties: true
          }
        }
      })),
      tool_choice: request.tools.length > 0 ? "auto" : undefined
    };
  }
}
