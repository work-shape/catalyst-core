import type {
  AgentRunId,
  AttachmentManifest,
  AttachmentManifestEntry,
  ChatMessage,
  ClientInstanceId,
  JsonObject,
  JsonValue,
  ManagedFileId,
  SupportedImageMimeType,
  ToolExecutionResult
} from "@vivd-catalyst/core";
import type {
  ModelContent,
  ModelContentPart,
  ModelMessage,
  ModelToolCall
} from "@vivd-catalyst/model-provider";
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
  fileReader?: ModelContextFileReader;
}

export interface ModelContextFileReader {
  readFile(input: {
    clientInstanceId: ClientInstanceId;
    fileId: ManagedFileId;
  }): Promise<{
    bytes: Uint8Array;
    mimeType?: string;
  }>;
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

export interface StoredReasoningSummary {
  id: string;
  text: string;
}

export async function projectAgentVisibleHistory(
  messages: ChatMessage[],
  options: ModelContextProjectionOptions
): Promise<ModelMessage[]> {
  const projected = await Promise.all(messages.map((message) => toModelHistoryMessage(message, options)));
  return removeIncompleteToolContext(projected.filter((message): message is ModelMessage => message !== undefined));
}

export function selectRecentCompleteHistory(
  messages: ChatMessage[],
  limit: number | undefined
): ChatMessage[] {
  if (limit === undefined || messages.length <= limit) {
    return messages;
  }

  const chunks = chunkHistoryMessages(messages);
  const selected: ChatMessage[][] = [];
  let selectedCount = 0;

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index] ?? [];
    if (chunk.length === 0) {
      continue;
    }
    if (selectedCount > 0 && selectedCount + chunk.length > limit) {
      selected.unshift(chunk);
      break;
    }
    selected.unshift(chunk);
    selectedCount += chunk.length;
    if (selectedCount >= limit) {
      break;
    }
  }

  return selected.flat();
}

export function createAssistantToolCallsMetadata(input: {
  runId: AgentRunId;
  toolCalls: readonly ModelToolCall[];
  reasoning?: readonly StoredReasoningSummary[];
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
      })),
      ...createReasoningMetadata(input.reasoning)
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

export function createAssistantFinalMetadata(input: {
  runId: AgentRunId;
  reasoning?: readonly StoredReasoningSummary[];
}): JsonObject {
  return {
    agentRuntime: {
      version: METADATA_VERSION,
      kind: "assistant_final",
      runId: input.runId,
      ...createReasoningMetadata(input.reasoning)
    }
  };
}

export function readAssistantReasoningSummaries(
  metadata: JsonObject | undefined
): StoredReasoningSummary[] {
  const runtime = readRuntimeMetadata(metadata);
  if (
    (runtime?.kind !== "assistant_tool_calls" && runtime?.kind !== "assistant_final") ||
    !Array.isArray(runtime.reasoning)
  ) {
    return [];
  }
  return runtime.reasoning.flatMap((value): StoredReasoningSummary[] => {
    if (!isJsonObject(value)) {
      return [];
    }
    const id = typeof value.id === "string" ? value.id : undefined;
    const text = typeof value.text === "string" ? value.text : undefined;
    if (!id || !text) {
      return [];
    }
    return [{ id, text }];
  });
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

export async function createSubmittedUserMessageContent(
  text: string,
  attachmentManifest: AttachmentManifest | undefined,
  options: ModelContextProjectionOptions
): Promise<ModelContent> {
  return createUserMessageContent(text, attachmentManifest, options);
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
          ? await createUserMessageContent(message.text, readUserAttachmentManifest(message.metadata), options)
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

function chunkHistoryMessages(messages: ChatMessage[]): ChatMessage[][] {
  const chunks: ChatMessage[][] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message) {
      break;
    }
    const toolCalls = message.role === "assistant" ? readAssistantToolCalls(message.metadata) : undefined;
    if (!toolCalls?.length) {
      chunks.push([message]);
      index += 1;
      continue;
    }

    const expectedToolCallIds = new Set(toolCalls.map((toolCall) => toolCall.toolCallId));
    const seenToolCallIds = new Set<string>();
    const chunk = [message];
    index += 1;

    while (index < messages.length) {
      const candidate = messages[index];
      if (candidate?.role !== "tool") {
        break;
      }
      const toolResult = readToolResultMetadata(candidate.metadata);
      if (!toolResult || !expectedToolCallIds.has(toolResult.toolCallId)) {
        break;
      }
      chunk.push(candidate);
      seenToolCallIds.add(toolResult.toolCallId);
      index += 1;
      if (seenToolCallIds.size === expectedToolCallIds.size) {
        break;
      }
    }

    chunks.push(chunk);
  }
  return chunks;
}

function removeIncompleteToolContext(messages: ModelMessage[]): ModelMessage[] {
  const activeMessages: ModelMessage[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (!message) {
      break;
    }

    if (message.role === "tool") {
      index += 1;
      continue;
    }

    if (message.role !== "assistant" || !message.toolCalls?.length) {
      activeMessages.push(message);
      index += 1;
      continue;
    }

    const expectedToolCallIds = new Set(message.toolCalls.map((toolCall) => toolCall.toolCallId));
    const seenToolCallIds = new Set<string>();
    const toolResults: ModelMessage[] = [];
    let cursor = index + 1;

    while (cursor < messages.length) {
      const candidate = messages[cursor];
      if (candidate?.role !== "tool") {
        break;
      }
      if (!expectedToolCallIds.has(candidate.toolCallId) || seenToolCallIds.has(candidate.toolCallId)) {
        break;
      }
      toolResults.push(candidate);
      seenToolCallIds.add(candidate.toolCallId);
      cursor += 1;
      if (seenToolCallIds.size === expectedToolCallIds.size) {
        break;
      }
    }

    if (seenToolCallIds.size === expectedToolCallIds.size) {
      activeMessages.push(message, ...toolResults);
      index = cursor;
      continue;
    }

    if (hasTextContent(message.content)) {
      activeMessages.push({
        role: "assistant",
        content: message.content
      });
    }
    index = cursor;
  }

  return activeMessages;
}

function hasTextContent(content: ModelContent): boolean {
  if (typeof content === "string") {
    return content.length > 0;
  }
  return content.some((part) => part.type === "text" && part.text.length > 0);
}

function createReasoningMetadata(
  reasoning: readonly StoredReasoningSummary[] | undefined
): { reasoning?: JsonValue } {
  const summaries =
    reasoning
      ?.map((summary) => ({
        id: summary.id,
        text: summary.text
      }))
      .filter((summary) => summary.text.length > 0) ?? [];
  return summaries.length > 0 ? { reasoning: summaries } : {};
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
    if (!fileId || !attachmentId || !filename || byteSize === undefined) {
      return [];
    }
    const mimeType = typeof value.mimeType === "string" ? value.mimeType : undefined;
    const kind = typeof value.kind === "string" ? value.kind : undefined;
    if (!kind) {
      return [];
    }
    const metadata = isJsonObject(value.metadata) ? value.metadata : undefined;
    const modelVisibility = readModelVisibility(value.modelVisibility);
    const modelContext = readAttachmentModelContext(value.modelContext);
    return [
      {
        kind,
        fileId: fileId as ManagedFileId,
        attachmentId: attachmentId as AttachmentManifest["attachments"][number]["attachmentId"],
        filename,
        mimeType,
        byteSize,
        status: typeof value.status === "string" ? value.status : "ready",
        readable: typeof value.readable === "boolean" ? value.readable : undefined,
        ...(modelVisibility ? { modelVisibility } : {}),
        ...(modelContext ? { modelContext } : {}),
        ...(metadata ? { metadata } : {})
      }
    ];
  });
  return attachments.length > 0 ? { version: 1, attachments } : undefined;
}

async function createUserMessageContent(
  text: string,
  attachmentManifest: AttachmentManifest | undefined,
  options: ModelContextProjectionOptions
): Promise<ModelContent> {
  const projectedText = appendAttachmentManifestForModel(text, attachmentManifest);
  const imageParts = await projectUserAttachmentImages(attachmentManifest, options);
  if (imageParts.length === 0) {
    return projectedText;
  }
  return [
    {
      type: "text",
      text: projectedText
    },
    ...imageParts
  ];
}

function appendAttachmentManifestForModel(
  text: string,
  attachmentManifest: AttachmentManifest | undefined
): string {
  if (!attachmentManifest || attachmentManifest.attachments.length === 0) {
    return text;
  }
  const sections = groupAttachmentModelContext(attachmentManifest.attachments);
  const lines = [
    text,
    ...sections.flatMap(([section, sectionLines]) => ["", `[${section}]`, ...sectionLines])
  ];
  return lines.join("\n");
}

function groupAttachmentModelContext(
  attachments: readonly AttachmentManifestEntry[]
): [string, string[]][] {
  const sections = new Map<string, string[]>();
  for (const attachment of attachments) {
    if (!attachment.modelContext) {
      continue;
    }
    const lines = sections.get(attachment.modelContext.section) ?? [];
    lines.push(attachment.modelContext.text);
    sections.set(attachment.modelContext.section, lines);
  }
  return [...sections.entries()];
}

async function projectUserAttachmentImages(
  attachmentManifest: AttachmentManifest | undefined,
  options: ModelContextProjectionOptions
): Promise<Extract<ModelContentPart, { type: "image" }>[]> {
  if (!attachmentManifest || !options.clientInstanceId || !options.fileReader) {
    return [];
  }
  const images: Extract<ModelContentPart, { type: "image" }>[] = [];
  for (const attachment of attachmentManifest.attachments) {
    if (attachment.modelVisibility?.type !== "image") {
      continue;
    }
    try {
      const object = await options.fileReader.readFile({
        clientInstanceId: options.clientInstanceId,
        fileId: attachment.fileId
      });
      const mimeType = object.mimeType ?? attachment.mimeType ?? attachment.modelVisibility.mimeType;
      if (!isSupportedImageMimeType(mimeType) || mimeType !== attachment.modelVisibility.mimeType) {
        continue;
      }
      images.push({
        type: "image",
        mimeType,
        data: object.bytes
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "model_context_projection.file_unavailable",
          fileId: attachment.fileId,
          error: error instanceof Error ? error.message : "Unknown file read error"
        })
      );
    }
  }
  return images;
}

function readModelVisibility(value: JsonValue | undefined): AttachmentManifestEntry["modelVisibility"] | undefined {
  if (!isJsonObject(value) || value.type !== "image") {
    return undefined;
  }
  const mimeType = typeof value.mimeType === "string" ? value.mimeType : undefined;
  if (!mimeType || !isSupportedImageMimeType(mimeType)) {
    return undefined;
  }
  return {
    type: "image",
    mimeType
  };
}

function readAttachmentModelContext(value: JsonValue | undefined): AttachmentManifestEntry["modelContext"] | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const section = typeof value.section === "string" ? value.section.trim() : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  return section && text ? { section, text } : undefined;
}

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
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
