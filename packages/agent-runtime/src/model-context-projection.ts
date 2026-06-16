import type {
  AgentRunId,
  AttachmentManifest,
  ChatMessage,
  ClientInstanceId,
  JsonObject,
  JsonValue,
  ToolExecutionResult
} from "@vivd-catalyst/core";
import type { ModelContent, ModelMessage, ModelToolCall } from "@vivd-catalyst/model-provider";
import {
  projectModelVisibleArtifacts,
  type ModelContextArtifactReader
} from "./model-visible-artifacts";

export type { ModelContextArtifactReader } from "./model-visible-artifacts";

const METADATA_VERSION = 1;
const CHARS_PER_TOKEN = 4;

export interface ModelContextProjectionOptions {
  toolOutput: {
    maxTokens: number;
    maxBytes?: number;
  };
  clientInstanceId?: ClientInstanceId;
  artifactReader?: ModelContextArtifactReader;
}

export interface ModelOutputProjection {
  text: string;
  content: ModelContent;
  notice?: JsonObject;
}

export interface StoredToolCall {
  toolCallId: string;
  toolName: string;
  input: JsonValue;
}

export async function projectAgentVisibleHistory(
  messages: ChatMessage[],
  options: ModelContextProjectionOptions
): Promise<ModelMessage[]> {
  const projected = await Promise.all(messages.map((message) => toModelHistoryMessage(message, options)));
  return projected.filter((message): message is ModelMessage => message !== undefined);
}

export function createAssistantToolCallsMetadata(input: {
  runId: AgentRunId;
  toolCalls: readonly ModelToolCall[];
}): JsonObject {
  return {
    agentRuntime: {
      version: METADATA_VERSION,
      kind: "assistant_tool_calls",
      runId: input.runId,
      toolCalls: input.toolCalls.map((toolCall) => ({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: unknownToJsonValue(toolCall.input)
      }))
    }
  };
}

export function createUserMessageMetadata(input: {
  attachmentManifest?: AttachmentManifest;
}): JsonObject | undefined {
  if (!input.attachmentManifest || input.attachmentManifest.attachments.length === 0) {
    return undefined;
  }
  return {
    agentRuntime: {
      version: METADATA_VERSION,
      kind: "user_message",
      attachmentManifest: unknownToJsonValue(input.attachmentManifest)
    }
  };
}

export function createAssistantFinalMetadata(input: { runId: AgentRunId }): JsonObject {
  return {
    agentRuntime: {
      version: METADATA_VERSION,
      kind: "assistant_final",
      runId: input.runId
    }
  };
}

export function createToolResultMetadata(input: {
  runId: AgentRunId;
  toolCall: ModelToolCall;
  result: ToolExecutionResult;
  modelOutput: ModelOutputProjection;
}): JsonObject {
  return {
    agentRuntime: {
      version: METADATA_VERSION,
      kind: "tool_result",
      runId: input.runId,
      toolCallId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
      input: unknownToJsonValue(input.toolCall.input),
      result: unknownToJsonValue(input.result),
      modelOutput: input.modelOutput.text,
      ...(input.modelOutput.notice ? { projectionNotice: input.modelOutput.notice } : {})
    }
  };
}

export async function createModelVisibleToolOutput(
  result: ToolExecutionResult,
  options: ModelContextProjectionOptions
): Promise<ModelOutputProjection> {
  // Data-critical boundary: privateOutput and private rendered display data must never be
  // serialized into model-visible history. Private render-view tools return only a zero-data
  // acknowledgement through output unless they are explicitly implemented as non-private query tools.
  const content =
    result.status === "success"
      ? stringifyForModel(result.output ?? { status: "success" })
      : stringifyForModel(result.error);
  const bounded = boundModelOutput(content, options);
  const visualArtifacts = await projectModelVisibleArtifacts(result, options);
  if (visualArtifacts.parts.length === 0) {
    return bounded;
  }
  const text = visualArtifacts.summary ? `${bounded.text}\n\n${visualArtifacts.summary}` : bounded.text;
  return {
    ...bounded,
    text,
    content: [
      {
        type: "text",
        text
      },
      ...visualArtifacts.parts
    ]
  };
}

export function dropCurrentSubmittedMessage(messages: ChatMessage[], text: string): ChatMessage[] {
  const last = messages.at(-1);
  if (last?.role === "user" && last.text === text) {
    return messages.slice(0, -1);
  }
  return messages;
}

export function createSubmittedUserMessageContent(
  text: string,
  attachmentManifest: AttachmentManifest | undefined
): string {
  return appendAttachmentManifestForModel(text, attachmentManifest);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(unknownToJsonValue(value)));
}

async function toModelHistoryMessage(
  message: ChatMessage,
  options: ModelContextProjectionOptions
): Promise<ModelMessage | undefined> {
  if (message.role === "user" || message.role === "system") {
    return {
      role: message.role,
      content:
        message.role === "user"
          ? appendAttachmentManifestForModel(message.text, readUserAttachmentManifest(message.metadata))
          : message.text
    };
  }

  if (message.role === "assistant") {
    const toolCalls = readAssistantToolCalls(message.metadata);
    return toolCalls
      ? {
          role: "assistant",
          content: message.text,
          toolCalls
        }
      : {
          role: "assistant",
          content: message.text
        };
  }

  if (message.role === "tool") {
    const metadata = readToolResultMetadata(message.metadata);
    if (!metadata) {
      return undefined;
    }
    const result = readToolExecutionResult(metadata.result);
    const projected = result
      ? (await createModelVisibleToolOutput(result, options)).content
      : typeof metadata.modelOutput === "string"
        ? metadata.modelOutput
        : message.text;
    return {
      role: "tool",
      toolCallId: metadata.toolCallId,
      content: projected
    };
  }

  return undefined;
}

function readAssistantToolCalls(metadata: JsonObject | undefined): ModelToolCall[] | undefined {
  const runtime = readRuntimeMetadata(metadata);
  if (runtime?.kind !== "assistant_tool_calls" || !Array.isArray(runtime.toolCalls)) {
    return undefined;
  }
  const toolCalls: ModelToolCall[] = [];
  for (const value of runtime.toolCalls) {
    if (!isJsonObject(value)) {
      continue;
    }
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    const toolName = typeof value.toolName === "string" ? value.toolName : undefined;
    if (!toolCallId || !toolName) {
      continue;
    }
    toolCalls.push({
      toolCallId,
      toolName,
      input: value.input
    });
  }
  return toolCalls.length > 0 ? toolCalls : undefined;
}

function readToolResultMetadata(metadata: JsonObject | undefined):
  | {
      toolCallId: string;
      result?: JsonValue;
      modelOutput?: JsonValue;
    }
  | undefined {
  const runtime = readRuntimeMetadata(metadata);
  if (runtime?.kind !== "tool_result") {
    return undefined;
  }
  const toolCallId = typeof runtime.toolCallId === "string" ? runtime.toolCallId : undefined;
  if (!toolCallId) {
    return undefined;
  }
  return {
    toolCallId,
    result: runtime.result,
    modelOutput: runtime.modelOutput
  };
}

function readRuntimeMetadata(metadata: JsonObject | undefined): JsonObject | undefined {
  const runtime = metadata?.agentRuntime;
  return isJsonObject(runtime) && runtime.version === METADATA_VERSION ? runtime : undefined;
}

function readUserAttachmentManifest(metadata: JsonObject | undefined): AttachmentManifest | undefined {
  const runtime = readRuntimeMetadata(metadata);
  if (runtime?.kind !== "user_message" || !isJsonObject(runtime.attachmentManifest)) {
    return undefined;
  }
  const manifest = runtime.attachmentManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.attachments)) {
    return undefined;
  }
  const attachments = manifest.attachments.flatMap((value): AttachmentManifest["attachments"] => {
    if (!isJsonObject(value)) {
      return [];
    }
    const fileId = typeof value.fileId === "string" ? value.fileId : undefined;
    const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
    const filename = typeof value.filename === "string" ? value.filename : undefined;
    const byteSize = typeof value.byteSize === "number" ? value.byteSize : undefined;
    const metadata = isJsonObject(value.metadata) ? value.metadata : undefined;
    if (!fileId || !attachmentId || !filename || byteSize === undefined || !metadata) {
      return [];
    }
    return [
      {
        fileId: fileId as AttachmentManifest["attachments"][number]["fileId"],
        attachmentId: attachmentId as AttachmentManifest["attachments"][number]["attachmentId"],
        filename,
        mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
        byteSize,
        status: "ready",
        readable: true,
        readToolName: "read_document",
        metadata: {
          fileId: fileId as AttachmentManifest["attachments"][number]["metadata"]["fileId"],
          filename,
          mimeType: typeof metadata.mimeType === "string" ? metadata.mimeType : undefined,
          byteSize,
          format:
            metadata.format === "pdf" ||
            metadata.format === "docx" ||
            metadata.format === "txt" ||
            metadata.format === "md"
              ? metadata.format
              : undefined,
          characterCount: typeof metadata.characterCount === "number" ? metadata.characterCount : undefined,
          wordCount: typeof metadata.wordCount === "number" ? metadata.wordCount : undefined,
          pageCount: typeof metadata.pageCount === "number" ? metadata.pageCount : undefined,
          warnings: [],
          preprocessingVersion:
            typeof metadata.preprocessingVersion === "string" ? metadata.preprocessingVersion : undefined
        }
      }
    ];
  });
  return attachments.length > 0 ? { version: 1, attachments } : undefined;
}

function appendAttachmentManifestForModel(
  text: string,
  attachmentManifest: AttachmentManifest | undefined
): string {
  if (!attachmentManifest || attachmentManifest.attachments.length === 0) {
    return text;
  }
  const lines = [
    text,
    "",
    "[Attached documents]",
    ...attachmentManifest.attachments.map((attachment) => {
      const metadata = attachment.metadata;
      const details = [
        `fileId: ${attachment.fileId}`,
        `status: ${attachment.status}`,
        `size: ${attachment.byteSize} bytes`,
        metadata.format ? `format: ${metadata.format}` : undefined,
        metadata.wordCount !== undefined ? `words: ${metadata.wordCount}` : undefined,
        metadata.pageCount !== undefined ? `pages: ${metadata.pageCount}` : undefined
      ].filter((value): value is string => value !== undefined);
      const readHint = `Use read_document({ "fileId": "${attachment.fileId}", "mode": "full" }) to read the full prepared text.`;
      const viewHint =
        metadata.format === "pdf"
          ? `Use view_document_page({ "fileId": "${attachment.fileId}", "pageNumber": 1 }) to visually inspect a specific PDF page when layout or images matter.`
          : undefined;
      return `- ${attachment.filename} (${details.join(", ")}). ${[readHint, viewHint].filter(Boolean).join(" ")}`;
    })
  ];
  return lines.join("\n");
}

function readToolExecutionResult(value: JsonValue | undefined): ToolExecutionResult | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  if (value.status === "success") {
    return value as unknown as ToolExecutionResult;
  }
  if (
    (value.status === "failed" || value.status === "cancelled" || value.status === "timed_out") &&
    isJsonObject(value.error)
  ) {
    return value as unknown as ToolExecutionResult;
  }
  return undefined;
}

function boundModelOutput(
  content: string,
  options: ModelContextProjectionOptions
): ModelOutputProjection {
  const originalBytes = byteLength(content);
  const originalTokens = estimateTokens(content);
  const maxBytes = options.toolOutput.maxBytes;
  const maxTokens = options.toolOutput.maxTokens;
  const overTokenLimit = originalTokens > maxTokens;
  const overByteLimit = maxBytes !== undefined && originalBytes > maxBytes;
  if (!overTokenLimit && !overByteLimit) {
    return {
      text: content,
      content
    };
  }

  const maxCharsByTokens = maxTokens * CHARS_PER_TOKEN;
  const maxCharsByBytes = maxBytes ?? Number.POSITIVE_INFINITY;
  const maxChars = Math.max(1000, Math.min(maxCharsByTokens, maxCharsByBytes));
  const marker = [
    "",
    "[Tool output bounded for active model context]",
    `Original estimate: ${originalTokens} tokens / ${originalBytes} bytes.`,
    `Projected limit: ${maxTokens} tokens${maxBytes ? ` / ${maxBytes} bytes` : ""}.`,
    "The full tool output remains stored in agent-visible history and may be available as a managed artifact."
  ].join("\n");
  const markerBudget = marker.length + 8;
  const contentBudget = Math.max(0, maxChars - markerBudget);
  const headLength = Math.ceil(contentBudget / 2);
  const tailLength = Math.floor(contentBudget / 2);
  const bounded =
    content.length <= contentBudget
      ? content
      : `${content.slice(0, headLength)}${marker}\n${content.slice(content.length - tailLength)}`;

  return {
    text: bounded,
    content: bounded,
    notice: {
      type: "tool_output_bounded",
      originalTokens,
      originalBytes,
      projectedTokens: estimateTokens(bounded),
      projectedBytes: byteLength(bounded),
      maxTokens,
      ...(maxBytes ? { maxBytes } : {})
    }
  };
}

function stringifyForModel(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(unknownToJsonValue(value), null, 2);
}

export function unknownToJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(value as number) || typeof value !== "number" ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map(unknownToJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    const result: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested !== "undefined" && typeof nested !== "function" && typeof nested !== "symbol") {
        result[key] = unknownToJsonValue(nested);
      }
    }
    return result;
  }
  if (typeof value === "undefined") {
    return null;
  }
  return String(value);
}

function sortForStableStringify(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }
  if (isJsonObject(value)) {
    const sorted: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortForStableStringify(value[key] as JsonValue);
    }
    return sorted;
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}
