import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useComposer,
  useComposerRuntime,
} from "@assistant-ui/react";
import { useChatRuntime, type UseChatRuntimeOptions } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import type { SelectedChatModel } from "../workspace/workspace-chat-model";
import {
  createMessageSnapshotKey,
  toAiSdkMessageRepository,
  toAttachmentFilePart,
  toUiMessages
} from "../assistant-ui-adapter";
import { AssistantThread } from "../assistant-thread";
import { AttachmentContentProvider } from "../attachment-content";
import { AssistantToolRegistry } from "../assistant-tool-registry";
import { useTranslation } from "../i18n";
import { ProductConversationRunTransport } from "./product-run-transport";

export function AssistantRuntimePanel({ chat }: { chat: SelectedChatModel }) {
  const { activeRun, messages, selectedConversationId } = chat;
  const initialMessages = useMemo(() => toUiMessages(messages ?? [], activeRun), [activeRun, messages]);
  const messageSnapshotKey = useMemo(
    () => createMessageSnapshotKey(messages ?? [], activeRun),
    [activeRun, messages]
  );
  const runtimeKey = selectedConversationId ?? "new";

  return (
    <AssistantRuntimePane
      key={runtimeKey}
      chat={chat}
      initialMessages={initialMessages}
      messageSnapshotKey={messageSnapshotKey}
    />
  );
}

function AssistantRuntimePane({
  chat,
  initialMessages,
  messageSnapshotKey
}: {
  chat: SelectedChatModel;
  initialMessages: UIMessage[];
  messageSnapshotKey: string;
}) {
  const {
    client,
    config,
    selectedConversationId,
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
    changeDraft: onDraftChange,
    selectFiles: onFilesSelected,
    removeDraftAttachment: onRemoveDraftAttachment,
    retryDraftAttachment: onRetryDraftAttachment,
    conversationStarted: onConversationStarted,
    messageSubmitted: onMessageSubmitted,
    runStarted: onRunStarted,
    streamFinished: onStreamFinished,
    streamError: onStreamError,
    cancelSelectedRun: onCancelRun
  } = chat;
  const { t } = useTranslation();
  const importedTargetRef = useRef<string | undefined>(undefined);
  const importedSnapshotRef = useRef<string | undefined>(undefined);
  const clearedTargetRef = useRef<string | undefined>(undefined);
  const pendingConversationIdRef = useRef<string | undefined>(undefined);
  const streamedConversationIdRef = useRef<string | undefined>(undefined);
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
      new ProductConversationRunTransport({
        client,
        selectedConversationId,
        locale,
        selectedAgentName,
        isSendDisabled: () => sendDisabledReason,
        onMessageSubmitted,
        onRunStarted: (response) => {
          if (!selectedConversationId) {
            pendingConversationIdRef.current = response.conversation.id;
          }
          onRunStarted(response);
        }
      }),
    [
      client,
      locale,
      onMessageSubmitted,
      onRunStarted,
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
      setOptimisticPendingIfActive(false);
      await selectPendingConversation();
      if (conversationId) {
        onStreamFinished(conversationId);
      }
    },
    async onError(error) {
      const conversationId = currentRunConversationId();
      const viewed = activeRef.current;
      setOptimisticPendingIfActive(false);
      await selectPendingConversation();
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
