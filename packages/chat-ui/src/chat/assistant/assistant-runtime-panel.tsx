import { ToolDecisionsProvider } from "../approvals/tool-decision-context";
import { conversationStart } from "../dock/subject-starters";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AssistantRuntimeProvider, useComposer, useComposerRuntime } from "@assistant-ui/react";
import { useChatRuntime, type UseChatRuntimeOptions } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";
import type { SelectedChatModel } from "../workspace/workspace-chat-model";
import type { LocaleCode } from "@work-shape/catalyst-core";
import {
  createMessageSnapshotKey,
  toAiSdkMessageRepository,
  toAttachmentFilePart,
  toUiMessages,
  type AssistantUiActiveRun
} from "./assistant-ui-adapter";
import { createToolSurfacePanelEntry } from "../tools/tool-surface-card";
import { useToolDisplayPanel } from "../tools/tool-display-panel";
import { dedupeToolSurfaceRefs, readToolSurfaceRefs } from "../tools/tool-surfaces";
import { AssistantThread, type StartComposerPosition } from "./assistant-thread";
import { AssistantToolRegistry } from "./assistant-tool-registry";
import { transcriptMessageTimes } from "./thread-time";
import { useRegisterToolDisplayActions } from "../../shared/domain-ui-widgets";
import { useConversationSubject } from "../conversation/use-conversation-subject";
import { useReportDockSubject } from "../dock/dock-subject";
import { useFollowUpQueueModel } from "../conversation/use-follow-up-queue";
import { FollowUpQueueProvider } from "./follow-up-queue";
import {
  AgentOpensProvider,
  AssetOpenedChip,
  ConversationSubjectLine,
  PrivateBuildOffer
} from "../conversation/conversation-subject";
import { refusedRequest } from "../conversation/subject-run";
import { readCompatibleMessageRunId } from "./assistant-message-compat";
import { useTranslation } from "../../shared/i18n";
import { useAutoOpenPageSurface } from "../../studio/pages/page-card";
import { useOpenConversationFile } from "../files/conversation-file-presentation";
import {
  createRunIdempotencyKey,
  ProductConversationRunTransport,
  startProductConversationRun
} from "./product-run-transport";
import {
  draftAttachmentsKey,
  resolveSendBlock,
  visibleSendRefusal,
  type QueuedSend,
  type SendRefusal
} from "./send-block";
import { QueuedSendBridge } from "./queued-send-bridge";

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
  // Outlives the keyed pane so the composer can settle from its start page position.
  const startComposerRef = useRef<StartComposerPosition | undefined>(undefined);

  return (
    <ToolDecisionsProvider parts={activeRun?.projection.parts}>
      <AssistantRuntimePane
        key={runtimeKey}
        chat={chat}
        initialMessages={initialMessages}
        messagesSyncKey={messageSnapshotKey}
        startComposerRef={startComposerRef}
      />
    </ToolDecisionsProvider>
  );
}

function AssistantRuntimePane({
  chat,
  initialMessages,
  messagesSyncKey,
  startComposerRef
}: {
  chat: SelectedChatModel;
  initialMessages: UIMessage[];
  messagesSyncKey: string;
  startComposerRef: RefObject<StartComposerPosition | undefined>;
}) {
  const {
    client,
    config,
    agentsLoading,
    agentsWorkspaceScoped,
    collaborationWorkspaceId,
    newConversationPrivate,
    selectedConversationId,
    selectedConversationRetainedUntil,
    selectedConversationSubject,
    docked,
    dockKind,
    agentOpens,
    openRoute,
    messagesLoaded,
    snapshotStatus,
    notice,
    draft,
    composerFocusRequestId,
    locale,
    selectedAgentName,
    selectableModels,
    selectedModelBindingId,
    selectedReasoningEffort,
    requestedReasoningEffort,
    showContextIndicator,
    contextSnapshot,
    selectAgentName: onSelectAgent,
    selectModelBindingId,
    selectReasoningEffort,
    draftAttachments,
    localUploadingAttachments,
    conversationRunning,
    activeRun,
    sendBlock: workspaceBlock,
    attachmentsEnabled,
    attachmentAccept,
    changeDraft: onDraftChange,
    selectFiles: onFilesSelected,
    sendStagedFiles,
    removeDraftAttachment: onRemoveDraftAttachment,
    retryDraftAttachment: onRetryDraftAttachment,
    messageSubmitted: onMessageSubmitted,
    runStarted: onRunStarted,
    streamError: onStreamError,
    cancelSelectedRun: onCancelRun,
    continuePrivately,
    startsPrivate,
    followUpSource
  } = chat;
  const { t } = useTranslation();
  const messageTimes = useMemo(
    () => transcriptMessageTimes(chat.messages ?? [], chat.activeRun),
    [chat.activeRun, chat.messages]
  );
  const activeRef = useRef(true);
  const rootSubmitPendingRef = useRef(false);
  const [optimisticPending, setOptimisticPending] = useState(false);
  const [rootSubmitPending, setRootSubmitPending] = useState(false);
  const [rootSubmitError, setRootSubmitError] = useState<SendRefusal | undefined>(undefined);
  const noAgentsMessage =
    config && config.agents.length === 0 && !agentsLoading
      ? t(agentsWorkspaceScoped ? "workspaceNoAgents" : "instanceNotConfigured")
      : undefined;
  const sendBlock = useMemo(
    () =>
      resolveSendBlock({
        sending: rootSubmitPending,
        workspaceBlock,
        snapshotStatus,
        noAgentsMessage,
        queueWhileLoading: !docked,
        t
      }),
    [docked, noAgentsMessage, rootSubmitPending, snapshotStatus, t, workspaceBlock]
  );
  const sendDisabledReason = sendBlock?.reason;
  // A message sent while a run goes waits in the queue and never enters the transcript, so the
  // thread runtime, which would show it there at once, sends nothing meanwhile.
  const runtimeSendBlocked = Boolean(sendDisabledReason) || conversationRunning;
  const [queuedSend, setQueuedSend] = useState<QueuedSend | undefined>(undefined);
  const attachmentsKey = useMemo(
    () => draftAttachmentsKey([...localUploadingAttachments, ...draftAttachments]),
    [draftAttachments, localUploadingAttachments]
  );
  const queueSend = useCallback(
    (text: string) => setQueuedSend({ text, collaborationWorkspaceId, attachmentsKey }),
    [attachmentsKey, collaborationWorkspaceId]
  );
  const settleQueuedSend = useCallback(() => setQueuedSend(undefined), []);
  const visibleNotice = visibleSendRefusal(rootSubmitError, attachmentsKey) ?? notice;
  useAutoOpenCompletedRunSurface(activeRun, locale);
  const conversationSubject = useConversationSubject({
    activeRun,
    storedSubject: selectedConversationSubject,
    workspaceId: collaborationWorkspaceId
  });
  useReportDockSubject(conversationSubject);
  const pendingOpen = agentOpens.pending;
  // A build refused because others read this conversation goes on in a private one (E3).
  const privateBuild = usePrivateBuildOffer(chat, followUpSource.currentUserId, continuePrivately);
  useAutoOpenPageSurface(activeRun, selectedConversationId);

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
      if (!trimmedText || rootSubmitPendingRef.current || sendDisabledReason) {
        return true;
      }

      setRootSubmitPendingIfActive(true);
      setRootSubmitError(undefined);
      // Files waiting in the composer go to the conversation made for them as the message is sent.
      void sendStagedFiles()
        .then((conversationId) =>
          startProductConversationRun({
            agentName: selectedAgentName,
            modelBindingId: selectedModelBindingId,
            reasoningEffort: requestedReasoningEffort,
            client,
            collaborationWorkspaceId,
            conversationId,
            idempotencyKey: createRunIdempotencyKey(),
            locale,
            text: trimmedText,
            ...(startsPrivate && !docked ? { visibility: "private" as const } : {})
          })
        )
        .then((response) => {
          if (!activeRef.current) {
            return;
          }
          // The conversation this start page began is the one whose composer settles from it.
          if (startComposerRef.current) {
            startComposerRef.current = {
              ...startComposerRef.current,
              conversationId: response.conversation.id
            };
          }
          onMessageSubmitted(response.conversation.id);
          onRunStarted(response);
        })
        .catch((error: unknown) => {
          if (!activeRef.current) {
            return;
          }
          setRootSubmitError({
            message: error instanceof Error ? error.message : "Message send failed",
            attachmentsKey
          });
        })
        .finally(() => {
          setRootSubmitPendingIfActive(false);
        });

      return true;
    },
    [
      attachmentsKey,
      client,
      collaborationWorkspaceId,
      docked,
      locale,
      onMessageSubmitted,
      onRunStarted,
      requestedReasoningEffort,
      selectedAgentName,
      selectedModelBindingId,
      selectedConversationId,
      sendDisabledReason,
      sendStagedFiles,
      setRootSubmitPendingIfActive,
      startComposerRef,
      startsPrivate
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
  const followUpQueue = useFollowUpQueueModel({
    source: followUpSource,
    client,
    conversationId: selectedConversationId,
    runStatus: activeRun?.run.status,
    agentName: selectedAgentName,
    modelBindingId: selectedModelBindingId,
    reasoningEffort: requestedReasoningEffort,
    locale,
    messageSubmitted: onMessageSubmitted,
    runStarted: onRunStarted,
    t
  });
  const { refreshThread } = followUpSource;
  const transport = useMemo(
    () =>
      new ProductConversationRunTransport({
        client,
        collaborationWorkspaceId,
        selectedConversationId,
        locale,
        selectedAgentName,
        selectedModelBindingId,
        selectedReasoningEffort: requestedReasoningEffort,
        isSendDisabled: () => sendDisabledReason,
        onMessageSubmitted,
        onRunStarted,
        // A run this page did not know of was going: the thread names it and the queue.
        onFollowUpQueued: (followUp) => {
          refreshThread(followUp.conversationId).catch(() => undefined);
        }
      }),
    [
      client,
      collaborationWorkspaceId,
      locale,
      onMessageSubmitted,
      onRunStarted,
      refreshThread,
      requestedReasoningEffort,
      selectedAgentName,
      selectedModelBindingId,
      selectedConversationId,
      sendDisabledReason
    ]
  );

  const runtime = useChatRuntime({
    messages: initialMessages,
    transport,
    isSendDisabled: runtimeSendBlocked || !selectedConversationId,
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

  const openConversationFile = useOpenConversationFile();
  const canSend = !runtimeSendBlocked;
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
                void openConversationFile({
                  client,
                  conversationId: selectedConversationId,
                  ...input
                });
              }
            }
          : undefined,
      [canSend, client, openConversationFile, runtime, selectedConversationId]
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
        <FollowUpQueueProvider value={followUpQueue}>
          <AgentOpensProvider value={agentOpens}>
            <DraftBridge
              draftKey={selectedConversationId ?? "new"}
              draft={draft}
              onDraftChange={onDraftChange}
            />
            <QueuedSendBridge
              queuedSend={queuedSend}
              sendBlock={sendBlock}
              attachmentsKey={attachmentsKey}
              collaborationWorkspaceId={collaborationWorkspaceId}
              onSettled={settleQueuedSend}
              onSubmitMessage={selectedConversationId ? undefined : submitRootDraftMessage}
            />
            <AssistantThread
              config={config}
              agents={config?.agents ?? []}
              noAgentsMessage={noAgentsMessage}
              selectedAgentName={selectedAgentName}
              selectableModels={selectableModels}
              selectedModelBindingId={selectedModelBindingId}
              selectedReasoningEffort={selectedReasoningEffort}
              showContextIndicator={showContextIndicator}
              contextSnapshot={contextSnapshot}
              notice={visibleNotice}
              newConversationPrivate={newConversationPrivate}
              subjectLine={
                conversationSubject === undefined &&
                pendingOpen === undefined &&
                privateBuild === undefined ? undefined : (
                  <>
                    {privateBuild}
                    {pendingOpen === undefined ? null : (
                      <AssetOpenedChip open={pendingOpen} onGoTo={agentOpens.goTo} />
                    )}
                    {/* In the dock its head says what the conversation is about. */}
                    {conversationSubject === undefined || docked ? null : (
                      <ConversationSubjectLine
                        subject={conversationSubject.subject}
                        title={conversationSubject.title}
                        workspaceId={collaborationWorkspaceId}
                        onOpenRoute={openRoute}
                      />
                    )}
                  </>
                )
              }
              start={conversationStart(
                conversationSubject === undefined
                  ? undefined
                  : {
                      kind: conversationSubject.subject.kind,
                      // Until its record arrives the title is the asset's id, which is not said.
                      title:
                        conversationSubject.title === conversationSubject.subject.name
                          ? undefined
                          : conversationSubject.title
                    },
                dockKind
              )}
              retainedUntil={selectedConversationRetainedUntil}
              draftAttachments={draftAttachments}
              localUploadingAttachments={localUploadingAttachments}
              sendBlock={sendBlock}
              sendQueued={queuedSend !== undefined}
              attachmentsEnabled={attachmentsEnabled}
              attachmentAccept={attachmentAccept}
              conversationRunning={conversationRunning}
              activeRunId={activeRun?.run.id}
              preparingToolName={activeRun?.projection.preparingTool?.toolName}
              optimisticPending={optimisticPending}
              messagesEnabled={Boolean(selectedConversationId)}
              messagesLoaded={messagesLoaded}
              threadLoading={snapshotStatus === "loading"}
              loadedMessageCount={initialMessages.length}
              messageTimes={messageTimes}
              conversationId={selectedConversationId}
              composerFocusRequestId={composerFocusRequestId}
              startComposerRef={startComposerRef}
              onCancelRun={onCancelRun}
              onSelectAgent={onSelectAgent}
              onSelectModelBinding={selectModelBindingId}
              onSelectReasoningEffort={selectReasoningEffort}
              onFilesSelected={onFilesSelected}
              onRemoveDraftAttachment={onRemoveDraftAttachment}
              onRetryDraftAttachment={onRetryDraftAttachment}
              onQueueSend={queueSend}
              onSubmitMessage={selectedConversationId ? undefined : submitRootDraftMessage}
            />
          </AgentOpensProvider>
        </FollowUpQueueProvider>
      </AssistantToolRegistry>
    </AssistantRuntimeProvider>
  );
}

/**
 * The offer to go on privately, where the run that answers the person's own last request was
 * refused to build because others read the conversation, with that request to take along.
 * Nothing elsewhere, nothing for a later request after a refused one, and nothing for another
 * member who reads along.
 */
function usePrivateBuildOffer(
  chat: Pick<SelectedChatModel, "activeRun" | "completedRunProjections" | "messages">,
  currentUserId: string | undefined,
  continuePrivately: SelectedChatModel["continuePrivately"]
) {
  const { activeRun, completedRunProjections, messages } = chat;
  const [pending, setPending] = useState(false);
  const request = useMemo(
    () =>
      refusedRequest({
        currentUserId,
        messages: (messages ?? []).map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          runId: readCompatibleMessageRunId(message)
        })),
        activeRun: activeRun && {
          runId: activeRun.run.id,
          ownerUserId: activeRun.run.ownerUserId,
          inputMessageId: activeRun.run.inputMessageId,
          parts: activeRun.projection.parts
        },
        completedRuns: completedRunProjections ?? {}
      }),
    [activeRun, completedRunProjections, currentUserId, messages]
  );
  if (continuePrivately === undefined || request === undefined) return undefined;
  return (
    <PrivateBuildOffer
      pending={pending}
      onContinue={() => {
        setPending(true);
        // It says itself where the conversation could not be started.
        continuePrivately(request).then(
          () => setPending(false),
          () => setPending(false)
        );
      }}
    />
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

type ComposerAppendMessage = Parameters<
  NonNullable<UseChatRuntimeOptions<UIMessage>["toCreateMessage"]>
>[0];

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
