import { AppError, type ModelTokenUsage } from "@vivd-catalyst/core";
import type { ModelMessage, ModelTool } from "./types";
import type {
  OpenAiCompatibleMessage,
  OpenAiCompatibleResponse
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

function toProviderToolName(toolName: string): string {
  const providerName = `tool_${Buffer.from(toolName, "utf8").toString("base64url")}`;
  if (providerName.length > 64) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Tool name '${toolName}' is too long for the OpenAI-compatible provider name limit`
    );
  }
  return providerName;
}
