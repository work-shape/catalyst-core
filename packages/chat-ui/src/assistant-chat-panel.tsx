import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useComposer,
  useComposerRuntime,
} from "@assistant-ui/react";
import {
  AssistantChatTransport,
  RESUMABLE_STREAM_ID_HEADER,
  useChatRuntime,
  type UseChatRuntimeOptions
} from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import type { ApiClient, Conversation, DraftAttachment, LocaleCode, Message, SafeConfig } from "@vivd-catalyst/api-client";
import {
  createMessageSnapshotKey,
  toAiSdkMessageRepository,
  toAttachmentFilePart,
  toUiMessages,
  type AssistantUiActiveRun
} from "./assistant-ui-adapter";
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
  activeRun,
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
  onStreamError,
  onCancelRun
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
  activeRun?: AssistantUiActiveRun;
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
  onChatRequestAccepted: (conversationId: string, runId?: string) => void;
  onStreamFinished: (conversationId: string, viewed: boolean) => void;
  onStreamError: (conversationId: string, message: string, viewed: boolean) => void;
  onCancelRun: () => void;
}) {
  const initialMessages = useMemo(() => toUiMessages(messages ?? [], activeRun), [activeRun, messages]);
  const messageSnapshotKey = useMemo(
    () => createMessageSnapshotKey(messages ?? [], activeRun),
    [activeRun, messages]
  );
  const runtimeKey = selectedConversationId ?? "new";

  return (
    <AssistantRuntimePane
      key={runtimeKey}
      apiBaseUrl={apiBaseUrl}
      client={client}
      config={config}
      selectedConversationId={selectedConversationId}
      initialMessages={initialMessages}
      messageSnapshotKey={messageSnapshotKey}
      messagesLoaded={messagesLoaded}
      notice={notice}
      draft={draft}
      composerFocusRequestId={composerFocusRequestId}
      locale={locale}
      selectedAgentName={selectedAgentName}
      draftAttachments={draftAttachments}
      localUploadingAttachments={localUploadingAttachments}
      conversationRunning={conversationRunning}
      onCancelRun={onCancelRun}
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
  messageSnapshotKey,
  messagesLoaded,
  notice,
  draft,
  composerFocusRequestId,
  locale,
  selectedAgentName,
  draftAttachments,
  localUploadingAttachments,
  conversationRunning,
  onCancelRun,
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
  messageSnapshotKey: string;
  messagesLoaded: boolean;
  notice: string | undefined;
  draft: string;
  composerFocusRequestId: number;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  conversationRunning: boolean;
  onCancelRun: () => void;
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
  onChatRequestAccepted: (conversationId: string, runId?: string) => void;
  onStreamFinished: (conversationId: string, viewed: boolean) => void;
  onStreamError: (conversationId: string, message: string, viewed: boolean) => void;
}) {
  const { t } = useTranslation();
  const importedTargetRef = useRef<string | undefined>(undefined);
  const importedSnapshotRef = useRef<string | undefined>(undefined);
  const clearedTargetRef = useRef<string | undefined>(undefined);
  const localStreamConversationIdRef = useRef<string | undefined>(undefined);
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
          const runId = response.headers.get(RESUMABLE_STREAM_ID_HEADER) ?? undefined;
          titleRequestConversationIdRef.current = undefined;
          if (response.ok && conversationId) {
            onChatRequestAccepted(conversationId, runId);
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
          localStreamConversationIdRef.current = conversationId;
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
    onConversationStarted(conversationId);
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
      if (localStreamConversationIdRef.current === conversationId) {
        localStreamConversationIdRef.current = undefined;
      }
      if (conversationId) {
        onStreamFinished(conversationId, viewed);
      }
    },
    async onError(error) {
      const conversationId = currentRunConversationId();
      const viewed = activeRef.current;
      setOptimisticPendingIfActive(false);
      await selectPendingConversation();
      if (localStreamConversationIdRef.current === conversationId) {
        localStreamConversationIdRef.current = undefined;
      }
      if (!conversationId || isAbortLikeError(error)) {
        return;
      }
      onStreamError(conversationId, error.message, viewed);
    }
  });

  useLayoutEffect(() => {
    const targetKey = selectedConversationId ?? "new";

    if (!selectedConversationId) {
      if (importedTargetRef.current !== targetKey || importedSnapshotRef.current !== messageSnapshotKey) {
        runtime.thread.importExternalState(toAiSdkMessageRepository([]));
        importedTargetRef.current = targetKey;
        importedSnapshotRef.current = messageSnapshotKey;
        clearedTargetRef.current = undefined;
      }
      return;
    }

    if (localStreamConversationIdRef.current === selectedConversationId) {
      return;
    }

    if (streamedConversationIdRef.current === selectedConversationId) {
      streamedConversationIdRef.current = undefined;
      importedTargetRef.current = targetKey;
      importedSnapshotRef.current = messageSnapshotKey;
      clearedTargetRef.current = undefined;
      return;
    }

    if (!messagesLoaded) {
      if (clearedTargetRef.current !== targetKey) {
        runtime.thread.importExternalState(toAiSdkMessageRepository([]));
        clearedTargetRef.current = targetKey;
        importedSnapshotRef.current = undefined;
      }
      return;
    }

    if (importedTargetRef.current === targetKey && importedSnapshotRef.current === messageSnapshotKey) {
      return;
    }

    runtime.thread.importExternalState(toAiSdkMessageRepository(initialMessages));
    importedTargetRef.current = targetKey;
    importedSnapshotRef.current = messageSnapshotKey;
    clearedTargetRef.current = undefined;
  }, [initialMessages, messageSnapshotKey, messagesLoaded, runtime, selectedConversationId]);

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
            onCancelRun={onCancelRun}
            onFilesSelected={onFilesSelected}
            onRemoveDraftAttachment={onRemoveDraftAttachment}
            onRetryDraftAttachment={onRetryDraftAttachment}
          />
        </AttachmentContentProvider>
      </AssistantToolRegistry>
    </AssistantRuntimeProvider>
  );
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
