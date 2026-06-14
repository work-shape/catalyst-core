import {
  AppError,
  type OpenAiCompatibleModelProviderApiConfig,
  type ReasoningEffortConfig,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import type {
  ModelCompletion,
  ModelCompletionRequest,
  ModelCompletionStreamEvent,
  ModelProvider
} from "./types";
import {
  createProviderToolMetadata,
  parseJsonObject,
  readOpenAiResponsesText,
  toModelUsage,
  toOpenAiChatMessage,
  toOpenAiResponsesInput,
  toOpenAiResponsesTools,
  toResponsesModelUsage,
  type OpenAiCompatibleProviderTool
} from "./openai-compatible-mapping";
import {
  streamOpenAiCompatibleCompletion,
  streamOpenAiResponsesCompletion
} from "./openai-compatible-stream";
import type {
  OpenAiCompatibleRequestBody,
  OpenAiCompatibleResponse,
  OpenAiResponsesOutputItem,
  OpenAiResponsesRequestBody,
  OpenAiResponsesResponse
} from "./openai-compatible-types";

export interface OpenAiCompatibleChatProviderOptions {
  id: string;
  api?: OpenAiCompatibleModelProviderApiConfig;
  model: string;
  baseUrl: string;
  apiKey: string;
  organization?: string;
  reasoningEffort?: ReasoningEffortConfig;
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
    if (this.options.api === "responses") {
      return this.completeResponses(request, context);
    }
    return this.completeChatCompletions(request, context);
  }

  async *stream(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): AsyncIterable<ModelCompletionStreamEvent> {
    if (this.options.api === "responses") {
      yield* this.streamResponses(request, context);
      return;
    }
    yield* this.streamChatCompletions(request, context);
  }

  private async completeChatCompletions(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): Promise<ModelCompletion> {
    const { providerTools, toolNameMap } = createProviderToolMetadata(request.tools);
    const response = await this.postChatCompletion({
      body: this.createChatCompletionsRequestBody(request, providerTools),
      signal: context.signal
    });

    if (!response.ok) {
      throw await this.createProviderError(response, "request");
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

  private async *streamChatCompletions(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): AsyncIterable<ModelCompletionStreamEvent> {
    const { providerTools, toolNameMap } = createProviderToolMetadata(request.tools);
    const response = await this.postChatCompletion({
      body: {
        ...this.createChatCompletionsRequestBody(request, providerTools),
        stream: true,
        stream_options: {
          include_usage: true
        }
      },
      signal: context.signal
    });

    if (!response.ok) {
      throw await this.createProviderError(response, "stream request");
    }
    if (!response.body) {
      throw new AppError("INTERNAL", "Model provider stream returned no response body", {
        providerId: this.id
      });
    }

    yield* streamOpenAiCompatibleCompletion(response.body, toolNameMap);
  }

  private async completeResponses(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): Promise<ModelCompletion> {
    const { providerTools, toolNameMap } = createProviderToolMetadata(request.tools);
    const response = await this.postResponse({
      body: this.createResponsesRequestBody(request, providerTools),
      signal: context.signal
    });

    if (!response.ok) {
      throw await this.createProviderError(response, "request");
    }

    const payload = (await response.json()) as OpenAiResponsesResponse;
    return {
      text: readOpenAiResponsesText(payload),
      toolCalls: readOpenAiResponsesToolCalls(payload, toolNameMap),
      usage: toResponsesModelUsage(payload.usage)
    };
  }

  private async *streamResponses(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): AsyncIterable<ModelCompletionStreamEvent> {
    const { providerTools, toolNameMap } = createProviderToolMetadata(request.tools);
    const response = await this.postResponse({
      body: {
        ...this.createResponsesRequestBody(request, providerTools),
        stream: true
      },
      signal: context.signal
    });

    if (!response.ok) {
      throw await this.createProviderError(response, "stream request");
    }
    if (!response.body) {
      throw new AppError("INTERNAL", "Model provider stream returned no response body", {
        providerId: this.id
      });
    }

    yield* streamOpenAiResponsesCompletion(response.body, toolNameMap);
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

  private postResponse(input: {
    body: OpenAiResponsesRequestBody;
    signal?: AbortSignal;
  }): Promise<Response> {
    return fetch(`${this.options.baseUrl.replace(/\/$/u, "")}/responses`, {
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

  private createChatCompletionsRequestBody(
    request: ModelCompletionRequest,
    providerTools: OpenAiCompatibleProviderTool[]
  ): OpenAiCompatibleRequestBody {
    return {
      model: request.model || this.options.model,
      messages: request.messages.map(toOpenAiChatMessage),
      reasoning_effort: this.options.reasoningEffort,
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

  private createResponsesRequestBody(
    request: ModelCompletionRequest,
    providerTools: OpenAiCompatibleProviderTool[]
  ): OpenAiResponsesRequestBody {
    return {
      model: request.model || this.options.model,
      input: toOpenAiResponsesInput(request.messages),
      ...(this.options.reasoningEffort
        ? {
            reasoning: {
              effort: this.options.reasoningEffort
            }
          }
        : {}),
      tools: toOpenAiResponsesTools(providerTools),
      tool_choice: request.tools.length > 0 ? "auto" : undefined,
      store: false
    };
  }

  private async createProviderError(
    response: Response,
    operation: "request" | "stream request"
  ): Promise<AppError> {
    const errorBody = await readProviderErrorBody(response);
    return new AppError(
      "INTERNAL",
      `Model provider ${operation} failed with ${response.status}${errorBody ? `: ${errorBody}` : ""}`,
      {
        providerId: this.id,
        status: response.status,
        providerError: errorBody
      }
    );
  }
}

function readOpenAiResponsesToolCalls(
  payload: OpenAiResponsesResponse,
  toolNameMap: Map<string, string>
): ModelCompletion["toolCalls"] {
  return (
    payload.output
      ?.filter(isOpenAiResponsesFunctionCall)
      .map((toolCall) => ({
        toolCallId: toolCall.call_id,
        toolName: toolNameMap.get(toolCall.name) ?? toolCall.name,
        input: parseJsonObject(toolCall.arguments)
      })) ?? []
  );
}

function isOpenAiResponsesFunctionCall(
  item: OpenAiResponsesOutputItem
): item is Extract<OpenAiResponsesOutputItem, { type: "function_call" }> {
  return (
    item.type === "function_call" &&
    "call_id" in item &&
    "name" in item &&
    "arguments" in item &&
    typeof item.call_id === "string" &&
    typeof item.name === "string" &&
    typeof item.arguments === "string"
  );
}

const providerErrorBodyLimit = 2000;

async function readProviderErrorBody(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.text()).trim();
    if (!body) {
      return undefined;
    }
    return body.length > providerErrorBodyLimit
      ? `${body.slice(0, providerErrorBodyLimit)}...`
      : body;
  } catch {
    return undefined;
  }
}
