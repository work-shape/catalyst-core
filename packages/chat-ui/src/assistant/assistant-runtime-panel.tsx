import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  useComposer,
  useComposerRuntime,
} from "@assistant-ui/react";
import { useChatRuntime, type UseChatRuntimeOptions } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import type { SelectedChatModel } from "../workspace/workspace-chat-model";
import type { LocaleCode } from "@vivd-catalyst/core";
import {
  createMessageSnapshotKey,
  toAiSdkMessageRepository,
  toAttachmentFilePart,
  toUiMessages,
  type AssistantUiActiveRun
} from "../assistant-ui-adapter";
import { createToolSurfacePanelEntry } from "../tool-surface-card";
import { useToolDisplayPanel } from "../tool-display-panel";
import { dedupeToolSurfaceRefs, readToolSurfaceRefs } from "../tool-surfaces";
import { AssistantThread } from "../assistant-thread";
import { AssistantToolRegistry } from "../assistant-tool-registry";
import { useRegisterToolDisplayActions } from "../domain-ui-widgets";
import { useTranslation } from "../i18n";
import { useOpenSourceFilePreview } from "../source-file-preview";
import {
  createRunIdempotencyKey,
  ProductConversationRunTransport,
  startProductConversationRun
} from "./product-run-transport";

export function AssistantRuntimePanel({ chat }: { chat: SelectedChatModel }) {
  const { activeRun, completedRunProjections, messages, selectedConversationId } = chat;
  const initialMessages = useMemo(
    () => toUiMessages(messages ?? [], activeRun, completedRunProjections),
    [activeRun, completedRunProjections, messages]
  );
  const messageSnapshotKey = useMemo(
    () => createMessageSnapshotKey(messages ?? [], activeRun, completedRunProjections),
    [activeRun, completedRunProjections, messages]
  );
  const runtimeKey = selectedConversationId ?? "new";

  return (
    <AssistantRuntimePane
      key={runtimeKey}
      chat={chat}
      initialMessages={initialMessages}
      messagesSyncKey={messageSnapshotKey}
    />
  );
}

function AssistantRuntimePane({
  chat,
  initialMessages,
  messagesSyncKey
}: {
  chat: SelectedChatModel;
  initialMessages: UIMessage[];
  messagesSyncKey: string;
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
    selectedModelBindingId,
    showContextIndicator,
    contextSnapshot,
    selectModelBindingId,
    draftAttachments,
    localUploadingAttachments,
    conversationRunning,
    activeRun,
    sendBlockedReason,
    attachmentsEnabled,
    attachmentAccept,
    changeDraft: onDraftChange,
    selectFiles: onFilesSelected,
    removeDraftAttachment: onRemoveDraftAttachment,
    retryDraftAttachment: onRetryDraftAttachment,
    messageSubmitted: onMessageSubmitted,
    runStarted: onRunStarted,
    streamError: onStreamError,
    cancelSelectedRun: onCancelRun
  } = chat;
  const { t } = useTranslation();
  const activeRef = useRef(true);
  const rootSubmitPendingRef = useRef(false);
  const [optimisticPending, setOptimisticPending] = useState(false);
  const [rootSubmitPending, setRootSubmitPending] = useState(false);
  const [rootSubmitError, setRootSubmitError] = useState<string | undefined>(undefined);
  const baseSendDisabledReason = conversationRunning
    ? t("conversationStillRunning")
    : sendBlockedReason ?? (!messagesLoaded ? t("loadingConversation") : undefined);
  const sendDisabledReason = rootSubmitPending ? t("loadingConversation") : baseSendDisabledReason;
  const visibleNotice = rootSubmitError ?? notice;
  useAutoOpenCompletedRunSurface(activeRun, locale);

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
        modelBindingId: selectedModelBindingId,
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
      selectedModelBindingId,
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
        selectedModelBindingId,
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
      selectedModelBindingId,
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

  const openSourceFilePreview = useOpenSourceFilePreview();
  const canSend = !sendDisabledReason;
  useRegisterToolDisplayActions(
    useMemo(
      () =>
        selectedConversationId
          ? {
              // `thread.append` bypasses `isSendDisabled` and would only fail in
              // the transport, so appending is gated here instead.
              ...(canSend
                ? {
                    sendMessage(text: string) {
                      runtime.thread.append(text);
                    }
                  }
                : {}),
              openSourceFile(input: { fileId: string; filename?: string }) {
                void openSourceFilePreview({
                  client,
                  conversationId: selectedConversationId,
                  ...input
                });
              }
            }
          : undefined,
      [canSend, client, openSourceFilePreview, runtime, selectedConversationId]
    )
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RuntimeMessagesBridge
        runtime={runtime}
        messages={initialMessages}
        syncKey={messagesSyncKey}
      />
      <AssistantToolRegistry>
        <DraftBridge draftKey={selectedConversationId ?? "new"} draft={draft} onDraftChange={onDraftChange} />
        <AssistantThread
          config={config}
          selectedAgentName={selectedAgentName}
          selectedModelBindingId={selectedModelBindingId}
          showContextIndicator={showContextIndicator}
          contextSnapshot={contextSnapshot}
          notice={visibleNotice}
          draftAttachments={draftAttachments}
          localUploadingAttachments={localUploadingAttachments}
          sendBlockedReason={sendDisabledReason}
          attachmentsEnabled={attachmentsEnabled}
          attachmentAccept={attachmentAccept}
          conversationRunning={conversationRunning}
          activeRunId={activeRun?.run.id}
          preparingToolName={activeRun?.projection.preparingTool?.toolName}
          optimisticPending={optimisticPending}
          messagesEnabled={Boolean(selectedConversationId)}
          composerFocusRequestId={composerFocusRequestId}
          onCancelRun={onCancelRun}
          onSelectModelBinding={selectModelBindingId}
          onFilesSelected={onFilesSelected}
          onRemoveDraftAttachment={onRemoveDraftAttachment}
          onRetryDraftAttachment={onRetryDraftAttachment}
          onSubmitMessage={selectedConversationId ? undefined : submitRootDraftMessage}
        />
      </AssistantToolRegistry>
    </AssistantRuntimeProvider>
  );
}

/**
 * Opens the side panel once, when a run the user was watching finishes.
 *
 * Deliberately independent of message reconciliation: it does not depend on
 * which message projection is mounted, on card render order, or on the
 * auto-show tracker — all of which were silently swallowing the open.
 */
function useAutoOpenCompletedRunSurface(
  activeRun: AssistantUiActiveRun | undefined,
  locale: LocaleCode
): void {
  const panel = useToolDisplayPanel();
  const { t } = useTranslation();
  const watchedRunIdsRef = useRef(new Set<string>());
  const openedRunIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!activeRun) {
      return;
    }
    const runId = activeRun.run.id;
    const status = activeRun.projection.status;

    if (status !== "completed") {
      // Only runs observed while still going are eligible, so loading a
      // conversation whose last run happens to be finished stays quiet.
      watchedRunIdsRef.current.add(runId);
      return;
    }
    if (!watchedRunIdsRef.current.has(runId) || openedRunIdsRef.current.has(runId)) {
      return;
    }

    const surface = dedupeToolSurfaceRefs(
      activeRun.projection.parts.flatMap((part) =>
        part.type === "tool_call"
          ? readToolSurfaceRefs(part.output, {
              toolCallId: part.toolCallId,
              toolName: part.toolName
            })
          : []
      )
    ).at(-1);
    if (!surface) {
      return;
    }

    const entry = createToolSurfacePanelEntry({
      fallbackTitle: t("displayPanelFallbackTitle"),
      locale,
      surface
    });
    if (!entry) {
      return;
    }
    openedRunIdsRef.current.add(runId);
    panel.show(entry);
  }, [activeRun, locale, panel, t]);
}

function RuntimeMessagesBridge({
  runtime,
  messages,
  syncKey
}: {
  runtime: ReturnType<typeof useChatRuntime>;
  messages: UIMessage[];
  syncKey: string;
}) {
  useEffect(() => {
    runtime.thread.importExternalState(toAiSdkMessageRepository(messages));
  }, [messages, runtime, syncKey]);

  return null;
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
