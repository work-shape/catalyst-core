import type { UIMessage } from "ai";
import type {
  AgentRunProjection,
  DraftAttachment,
  Message
} from "@vivd-catalyst/api-client";
import {
  readCompatibleAssistantToolCalls,
  readCompatibleMessageRunId,
  readCompatiblePersistedToolResult,
  readCompatibleUserAttachmentRefs,
  type PersistedToolResult
} from "./assistant/assistant-message-compat";

export interface AssistantUiActiveRun {
  run: {
    id: string;
    status: string;
  };
  projection: AgentRunProjection;
}

interface AiSdkMessageFormatRepository {
  headId: string | null;
  messages: Array<{
    parentId: string | null;
    message: UIMessage;
  }>;
}

export function toAiSdkMessageRepository(messages: UIMessage[]): AiSdkMessageFormatRepository {
  let parentId: string | null = null;
  return {
    headId: messages.at(-1)?.id ?? null,
    messages: messages.map((message) => {
      const item = {
        parentId,
        message
      };
      parentId = message.id;
      return item;
    })
  };
}

export function toUiMessages(
  messages: Message[],
  activeRun?: AssistantUiActiveRun
): UIMessage[] {
  const visibleMessages = activeRun
    ? withoutRunResponseMessages(messages, activeRun.run.id)
    : messages;
  const projectedMessages = toPersistedUiMessages(visibleMessages);
  const activeRunMessage = activeRun ? toActiveRunUiMessage(activeRun) : undefined;
  return activeRunMessage ? [...projectedMessages, activeRunMessage] : projectedMessages;
}

export function createMessageSnapshotKey(
  messages: Message[],
  activeRun?: AssistantUiActiveRun
): string {
  return JSON.stringify({
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      metadata: message.metadata
    })),
    activeRun: activeRun
      ? {
          run: activeRun.run,
          projection: activeRun.projection
        }
      : undefined
  });
}

export function toAttachmentFilePart(
  attachment: Pick<DraftAttachment, "fileId" | "filename" | "mimeType">
): UIMessage["parts"][number] {
  return {
    type: "file",
    mediaType: attachment.mimeType ?? "application/octet-stream",
    filename: attachment.filename,
    url: `vivd-file://${encodeURIComponent(attachment.fileId)}`
  };
}

function toPersistedUiMessages(messages: Message[]): UIMessage[] {
  const toolResultsByToolCallId = new Map<string, PersistedToolResult>();
  for (const message of messages) {
    const toolResult = readCompatiblePersistedToolResult(message);
    if (toolResult) {
      toolResultsByToolCallId.set(toolResult.toolCallId, toolResult);
    }
  }

  return messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
    .map((message) => ({
      id: message.id,
      role: message.role as UIMessage["role"],
      parts: toUiMessageParts(message, toolResultsByToolCallId)
    }));
}

function toActiveRunUiMessage(activeRun: AssistantUiActiveRun): UIMessage {
  const terminal =
    activeRun.run.status === "completed" ||
    activeRun.run.status === "cancelled" ||
    activeRun.run.status === "failed";
  const projectionParts = activeRun.projection.parts ?? [];
  const orderedParts = projectionParts.length > 0
    ? projectionParts
    : legacyActiveRunParts(activeRun.projection);
  const parts = orderedParts.flatMap((part, index): UIMessage["parts"] => {
    if (part.type === "text") {
      if (part.text.trim().length === 0 && orderedParts.length > 1) {
        return [];
      }
      return [
        {
          type: "text",
          text: part.text,
          state: !terminal && index === orderedParts.length - 1 ? "streaming" : "done"
        } as UIMessage["parts"][number]
      ];
    }
    if (part.type === "reasoning") {
      if (!part.text.trim() && !part.open) {
        return [];
      }
      return [
        {
          type: "reasoning",
          text: part.text,
          state: part.open && !terminal ? "streaming" : "done"
        } as UIMessage["parts"][number]
      ];
    }
    return [toToolCallUiPart(part)];
  });

  if (parts.length === 0) {
    parts.push({
      type: "text",
      text: "",
      state: terminal ? "done" : "streaming"
    } as UIMessage["parts"][number]);
  }

  return {
    id: activeRun.run.id,
    role: "assistant",
    parts
  };
}

function legacyActiveRunParts(
  projection: AgentRunProjection
): AgentRunProjection["parts"] {
  const parts: AgentRunProjection["parts"] = [
    ...projection.reasoning.map((entry) => ({
      type: "reasoning" as const,
      id: entry.id,
      text: entry.text,
      open: entry.open
    })),
    ...projection.activeToolCalls.map((entry) => ({
      type: "tool_call" as const,
      ...entry
    }))
  ];
  if (projection.text.trim().length > 0 || parts.length === 0) {
    parts.push({
      type: "text",
      text: projection.text
    });
  }
  return parts;
}

function toToolCallUiPart(
  toolCall: Extract<AgentRunProjection["parts"][number], { type: "tool_call" }>
): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: toolCall.toolName,
    toolCallId: toolCall.toolCallId,
    title: toolCall.toolName,
    state: toAssistantToolState(toolCall.state),
    input: toolCall.input,
    ...(toolCall.state === "output_error"
      ? { errorText: toolCall.errorText ?? "Tool call failed" }
      : toolCall.state === "output_available"
        ? { output: toolCall.output }
        : {})
  } as UIMessage["parts"][number];
}

function toAssistantToolState(
  state: AgentRunProjection["activeToolCalls"][number]["state"]
): string {
  if (state === "output_available") {
    return "output-available";
  }
  if (state === "output_error") {
    return "output-error";
  }
  return "input-available";
}

function toUiMessageParts(
  message: Message,
  toolResultsByToolCallId: Map<string, PersistedToolResult>
): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];
  if (message.text || message.role !== "assistant") {
    parts.push({
      type: "text",
      text: message.text,
      state: "done"
    });
  }
  if (message.role === "user") {
    parts.push(...readUserAttachmentFileParts(message));
  }

  const toolCalls = readCompatibleAssistantToolCalls(message);
  for (const toolCall of toolCalls) {
    const toolResult = toolResultsByToolCallId.get(toolCall.toolCallId);
    parts.push({
      type: "dynamic-tool",
      toolName: toolCall.toolName,
      toolCallId: toolCall.toolCallId,
      title: toolCall.toolName,
      state: toolResult?.status === "failed" ? "output-error" : toolResult ? "output-available" : "input-available",
      input: toolCall.input,
      ...(toolResult?.status === "failed"
        ? { errorText: toolResult.errorText }
        : toolResult
          ? { output: toolResult.output }
          : {})
    } as UIMessage["parts"][number]);
  }

  const display = message.metadata?.display;
  if (display !== undefined) {
    parts.push({
      type: "data-display",
      data: display
    } as UIMessage["parts"][number]);
  }
  return parts.length > 0
    ? parts
    : [
        {
          type: "text",
          text: "",
          state: "done"
        }
      ];
}

function withoutRunResponseMessages(messages: Message[], runId: string): Message[] {
  return messages.filter((message) => {
    const messageRunId = readCompatibleMessageRunId(message);
    if (messageRunId !== runId) {
      return true;
    }
    return message.role === "user";
  });
}

function readUserAttachmentFileParts(message: Message): UIMessage["parts"] {
  return readCompatibleUserAttachmentRefs(message).map(toAttachmentFilePart);
}
