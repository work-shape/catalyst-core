import type { Message } from "@vivd-catalyst/api-client";
import {
  readAgentRuntimeMessageMetadata,
  readAssistantToolCallsMetadata,
  readToolResultMetadata,
  readUserMessageMetadata
} from "@vivd-catalyst/core";

export interface PersistedAttachmentRef {
  fileId: string;
  filename: string;
  mimeType?: string;
}

export interface PersistedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export type PersistedToolResult =
  | {
      status: "success";
      toolCallId: string;
      output: unknown;
    }
  | {
      status: "failed";
      toolCallId: string;
      errorText: string;
      output?: unknown;
    };

export function readCompatibleMessageRunId(
  message: Pick<Message, "metadata">
): string | undefined {
  const runtime = readAgentRuntimeMessageMetadata(message.metadata);
  return runtime && "runId" in runtime ? runtime.runId : undefined;
}

export function readCompatibleUserAttachmentRefs(
  message: Pick<Message, "metadata">
): PersistedAttachmentRef[] {
  const runtime = readUserMessageMetadata(message.metadata);
  return runtime ? readCompatibleAttachmentManifestRefs(runtime.attachmentManifest) : [];
}

export function readCompatibleAssistantToolCalls(
  message: Pick<Message, "metadata" | "role">
): PersistedToolCall[] {
  if (message.role !== "assistant") {
    return [];
  }
  const runtime = readAssistantToolCallsMetadata(message.metadata);
  if (!runtime) {
    return [];
  }
  return runtime.toolCalls.map((toolCall) => ({
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: toolCall.input
  }));
}

export function readCompatiblePersistedToolResult(
  message: Pick<Message, "metadata" | "role">
): PersistedToolResult | undefined {
  if (message.role !== "tool") {
    return undefined;
  }
  const runtime = readToolResultMetadata(message.metadata);
  if (!runtime) {
    return undefined;
  }
  const result = isRecord(runtime.result) ? runtime.result : undefined;
  if (result?.status === "success") {
    return {
      status: "success",
      toolCallId: runtime.toolCallId,
      output: {
        status: "success",
        output: result.output,
        display: result.display,
        artifacts: result.artifacts,
        projectionNotice: runtime.projectionNotice
      }
    };
  }
  if (
    (result?.status === "failed" || result?.status === "cancelled" || result?.status === "timed_out") &&
    isRecord(result.error)
  ) {
    return {
      status: "failed",
      toolCallId: runtime.toolCallId,
      errorText: typeof result.error.message === "string" ? result.error.message : "Tool call failed",
      output: {
        status: result.status,
        error: {
          code: typeof result.error.code === "string" ? result.error.code : "handler_failed"
        },
        projectionNotice: runtime.projectionNotice
      }
    };
  }
  return undefined;
}

function readCompatibleAttachmentManifestRefs(value: unknown): PersistedAttachmentRef[] {
  const manifest = isRecord(value) ? value : undefined;
  if (manifest?.version !== 1 || !Array.isArray(manifest.attachments)) {
    return [];
  }
  return manifest.attachments.flatMap((entry): PersistedAttachmentRef[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const fileId = typeof entry.fileId === "string" ? entry.fileId : undefined;
    const filename = typeof entry.filename === "string" ? entry.filename : undefined;
    if (!fileId || !filename) {
      return [];
    }
    const mimeType = typeof entry.mimeType === "string" ? entry.mimeType : undefined;
    return [
      {
        fileId,
        filename,
        ...(mimeType ? { mimeType } : {})
      }
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
