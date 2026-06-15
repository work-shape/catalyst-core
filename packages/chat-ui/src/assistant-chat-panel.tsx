import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import {
  AssistantRuntimeProvider,
  useComposer,
  useComposerRuntime,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  useChatRuntime,
  type UseChatRuntimeOptions
} from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import type { ApiClient, DraftAttachment, LocaleCode, Message, SafeConfig } from "@vivd-catalyst/api-client";
import { AssistantThread } from "./assistant-thread";
import type { LocalUploadingAttachment } from "./assistant-composer";
import { firstLineTitle } from "./conversation-title";
import { useTranslation } from "./i18n";

export function AssistantChatPanel({
  apiBaseUrl,
  client,
  config,
  selectedConversationId,
  messages,
  messagesLoaded,
  notice,
  draft,
  locale,
  selectedAgentName,
  draftAttachments,
  localUploadingAttachments,
  sendBlockedReason,
  onDraftChange,
  onFilesSelected,
  onRemoveDraftAttachment,
  onRetryDraftAttachment,
  onConversationStarted,
  onMessageSubmitted,
  onStreamFinished,
  onStreamError
}: {
  apiBaseUrl: string;
  client: ApiClient;
  config: SafeConfig | undefined;
  selectedConversationId: string | undefined;
  messages: Message[] | undefined;
  messagesLoaded: boolean;
  notice: string | undefined;
  draft: string;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  sendBlockedReason?: string;
  onDraftChange: (value: string) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveDraftAttachment: (attachmentId: string) => void;
  onRetryDraftAttachment: (attachmentId: string) => void;
  onConversationStarted: (conversationId: string, messages?: Message[]) => void;
  onMessageSubmitted: (conversationId: string) => void;
  onStreamFinished: () => void;
  onStreamError: (message: string) => void;
}) {
  const initialMessages = useMemo(() => toUiMessages(messages ?? []), [messages]);
  const pendingConversationIdRef = useRef<string | undefined>(undefined);

  return (
    <AssistantRuntimePane
      apiBaseUrl={apiBaseUrl}
      client={client}
      config={config}
      selectedConversationId={selectedConversationId}
      initialMessages={initialMessages}
      messagesLoaded={messagesLoaded}
      pendingConversationIdRef={pendingConversationIdRef}
      notice={notice}
      draft={draft}
      locale={locale}
      selectedAgentName={selectedAgentName}
      draftAttachments={draftAttachments}
      localUploadingAttachments={localUploadingAttachments}
      sendBlockedReason={sendBlockedReason}
      onDraftChange={onDraftChange}
      onFilesSelected={onFilesSelected}
      onRemoveDraftAttachment={onRemoveDraftAttachment}
      onRetryDraftAttachment={onRetryDraftAttachment}
      onConversationStarted={onConversationStarted}
      onMessageSubmitted={onMessageSubmitted}
      onStreamFinished={onStreamFinished}
      onStreamError={onStreamError}
    />
  );
}

function AssistantRuntimePane({
  apiBaseUrl,
  client,
  config,
  selectedConversationId,
  initialMessages,
  messagesLoaded,
  pendingConversationIdRef,
  notice,
  draft,
  locale,
  selectedAgentName,
  draftAttachments,
  localUploadingAttachments,
  sendBlockedReason,
  onDraftChange,
  onFilesSelected,
  onRemoveDraftAttachment,
  onRetryDraftAttachment,
  onConversationStarted,
  onMessageSubmitted,
  onStreamFinished,
  onStreamError
}: {
  apiBaseUrl: string;
  client: ApiClient;
  config: SafeConfig | undefined;
  selectedConversationId: string | undefined;
  initialMessages: UIMessage[];
  messagesLoaded: boolean;
  pendingConversationIdRef: MutableRefObject<string | undefined>;
  notice: string | undefined;
  draft: string;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  sendBlockedReason?: string;
  onDraftChange: (value: string) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveDraftAttachment: (attachmentId: string) => void;
  onRetryDraftAttachment: (attachmentId: string) => void;
  onConversationStarted: (conversationId: string, messages?: Message[]) => void;
  onMessageSubmitted: (conversationId: string) => void;
  onStreamFinished: () => void;
  onStreamError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const importedTargetRef = useRef<string | undefined>(undefined);
  const clearedTargetRef = useRef<string | undefined>(undefined);
  const streamedConversationIdRef = useRef<string | undefined>(undefined);
  const sendDisabledReason = sendBlockedReason ?? (!messagesLoaded ? t("loadingConversation") : undefined);
  const documentFileParts = useMemo(
    () =>
      draftAttachments
        .filter((attachment) => attachment.status === "ready")
        .map(toDocumentFilePart),
    [draftAttachments]
  );
  const toCreateMessageWithDocumentAttachments = useCallback(
    ((message: ComposerAppendMessage) => {
      const parts = toOutgoingUiMessageParts(message);
      if (message.role === "user" && documentFileParts.length > 0) {
        parts.push(...documentFileParts);
      }
      return {
        role: message.role,
        parts,
        metadata: message.metadata
      };
    }) as NonNullable<UseChatRuntimeOptions<UIMessage>["toCreateMessage"]>,
    [documentFileParts]
  );
  const transport = useMemo(
    () =>
      new AssistantChatTransport<UIMessage>({
        api: `${apiBaseUrl.replace(/\/$/u, "")}/api/chat`,
        credentials: "include",
        body: {
          conversationId: selectedConversationId,
          locale,
          agentName: selectedAgentName
        },
        prepareSendMessagesRequest: async (options) => {
          if (sendDisabledReason) {
            throw new Error(sendDisabledReason);
          }
          const text = extractLastUserText(options.messages);
          let conversationId = selectedConversationId;
          if (!conversationId) {
            const conversation = await client.createConversation({
              title: firstLineTitle(text),
              locale
            });
            conversationId = conversation.id;
            pendingConversationIdRef.current = conversation.id;
          }
          onMessageSubmitted(conversationId);

          return {
            credentials: "include",
            body: {
              ...options.body,
              conversationId,
              locale,
              agentName: selectedAgentName,
              messages: options.messages
            }
          };
        }
      }),
    [
      apiBaseUrl,
      client,
      locale,
      onMessageSubmitted,
      pendingConversationIdRef,
      selectedAgentName,
      selectedConversationId,
      sendDisabledReason
    ]
  );
  async function selectPendingConversation(): Promise<void> {
    const conversationId = pendingConversationIdRef.current;
    if (!conversationId) {
      return;
    }
    pendingConversationIdRef.current = undefined;
    streamedConversationIdRef.current = conversationId;
    const persistedMessages = await client.messages(conversationId).catch(() => undefined);
    onConversationStarted(conversationId, persistedMessages);
  }

  const runtime = useChatRuntime({
    messages: initialMessages,
    transport,
    isSendDisabled: Boolean(sendDisabledReason),
    toCreateMessage: toCreateMessageWithDocumentAttachments,
    async onFinish() {
      await selectPendingConversation();
      onStreamFinished();
    },
    async onError(error) {
      await selectPendingConversation();
      onStreamError(error.message);
    }
  });

  useLayoutEffect(() => {
    const targetKey = selectedConversationId ?? "new";
    if (importedTargetRef.current === targetKey) {
      return;
    }

    if (!selectedConversationId) {
      runtime.thread.importExternalState(toAiSdkMessageRepository([]));
      importedTargetRef.current = targetKey;
      clearedTargetRef.current = undefined;
      return;
    }

    if (streamedConversationIdRef.current === selectedConversationId) {
      streamedConversationIdRef.current = undefined;
      importedTargetRef.current = targetKey;
      clearedTargetRef.current = undefined;
      return;
    }

    if (!messagesLoaded) {
      if (clearedTargetRef.current !== targetKey) {
        runtime.thread.importExternalState(toAiSdkMessageRepository([]));
        clearedTargetRef.current = targetKey;
      }
      return;
    }

    runtime.thread.importExternalState(toAiSdkMessageRepository(initialMessages));
    importedTargetRef.current = targetKey;
    clearedTargetRef.current = undefined;
  }, [initialMessages, messagesLoaded, runtime, selectedConversationId]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DraftBridge draftKey={selectedConversationId ?? "new"} draft={draft} onDraftChange={onDraftChange} />
      <AssistantThread
        config={config}
        selectedAgentName={selectedAgentName}
        notice={notice}
        draftAttachments={draftAttachments}
        localUploadingAttachments={localUploadingAttachments}
        sendBlockedReason={sendDisabledReason}
        onFilesSelected={onFilesSelected}
        onRemoveDraftAttachment={onRemoveDraftAttachment}
        onRetryDraftAttachment={onRetryDraftAttachment}
      />
    </AssistantRuntimeProvider>
  );
}

interface AiSdkMessageFormatRepository {
  headId: string | null;
  messages: Array<{
    parentId: string | null;
    message: UIMessage;
  }>;
}

function toAiSdkMessageRepository(messages: UIMessage[]): AiSdkMessageFormatRepository {
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

function DraftBridge({
  draftKey,
  draft,
  onDraftChange
}: {
  draftKey: string;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const composer = useComposerRuntime();
  const currentText = useComposer((state) => state.text);
  const restoredDraftKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (restoredDraftKeyRef.current === draftKey) {
      return;
    }
    restoredDraftKeyRef.current = draftKey;
    composer.setText(draft);
  }, [composer, draft, draftKey]);

  useEffect(() => {
    if (currentText !== draft) {
      onDraftChange(currentText);
    }
  }, [currentText, draft, onDraftChange]);

  return null;
}

type ComposerAppendMessage = Parameters<NonNullable<UseChatRuntimeOptions<UIMessage>["toCreateMessage"]>>[0];

function toOutgoingUiMessageParts(message: ComposerAppendMessage): UIMessage["parts"] {
  const parts: UIMessage["parts"] = [];
  const contentParts = [
    ...message.content.filter((part) => part.type !== "file"),
    ...(message.attachments?.flatMap((attachment) =>
      attachment.content.map((content) => ({
        ...content,
        filename: attachment.name
      }))
    ) ?? [])
  ];

  for (const part of contentParts) {
    appendOutgoingUiMessagePart(parts, part);
  }
  return parts;
}

function appendOutgoingUiMessagePart(
  parts: UIMessage["parts"],
  part: {
    type: string;
    text?: string;
    image?: string;
    data?: unknown;
    mimeType?: string;
    filename?: string;
    name?: string;
  }
): void {
  if (part.type === "text") {
    parts.push({
      type: "text",
      text: part.text ?? ""
    });
    return;
  }

  if (part.type === "image") {
    parts.push({
      type: "file",
      url: part.image ?? "",
      mediaType: "image/png",
      ...(part.filename ? { filename: part.filename } : {})
    });
    return;
  }

  if (part.type === "file") {
    parts.push({
      type: "file",
      url: typeof part.data === "string" ? part.data : "",
      mediaType: part.mimeType ?? "application/octet-stream",
      ...(part.filename ? { filename: part.filename } : {})
    });
    return;
  }

  if (part.type === "data" && part.name) {
    parts.push({
      type: `data-${part.name}`,
      data: part.data
    } as UIMessage["parts"][number]);
  }
}

export function toUiMessages(messages: Message[]): UIMessage[] {
  const toolResultsByToolCallId = new Map<string, PersistedToolResult>();
  for (const message of messages) {
    const toolResult = readPersistedToolResult(message);
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
    parts.push(...readUserDocumentFileParts(message));
  }

  const toolCalls = readAssistantToolCalls(message);
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

function readUserDocumentFileParts(message: Message): UIMessage["parts"] {
  const runtime = readAgentRuntimeMetadata(message.metadata);
  if (runtime?.kind !== "user_message") {
    return [];
  }
  const manifest = isRecord(runtime.attachmentManifest) ? runtime.attachmentManifest : undefined;
  if (manifest?.version !== 1 || !Array.isArray(manifest.attachments)) {
    return [];
  }
  return manifest.attachments.flatMap((value): UIMessage["parts"] => {
    if (!isRecord(value)) {
      return [];
    }
    const fileId = typeof value.fileId === "string" ? value.fileId : undefined;
    const filename = typeof value.filename === "string" ? value.filename : undefined;
    if (!fileId || !filename) {
      return [];
    }
    const mimeType = typeof value.mimeType === "string" ? value.mimeType : undefined;
    return [
      toDocumentFilePart({
        fileId,
        filename,
        ...(mimeType ? { mimeType } : {})
      })
    ];
  });
}

function toDocumentFilePart(
  attachment: Pick<DraftAttachment, "fileId" | "filename" | "mimeType">
): UIMessage["parts"][number] {
  return {
    type: "file",
    mediaType: attachment.mimeType ?? "application/octet-stream",
    filename: attachment.filename,
    url: `vivd-document://${encodeURIComponent(attachment.fileId)}`
  };
}

interface PersistedToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

type PersistedToolResult =
  | {
      status: "success";
      toolCallId: string;
      output: unknown;
    }
  | {
      status: "failed";
      toolCallId: string;
      errorText: string;
    };

function readAssistantToolCalls(message: Message): PersistedToolCall[] {
  if (message.role !== "assistant") {
    return [];
  }
  const runtime = readAgentRuntimeMetadata(message.metadata);
  if (runtime?.kind !== "assistant_tool_calls" || !Array.isArray(runtime.toolCalls)) {
    return [];
  }
  return runtime.toolCalls.flatMap((value): PersistedToolCall[] => {
    if (!isRecord(value)) {
      return [];
    }
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    const toolName = typeof value.toolName === "string" ? value.toolName : undefined;
    if (!toolCallId || !toolName) {
      return [];
    }
    return [
      {
        toolCallId,
        toolName,
        input: value.input
      }
    ];
  });
}

function readPersistedToolResult(message: Message): PersistedToolResult | undefined {
  if (message.role !== "tool") {
    return undefined;
  }
  const runtime = readAgentRuntimeMetadata(message.metadata);
  if (runtime?.kind !== "tool_result" || typeof runtime.toolCallId !== "string") {
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
      errorText: typeof result.error.message === "string" ? result.error.message : "Tool call failed"
    };
  }
  return undefined;
}

function readAgentRuntimeMetadata(metadata: Message["metadata"]): Record<string, unknown> | undefined {
  const runtime = isRecord(metadata?.agentRuntime) ? metadata.agentRuntime : undefined;
  return runtime?.version === 1 ? runtime : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractLastUserText(messages: UIMessage[]): string {
  const userMessage = messages.findLast((message) => message.role === "user");
  return (
    userMessage?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim() ?? ""
  );
}
