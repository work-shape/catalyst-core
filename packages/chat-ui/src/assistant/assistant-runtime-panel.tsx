import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  toAttachmentFilePart,
  toUiMessages
} from "../assistant-ui-adapter";
import { AssistantThread } from "../assistant-thread";
import { AttachmentContentProvider } from "../attachment-content";
import { AssistantToolRegistry } from "../assistant-tool-registry";
import { useTranslation } from "../i18n";
import {
  createRunIdempotencyKey,
  ProductConversationRunTransport,
  startProductConversationRun
} from "./product-run-transport";

export function AssistantRuntimePanel({ chat }: { chat: SelectedChatModel }) {
  const { activeRun, messages, selectedConversationId } = chat;
  const initialMessages = useMemo(() => toUiMessages(messages ?? [], activeRun), [activeRun, messages]);
  const messageSnapshotKey = useMemo(
    () => createMessageSnapshotKey(messages ?? [], activeRun),
    [activeRun, messages]
  );
  const runtimeKey = `${selectedConversationId ?? "new"}:${messageSnapshotKey}`;

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
    messageSubmitted: onMessageSubmitted,
    runStarted: onRunStarted,
    streamFinished: onStreamFinished,
    streamError: onStreamError,
    cancelSelectedRun: onCancelRun
  } = chat;
  const { t } = useTranslation();
  const activeRef = useRef(true);
  const rootSubmitPendingRef = useRef(false);
  const [optimisticPending, setOptimisticPending] = useState(false);
  const [rootSubmitPending, setRootSubmitPending] = useState(false);
  const [rootSubmitError, setRootSubmitError] = useState<string | undefined>(undefined);
  const baseSendDisabledReason = sendBlockedReason ?? (!messagesLoaded ? t("loadingConversation") : undefined);
  const sendDisabledReason = rootSubmitPending ? t("loadingConversation") : baseSendDisabledReason;
  const visibleNotice = rootSubmitError ?? notice;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const setOptimisticPendingIfActive = useCallback((pending: boolean) => {
    if (activeRef.current) {
      setOptimisticPending(pending);
    }
  }, []);

  const setRootSubmitPendingIfActive = useCallback((pending: boolean) => {
    rootSubmitPendingRef.current = pending;
    if (activeRef.current) {
      setRootSubmitPending(pending);
    }
  }, []);

  const submitRootDraftMessage = useCallback(
    (text: string): boolean => {
      if (selectedConversationId) {
        return false;
      }

      const trimmedText = text.trim();
      if (!trimmedText || rootSubmitPendingRef.current || baseSendDisabledReason) {
        return true;
      }

      setRootSubmitPendingIfActive(true);
      setRootSubmitError(undefined);
      void startProductConversationRun({
        agentName: selectedAgentName,
        client,
        conversationId: undefined,
        idempotencyKey: createRunIdempotencyKey(),
        locale,
        text: trimmedText
      })
        .then((response) => {
          if (!activeRef.current) {
            return;
          }
          onMessageSubmitted(response.conversation.id);
          onRunStarted(response);
        })
        .catch((error: unknown) => {
          if (!activeRef.current) {
            return;
          }
          setRootSubmitError(error instanceof Error ? error.message : "Message send failed");
        })
        .finally(() => {
          setRootSubmitPendingIfActive(false);
        });

      return true;
    },
    [
      baseSendDisabledReason,
      client,
      locale,
      onMessageSubmitted,
      onRunStarted,
      selectedAgentName,
      selectedConversationId,
      setRootSubmitPendingIfActive
    ]
  );

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
      if (message.role === "user" && selectedConversationId && !sendDisabledReason) {
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
    [attachmentFileParts, selectedConversationId, sendDisabledReason, setOptimisticPendingIfActive]
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
        onRunStarted
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

  const runtime = useChatRuntime({
    messages: initialMessages,
    transport,
    isSendDisabled: Boolean(sendDisabledReason) || !selectedConversationId,
    toCreateMessage: toCreateMessageWithAttachments,
    onFinish() {
      setOptimisticPendingIfActive(false);
      if (selectedConversationId) {
        onStreamFinished(selectedConversationId);
      }
    },
    onError(error) {
      const viewed = activeRef.current;
      setOptimisticPendingIfActive(false);
      if (!selectedConversationId || isAbortLikeError(error)) {
        return;
      }
      onStreamError(selectedConversationId, error.message, viewed);
    }
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AssistantToolRegistry>
        <DraftBridge draftKey={selectedConversationId ?? "new"} draft={draft} onDraftChange={onDraftChange} />
        <AttachmentContentProvider client={client} selectedConversationId={selectedConversationId}>
          <AssistantThread
            config={config}
            selectedAgentName={selectedAgentName}
            notice={visibleNotice}
            draftAttachments={draftAttachments}
            localUploadingAttachments={localUploadingAttachments}
            sendBlockedReason={sendDisabledReason}
            attachmentsEnabled={attachmentsEnabled}
            attachmentAccept={attachmentAccept}
            conversationRunning={conversationRunning}
            optimisticPending={optimisticPending}
            messagesEnabled={Boolean(selectedConversationId)}
            messageRenderKey={messageSnapshotKey}
            composerFocusRequestId={composerFocusRequestId}
            onCancelRun={onCancelRun}
            onFilesSelected={onFilesSelected}
            onRemoveDraftAttachment={onRemoveDraftAttachment}
            onRetryDraftAttachment={onRetryDraftAttachment}
            onSubmitMessage={selectedConversationId ? undefined : submitRootDraftMessage}
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
