import { AppError, type ModelTokenUsage } from "@vivd-catalyst/core";
import type { ModelMessage, ModelTool } from "./types";
import type {
  OpenAiCompatibleMessage,
  OpenAiCompatibleResponse,
  OpenAiResponseInput,
  OpenAiResponsesResponse,
  OpenAiResponsesTool,
  OpenAiResponsesUsage
} from "./openai-compatible-types";

export interface OpenAiCompatibleProviderTool {
  tool: ModelTool;
  providerName: string;
}

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

export function toOpenAiChatMessage(message: ModelMessage): OpenAiCompatibleMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls?.map((toolCall) => ({
        id: toolCall.toolCallId,
        type: "function",
        function: {
          name: toProviderToolName(toolCall.toolName),
          arguments: JSON.stringify(toolCall.input)
        }
      }))
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

export function toOpenAiResponsesInput(messages: ModelMessage[]): OpenAiResponseInput {
  const input: OpenAiResponseInput = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content) {
        input.push({
          role: "assistant",
          content: message.content
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
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content
      });
      continue;
    }

    input.push({
      role: message.role,
      content: message.content
    });
  }
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
