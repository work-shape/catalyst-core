import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type { ApiClient, Conversation, DraftAttachment, LocaleCode, Message, SafeConfig } from "@vivd-catalyst/api-client";
import { AssistantThread } from "./assistant-thread";
import type { LocalUploadingAttachment } from "./assistant-composer";
import { AttachmentContentProvider } from "./attachment-content";
import { AssistantToolRegistry } from "./assistant-tool-registry";
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
  composerFocusRequestId,
  locale,
  selectedAgentName,
  draftAttachments,
  localUploadingAttachments,
  conversationRunning,
  sendBlockedReason,
  attachmentsEnabled,
  attachmentAccept,
  onDraftChange,
  onFilesSelected,
  onRemoveDraftAttachment,
  onRetryDraftAttachment,
  onConversationCreated,
  onConversationStarted,
  onMessageSubmitted,
  onChatRequestAccepted,
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
  composerFocusRequestId: number;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  conversationRunning: boolean;
  sendBlockedReason?: string;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
  onDraftChange: (value: string) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveDraftAttachment: (attachmentId: string) => void;
  onRetryDraftAttachment: (attachmentId: string) => void;
  onConversationCreated: (conversation: Conversation) => void;
  onConversationStarted: (conversationId: string, messages?: Message[]) => void;
  onMessageSubmitted: (conversationId: string) => void;
  onChatRequestAccepted: (conversationId: string) => void;
  onStreamFinished: (conversationId: string, viewed: boolean) => void;
  onStreamError: (conversationId: string, message: string, viewed: boolean) => void;
}) {
  const initialMessages = useMemo(() => toUiMessages(messages ?? []), [messages]);
  const runtimeKey = selectedConversationId ?? "new";

  return (
    <AssistantRuntimePane
      key={runtimeKey}
      apiBaseUrl={apiBaseUrl}
      client={client}
      config={config}
      selectedConversationId={selectedConversationId}
      initialMessages={initialMessages}
      messagesLoaded={messagesLoaded}
      notice={notice}
      draft={draft}
      composerFocusRequestId={composerFocusRequestId}
      locale={locale}
      selectedAgentName={selectedAgentName}
      draftAttachments={draftAttachments}
      localUploadingAttachments={localUploadingAttachments}
      conversationRunning={conversationRunning}
      sendBlockedReason={sendBlockedReason}
      attachmentsEnabled={attachmentsEnabled}
      attachmentAccept={attachmentAccept}
      onDraftChange={onDraftChange}
      onFilesSelected={onFilesSelected}
      onRemoveDraftAttachment={onRemoveDraftAttachment}
      onRetryDraftAttachment={onRetryDraftAttachment}
      onConversationCreated={onConversationCreated}
      onConversationStarted={onConversationStarted}
      onMessageSubmitted={onMessageSubmitted}
      onChatRequestAccepted={onChatRequestAccepted}
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
  notice,
  draft,
  composerFocusRequestId,
  locale,
  selectedAgentName,
  draftAttachments,
  localUploadingAttachments,
  conversationRunning,
  sendBlockedReason,
  attachmentsEnabled,
  attachmentAccept,
  onDraftChange,
  onFilesSelected,
  onRemoveDraftAttachment,
  onRetryDraftAttachment,
  onConversationCreated,
  onConversationStarted,
  onMessageSubmitted,
  onChatRequestAccepted,
  onStreamFinished,
  onStreamError
}: {
  apiBaseUrl: string;
  client: ApiClient;
  config: SafeConfig | undefined;
  selectedConversationId: string | undefined;
  initialMessages: UIMessage[];
  messagesLoaded: boolean;
  notice: string | undefined;
  draft: string;
  composerFocusRequestId: number;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  conversationRunning: boolean;
  sendBlockedReason?: string;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
  onDraftChange: (value: string) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveDraftAttachment: (attachmentId: string) => void;
  onRetryDraftAttachment: (attachmentId: string) => void;
  onConversationCreated: (conversation: Conversation) => void;
  onConversationStarted: (conversationId: string, messages?: Message[]) => void;
  onMessageSubmitted: (conversationId: string) => void;
  onChatRequestAccepted: (conversationId: string) => void;
  onStreamFinished: (conversationId: string, viewed: boolean) => void;
  onStreamError: (conversationId: string, message: string, viewed: boolean) => void;
}) {
  const { t } = useTranslation();
  const importedTargetRef = useRef<string | undefined>(undefined);
  const clearedTargetRef = useRef<string | undefined>(undefined);
  const pendingConversationIdRef = useRef<string | undefined>(undefined);
  const streamedConversationIdRef = useRef<string | undefined>(undefined);
  const titleRequestConversationIdRef = useRef<string | undefined>(undefined);
  const activeRef = useRef(true);
  const [optimisticPending, setOptimisticPending] = useState(false);
  const sendDisabledReason = sendBlockedReason ?? (!messagesLoaded ? t("loadingConversation") : undefined);

  useEffect(() => {
    return () => {
      activeRef.current = false;
    };
  }, []);

  const setOptimisticPendingIfActive = useCallback((pending: boolean) => {
    if (activeRef.current) {
      setOptimisticPending(pending);
    }
  }, []);

  const attachmentFileParts = useMemo(
    () =>
      draftAttachments
        .filter((attachment) => attachment.status === "ready")
        .map(toAttachmentFilePart),
    [draftAttachments]
  );
  const toCreateMessageWithAttachments = useCallback(
    ((message: ComposerAppendMessage) => {
      const parts = toOutgoingUiMessageParts(message);
      if (message.role === "user" && !sendDisabledReason) {
        setOptimisticPendingIfActive(true);
      }
      if (message.role === "user" && attachmentFileParts.length > 0) {
        parts.push(...attachmentFileParts);
      }
      return {
        role: message.role,
        parts,
        metadata: message.metadata
      };
    }) as NonNullable<UseChatRuntimeOptions<UIMessage>["toCreateMessage"]>,
    [attachmentFileParts, sendDisabledReason, setOptimisticPendingIfActive]
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
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          const conversationId = titleRequestConversationIdRef.current;
          titleRequestConversationIdRef.current = undefined;
          if (response.ok && conversationId) {
            onChatRequestAccepted(conversationId);
          }
          return response;
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
            onConversationCreated(conversation);
          }
          onMessageSubmitted(conversationId);
          titleRequestConversationIdRef.current = conversationId;

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
      onConversationCreated,
      onMessageSubmitted,
      onChatRequestAccepted,
      pendingConversationIdRef,
      selectedAgentName,
      selectedConversationId,
      sendDisabledReason,
      setOptimisticPendingIfActive
    ]
  );
  async function selectPendingConversation(): Promise<void> {
    const conversationId = pendingConversationIdRef.current;
    if (!conversationId) {
      return;
    }
    pendingConversationIdRef.current = undefined;
    streamedConversationIdRef.current = conversationId;
    if (!activeRef.current) {
      return;
    }
    const persistedMessages = await client.messages(conversationId).catch(() => undefined);
    if (!activeRef.current) {
      return;
    }
    onConversationStarted(conversationId, persistedMessages);
  }

  function currentRunConversationId(): string | undefined {
    return pendingConversationIdRef.current ?? streamedConversationIdRef.current ?? selectedConversationId;
  }

  const runtime = useChatRuntime({
    messages: initialMessages,
    transport,
    isSendDisabled: Boolean(sendDisabledReason),
    toCreateMessage: toCreateMessageWithAttachments,
    async onFinish() {
      const conversationId = currentRunConversationId();
      const viewed = activeRef.current;
      setOptimisticPendingIfActive(false);
      await selectPendingConversation();
      if (conversationId) {
        onStreamFinished(conversationId, viewed);
      }
    },
    async onError(error) {
      const conversationId = currentRunConversationId();
      const viewed = activeRef.current;
      setOptimisticPendingIfActive(false);
      await selectPendingConversation();
      if (!conversationId || (!activeRef.current && isAbortLikeError(error))) {
        return;
      }
      onStreamError(conversationId, error.message, viewed);
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
      <AssistantToolRegistry>
        <DraftBridge draftKey={selectedConversationId ?? "new"} draft={draft} onDraftChange={onDraftChange} />
        <AttachmentContentProvider client={client} selectedConversationId={selectedConversationId}>
          <AssistantThread
            config={config}
            selectedAgentName={selectedAgentName}
            notice={notice}
            draftAttachments={draftAttachments}
            localUploadingAttachments={localUploadingAttachments}
            sendBlockedReason={sendDisabledReason}
            attachmentsEnabled={attachmentsEnabled}
            attachmentAccept={attachmentAccept}
            conversationRunning={conversationRunning}
            optimisticPending={optimisticPending}
            composerFocusRequestId={composerFocusRequestId}
            onFilesSelected={onFilesSelected}
            onRemoveDraftAttachment={onRemoveDraftAttachment}
            onRetryDraftAttachment={onRetryDraftAttachment}
          />
        </AttachmentContentProvider>
      </AssistantToolRegistry>
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

function isAbortLikeError(error: Error): boolean {
  return error.name === "AbortError" || /abort/u.test(error.message.toLowerCase());
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
    parts.push(...readUserAttachmentFileParts(message));
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

function readUserAttachmentFileParts(message: Message): UIMessage["parts"] {
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
      toAttachmentFilePart({
        fileId,
        filename,
        ...(mimeType ? { mimeType } : {})
      })
    ];
  });
}

function toAttachmentFilePart(
  attachment: Pick<DraftAttachment, "fileId" | "filename" | "mimeType">
): UIMessage["parts"][number] {
  return {
    type: "file",
    mediaType: attachment.mimeType ?? "application/octet-stream",
    filename: attachment.filename,
    url: `vivd-file://${encodeURIComponent(attachment.fileId)}`
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
