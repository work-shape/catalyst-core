import { AppError, type ModelTokenUsage } from "@vivd-catalyst/core";
import {
  modelContentImages,
  modelContentText,
  type ModelContent,
  type ModelContentPart,
  type ModelMessage,
  type ModelTool
} from "./types";
import type {
  OpenAiCompatibleMessage,
  OpenAiCompatibleResponse,
  OpenAiResponseInput,
  OpenAiResponseInputItem,
  OpenAiResponsesInputContent,
  OpenAiResponsesResponse,
  OpenAiResponsesTool,
  OpenAiResponsesUsage
} from "./openai-compatible-types";

export interface OpenAiCompatibleProviderTool {
  tool: ModelTool;
  providerName: string;
}

type OpenAiChatTextImageContent =
  | string
  | Array<
      | {
          type: "text";
          text: string;
        }
      | {
          type: "image_url";
          image_url: {
            url: string;
          };
        }
    >;

export function createProviderToolMetadata(tools: ModelTool[]): {
  providerTools: OpenAiCompatibleProviderTool[];
  toolNameMap: Map<string, string>;
} {
  const providerTools = tools.map((tool) => ({
    tool,
    providerName: toProviderToolName(tool.name)
  }));
  return {
    providerTools,
    toolNameMap: new Map(providerTools.map(({ tool, providerName }) => [providerName, tool.name]))
  };
}

export function toModelUsage(usage: OpenAiCompatibleResponse["usage"]): ModelTokenUsage {
  if (!usage) {
    return noReportedUsage();
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    source: "provider_reported"
  };
}

export function toResponsesModelUsage(usage: OpenAiResponsesUsage | undefined): ModelTokenUsage {
  if (!usage) {
    return noReportedUsage();
  }

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    source: "provider_reported"
  };
}

export function noReportedUsage(): ModelTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source: "not_reported"
  };
}

export function parseJsonObject(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    throw new AppError("BAD_REQUEST", "Tool input must be valid JSON");
  }
}

export function toOpenAiChatMessages(messages: ModelMessage[]): OpenAiCompatibleMessage[] {
  const output: OpenAiCompatibleMessage[] = [];
  const pendingVisualMessages: OpenAiCompatibleMessage[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "tool") {
      flushPendingVisualMessages(output, pendingVisualMessages);
    }
    output.push(...toOpenAiChatMessagesForOne(message, pendingVisualMessages));
    if (message.role === "tool" && messages[index + 1]?.role !== "tool") {
      flushPendingVisualMessages(output, pendingVisualMessages);
    }
  });
  flushPendingVisualMessages(output, pendingVisualMessages);
  return output;
}

function toOpenAiChatMessagesForOne(
  message: ModelMessage,
  pendingVisualMessages: OpenAiCompatibleMessage[]
): OpenAiCompatibleMessage[] {
  if (message.role === "assistant") {
    return [
      {
        role: "assistant",
        content: modelContentText(message.content) || null,
        tool_calls: message.toolCalls?.map((toolCall) => ({
          id: toolCall.toolCallId,
          type: "function",
          function: {
            name: toProviderToolName(toolCall.toolName),
            arguments: JSON.stringify(toolCall.input)
          }
        }))
      }
    ];
  }

  if (message.role === "tool") {
    const text = modelContentText(message.content);
    const images = modelContentImages(message.content);
    if (images.length > 0) {
      pendingVisualMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Visual output from tool call ${message.toolCallId}.`
          },
          ...images.map((image) => ({
            type: "image_url" as const,
            image_url: {
              url: imageToDataUrl(image)
            }
          }))
        ]
      });
    }
    return [
      {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: text
      }
    ];
  }

  return [
    {
      role: message.role,
      content:
        message.role === "system"
          ? modelContentText(message.content)
          : toOpenAiChatContent(message.content)
    }
  ];
}

export function toOpenAiResponsesInput(messages: ModelMessage[]): OpenAiResponseInput {
  const input: OpenAiResponseInput = [];
  const pendingVisualMessages: OpenAiResponseInputItem[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "tool") {
      flushPendingVisualMessages(input, pendingVisualMessages);
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content) {
        input.push({
          role: "assistant",
          content: modelContentText(message.content)
        });
      }
      for (const toolCall of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: toolCall.toolCallId,
          name: toProviderToolName(toolCall.toolName),
          arguments: JSON.stringify(toolCall.input)
        });
      }
      return;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: modelContentText(message.content)
      });
      const images = modelContentImages(message.content);
      if (images.length > 0) {
        pendingVisualMessages.push({
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Visual output from tool call ${message.toolCallId}.`
            },
            ...images.map((image) => ({
              type: "input_image" as const,
              image_url: imageToDataUrl(image)
            }))
          ]
        });
      }
      if (messages[index + 1]?.role !== "tool") {
        flushPendingVisualMessages(input, pendingVisualMessages);
      }
      return;
    }

    if (message.role === "assistant") {
      input.push({
        role: "assistant",
        content: modelContentText(message.content)
      });
      return;
    }

    input.push({
      role: message.role,
      content:
        message.role === "system"
          ? modelContentText(message.content)
          : toOpenAiResponsesContent(message.content)
    });
  });
  flushPendingVisualMessages(input, pendingVisualMessages);
  return input;
}

export function toOpenAiResponsesTools(
  providerTools: OpenAiCompatibleProviderTool[]
): OpenAiResponsesTool[] {
  return providerTools.map(({ tool, providerName }) => ({
    type: "function",
    name: providerName,
    description: tool.description,
    parameters: tool.inputJsonSchema ?? {
      type: "object",
      additionalProperties: true
    },
    strict: false
  }));
}

export function readOpenAiResponsesText(payload: OpenAiResponsesResponse): string {
  if (payload.output_text) {
    return payload.output_text;
  }
  return (
    payload.output
      ?.filter((item) => item.type === "message")
      .flatMap((item) => ("content" in item && Array.isArray(item.content) ? item.content : []))
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("") ?? ""
  );
}

export function toProviderToolName(toolName: string): string {
  const providerName = `tool_${Buffer.from(toolName, "utf8").toString("base64url")}`;
  if (providerName.length > 64) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Tool name '${toolName}' is too long for the OpenAI-compatible provider name limit`
    );
  }
  return providerName;
}

function toOpenAiChatContent(content: ModelContent): OpenAiChatTextImageContent {
  const images = modelContentImages(content);
  if (images.length === 0) {
    return modelContentText(content);
  }
  const text = modelContentText(content);
  return [
    ...(text
      ? [
          {
            type: "text" as const,
            text
          }
        ]
      : []),
    ...images.map((image) => ({
      type: "image_url" as const,
      image_url: {
        url: imageToDataUrl(image)
      }
    }))
  ];
}

function toOpenAiResponsesContent(content: ModelContent): OpenAiResponsesInputContent {
  const images = modelContentImages(content);
  if (images.length === 0) {
    return modelContentText(content);
  }
  const text = modelContentText(content);
  return [
    ...(text
      ? [
          {
            type: "input_text" as const,
            text
          }
        ]
      : []),
    ...images.map((image) => ({
      type: "input_image" as const,
      image_url: imageToDataUrl(image)
    }))
  ];
}

function imageToDataUrl(image: Extract<ModelContentPart, { type: "image" }>): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`;
}

function flushPendingVisualMessages<T>(target: T[], pending: T[]): void {
  if (pending.length === 0) {
    return;
  }
  target.push(...pending.splice(0, pending.length));
}
