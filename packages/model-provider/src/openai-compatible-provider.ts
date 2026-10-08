import {
  AppError,
  type ModelProviderAuthModeConfig,
  type OpenAiCompatibleModelProviderApiConfig,
  type OpenAiCompatibleContextManagementConfig,
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
  createOpenAiResponsesContinuation,
  didOpenAiResponsesCompact,
  readOpenAiResponsesCompactionItem,
  readOpenAiResponsesWebMetadata,
  readOpenAiResponsesWebSearchCallCount,
  readOpenAiResponsesText,
  readOpenAiResponsesContinuationItems,
  readProviderServiceTier,
  toModelUsage,
  toOpenAiChatMessages,
  toOpenAiResponsesInput,
  toOpenAiResponsesTools,
  toResponsesModelUsage,
  type OpenAiCompatibleProviderTool
} from "./openai-compatible-mapping";
import { readProviderErrorMetadata } from "./provider-error";
import { parseToolInput } from "./tool-input";
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
  authMode?: ModelProviderAuthModeConfig;
  organization?: string;
  reasoningEffort?: ReasoningEffortConfig;
  contextManagement?: OpenAiCompatibleContextManagementConfig;
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
    const { providerTools, providerNativeTools, toolNameMap } = createProviderToolMetadata(
      request.tools
    );
    assertNoProviderNativeToolsForChatCompletions(providerNativeTools);
    const response = await this.postChatCompletion({
      body: this.createChatCompletionsRequestBody(request, providerTools),
      signal: context.signal
    });

    if (!response.ok) {
      throw await this.createProviderError(response);
    }

    const payload = (await this.readResponseJson(response)) as OpenAiCompatibleResponse;
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
          ...parseToolInput(toolCall.function.arguments)
        })) ?? [],
      sources: [],
      citations: [],
      usage: { ...toModelUsage(payload.usage), ...readProviderServiceTier(payload) }
    };
  }

  private async *streamChatCompletions(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): AsyncIterable<ModelCompletionStreamEvent> {
    const { providerTools, providerNativeTools, toolNameMap } = createProviderToolMetadata(
      request.tools
    );
    assertNoProviderNativeToolsForChatCompletions(providerNativeTools);
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
      throw await this.createProviderError(response);
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
    const { providerTools, providerNativeTools, toolNameMap } = createProviderToolMetadata(
      request.tools
    );
    const response = await this.postResponse({
      body: this.createResponsesRequestBody(request, providerTools, providerNativeTools),
      signal: context.signal
    });

    if (!response.ok) {
      throw await this.createProviderError(response);
    }

    const payload = (await this.readResponseJson(response)) as OpenAiResponsesResponse;
    const webMetadata = readOpenAiResponsesWebMetadata(payload);
    return {
      text: readOpenAiResponsesText(payload),
      toolCalls: readOpenAiResponsesToolCalls(payload, toolNameMap),
      continuation: createOpenAiResponsesContinuation(this.id, payload, request.continuation),
      contextManagement: {
        compacted: didOpenAiResponsesCompact(payload)
      },
      sources: webMetadata.sources,
      citations: webMetadata.citations,
      usage: {
        ...toResponsesModelUsage(payload.usage, readOpenAiResponsesWebSearchCallCount(payload)),
        ...readProviderServiceTier(payload)
      }
    };
  }

  private async *streamResponses(
    request: ModelCompletionRequest,
    context: RuntimeCallContext
  ): AsyncIterable<ModelCompletionStreamEvent> {
    const { providerTools, providerNativeTools, toolNameMap } = createProviderToolMetadata(
      request.tools
    );
    const response = await this.postResponse({
      body: {
        ...this.createResponsesRequestBody(request, providerTools, providerNativeTools),
        stream: true
      },
      signal: context.signal
    });

    if (!response.ok) {
      throw await this.createProviderError(response);
    }
    if (!response.body) {
      throw new AppError("INTERNAL", "Model provider stream returned no response body", {
        providerId: this.id
      });
    }

    yield* streamOpenAiResponsesCompletion(
      response.body,
      toolNameMap,
      this.id,
      request.continuation,
      response.headers
    );
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
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if ((this.options.authMode ?? "bearer") === "api-key") {
      headers["api-key"] = this.options.apiKey;
    } else {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    if (this.options.organization) {
      headers["openai-organization"] = this.options.organization;
    }
    return headers;
  }

  private resolveReasoningEffort(
    request: ModelCompletionRequest
  ): ReasoningEffortConfig | undefined {
    return request.reasoningEffort ?? this.options.reasoningEffort;
  }

  private createChatCompletionsRequestBody(
    request: ModelCompletionRequest,
    providerTools: OpenAiCompatibleProviderTool[]
  ): OpenAiCompatibleRequestBody {
    return {
      model: request.model || this.options.model,
      messages: toOpenAiChatMessages(request.messages),
      reasoning_effort: this.resolveReasoningEffort(request),
      ...(request.fastMode ? { service_tier: "priority" as const } : {}),
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
    providerTools: OpenAiCompatibleProviderTool[],
    providerNativeTools: ReturnType<typeof createProviderToolMetadata>["providerNativeTools"]
  ): OpenAiResponsesRequestBody {
    const model = request.model || this.options.model;
    const reasoningEffort = this.resolveReasoningEffort(request);
    return {
      model,
      input: toOpenAiResponsesInput(
        request.messages,
        readOpenAiResponsesContinuationItems(this.id, request.continuation),
        readOpenAiResponsesCompactionItem(this.id, request.continuation)
      ),
      ...(reasoningEffort
        ? {
            reasoning: {
              effort: reasoningEffort,
              ...(reasoningEffort !== "none" && shouldRequestReasoningSummary(model)
                ? { summary: "auto" as const }
                : {})
            }
          }
        : {}),
      tools: toOpenAiResponsesTools(providerTools, providerNativeTools),
      include: [
        "reasoning.encrypted_content",
        ...(providerNativeTools.length > 0 ? ["web_search_call.action.sources"] : [])
      ],
      tool_choice: request.tools.length > 0 ? "auto" : undefined,
      ...(request.fastMode ? { service_tier: "priority" as const } : {}),
      ...(this.options.contextManagement?.compaction
        ? {
            context_management: [
              {
                type: "compaction" as const,
                compact_threshold: this.options.contextManagement.compaction.compactThresholdTokens
              }
            ]
          }
        : {}),
      store: false
    };
  }

  private async readResponseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      throw new AppError("INTERNAL", "Model provider returned invalid JSON", {
        providerId: this.id,
        status: response.status,
        ...readProviderErrorMetadata(undefined, response.headers)
      });
    }
  }

  private async createProviderError(response: Response): Promise<AppError> {
    const payload: unknown = await response.json().catch(() => undefined);
    return new AppError("INTERNAL", "Model provider request failed", {
      providerId: this.id,
      status: response.status,
      ...readProviderErrorMetadata(payload, response.headers)
    });
  }
}

function assertNoProviderNativeToolsForChatCompletions(
  providerNativeTools: ReturnType<typeof createProviderToolMetadata>["providerNativeTools"]
): void {
  if (providerNativeTools.length === 0) {
    return;
  }
  throw new AppError(
    "VALIDATION_FAILED",
    "Provider-native model tools are only supported for OpenAI-compatible providers configured with api: responses"
  );
}

function shouldRequestReasoningSummary(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  );
}

function readOpenAiResponsesToolCalls(
  payload: OpenAiResponsesResponse,
  toolNameMap: Map<string, string>
): ModelCompletion["toolCalls"] {
  return (
    payload.output?.filter(isOpenAiResponsesFunctionCall).map((toolCall) => ({
      toolCallId: toolCall.call_id,
      toolName: toolNameMap.get(toolCall.name) ?? toolCall.name,
      ...parseToolInput(toolCall.arguments)
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
