import { AppError, createPlatformId } from "@vivd-stage/core";
import type {
  ModelCompletion,
  ModelCompletionRequest,
  ModelCompletionStreamEvent,
  ModelProvider,
  ModelTool,
  ModelToolCall
} from "./types";

export class DeterministicModelProvider implements ModelProvider {
  readonly id: string;

  constructor(id = "local") {
    this.id = id;
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletion> {
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    if (toolMessages.length > 0) {
      return {
        text: `Tool work completed:\n\n${toolMessages.map((message) => message.content).join("\n\n")}`,
        toolCalls: [],
        usage: noReportedUsage()
      };
    }

    const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
    const content = lastUserMessage?.content.trim() ?? "";
    if (isConversationTitleRequest(request)) {
      return {
        text: createDeterministicConversationTitle(content),
        toolCalls: [],
        usage: noReportedUsage()
      };
    }

    const toolCall = parseToolCommand(content, request.tools);

    if (toolCall) {
      return {
        text: `I will run ${toolCall.toolName} with the provided input.`,
        toolCalls: [toolCall],
        usage: noReportedUsage()
      };
    }

    return {
      text:
        content.length > 0
          ? `Local agent response: I received "${content}". Use /tool <tool.name> <json> to exercise a registered tool.`
          : "Local agent response: send a message or invoke a tool with /tool <tool.name> <json>.",
      toolCalls: [],
      usage: noReportedUsage()
    };
  }

  async *stream(request: ModelCompletionRequest): AsyncIterable<ModelCompletionStreamEvent> {
    const completion = await this.complete(request);
    if (completion.toolCalls.length === 0 && completion.text.length > 0) {
      for (const delta of chunkText(completion.text)) {
        await delay(20);
        yield {
          type: "text_delta",
          delta
        };
      }
    }
    yield {
      type: "completed",
      completion
    };
  }
}

function isConversationTitleRequest(request: ModelCompletionRequest): boolean {
  return request.messages.some(
    (message) =>
      message.role === "system" &&
      /short neutral headline/u.test(message.content) &&
      /conversation list/u.test(message.content)
  );
}

function createDeterministicConversationTitle(content: string): string {
  const userMessage = content.match(/User message:\n([\s\S]*?)(?:\n\nAssistant response:|$)/u)?.[1] ?? content;
  const source = userMessage.toLowerCase();
  if (source.includes("tool")) {
    return "Tool result review";
  }

  const words = userMessage
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 5);
  return words.length > 0 ? toTitleCase(words.join(" ")) : "Conversation review";
}

function toTitleCase(value: string): string {
  return value.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function noReportedUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source: "not_reported" as const
  };
}

function parseToolCommand(content: string, tools: ModelTool[]): ModelToolCall | undefined {
  if (!content.startsWith("/tool ")) {
    return undefined;
  }

  const [, toolName, json = "{}"] = content.match(/^\/tool\s+(\S+)\s*([\s\S]*)$/u) ?? [];
  if (!toolName) {
    return undefined;
  }
  if (!tools.some((tool) => tool.name === toolName)) {
    throw new AppError("BAD_REQUEST", `Tool '${toolName}' is not available to this agent`);
  }

  return {
    toolCallId: createPlatformId("toolcall"),
    toolName,
    input: parseJsonObject(json || "{}")
  };
}

function parseJsonObject(value: string): unknown {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    throw new AppError("BAD_REQUEST", "Tool input must be valid JSON");
  }
}

function chunkText(text: string): string[] {
  return text.match(/\S+\s*/gu) ?? [text];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
