import {
  AuiIf,
  ThreadPrimitive,
  useAuiEvent,
  useAuiState,
  useThreadViewportStore
} from "@assistant-ui/react";
import { ArrowDown, CircleAlert, Lock } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { DraftAttachment, SafeConfig } from "@vivd-catalyst/api-client";
import { Banner, cn, SkillIcon, Spinner, Starter, StarterList } from "@vivd-catalyst/ui";
import type { AgentSelectableModel, ReasoningEffort } from "../workspace/agent-model-selection";
import {
  agentChipDisplayFor,
  AgentSelector,
  type AgentChipDisplay
} from "../workspace/agent-selector";
import { AssistantActivityStatus } from "./assistant-activity-status";
import { RetentionNotice } from "../conversation/retention-notice";
import { AssistantComposer, type LocalUploadingAttachment } from "./assistant-composer";
import { ThreadMessage } from "./assistant-message";
import { DayMarkersProvider, MessageDayMarker } from "./message-day-marker";
import { useTranslation } from "../i18n";
import { useKeepReadingPlace } from "./reading-place";
import type { SendBlock } from "./send-block";
import { useMoveWithPanels } from "../surface/panel-move";
import { findRunActivity, shouldShowRunActivity } from "./thread-activity";
import { ToolSubjectsProvider } from "./tool-subjects";

/** How long the composer takes to settle at the bottom after the first message. */
const COMPOSER_SETTLE_MS = 220;

/** Where the centred start page composer last sat, and which conversation may settle from there. */
export interface StartComposerPosition {
  /** Viewport position of the composer's upper edge. */
  top: number;
  /**
   * The conversation the start page belongs to: the open one, or the one its first message
   * began. Any other conversation shows its composer at the bottom without a move.
   */
  conversationId: string | undefined;
}

export function AssistantThread({
  config,
  agents,
  noAgentsMessage,
  selectedAgentName,
  selectableModels,
  selectedModelBindingId,
  selectedReasoningEffort,
  showContextIndicator,
  contextSnapshot,
  notice,
  newConversationPrivate,
  subjectLine,
  retainedUntil,
  draftAttachments,
  localUploadingAttachments,
  sendBlock,
  sendQueued,
  attachmentsEnabled,
  attachmentAccept,
  conversationRunning,
  activeRunId,
  preparingToolName,
  optimisticPending,
  messagesEnabled,
  messagesLoaded,
  threadLoading,
  loadedMessageCount,
  messageTimes,
  conversationId,
  composerFocusRequestId,
  startComposerRef,
  onCancelRun,
  onSelectAgent,
  onSelectModelBinding,
  onSelectReasoningEffort,
  onFilesSelected,
  onRemoveDraftAttachment,
  onRetryDraftAttachment,
  onQueueSend,
  onSubmitMessage
}: {
  config: SafeConfig | undefined;
  /** Agents offered on the start page. */
  agents: SafeConfig["agents"];
  /** Set when no agent can take a new conversation here; replaces the start page. */
  noAgentsMessage?: string;
  selectedAgentName: string | undefined;
  selectableModels: AgentSelectableModel[];
  selectedModelBindingId: string | undefined;
  selectedReasoningEffort: ReasoningEffort | undefined;
  showContextIndicator: boolean;
  contextSnapshot:
    | {
        inputTokens: number;
        compactThresholdTokens: number;
      }
    | undefined;
  notice: string | undefined;
  newConversationPrivate?: boolean;
  /** What the open conversation is about, where it is about an asset. */
  subjectLine?: ReactNode;
  /** The open conversation's retention date. */
  retainedUntil?: string;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  sendBlock?: SendBlock;
  sendQueued: boolean;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
  conversationRunning?: boolean;
  activeRunId?: string;
  preparingToolName?: string;
  optimisticPending?: boolean;
  messagesEnabled: boolean;
  /** False while a selected conversation is still loading, so it is not mistaken for an empty one. */
  messagesLoaded: boolean;
  /** The open conversation's thread has not arrived yet: a line says so while the send waits. */
  threadLoading?: boolean;
  /**
   * How many messages the loaded conversation holds. The thread runtime takes them up one
   * effect later, so its own empty state alone would show the start page for a frame.
   */
  loadedMessageCount: number;
  /** When each stored message of the open conversation was written, by id: its day markers. */
  messageTimes: Readonly<Record<string, string>>;
  /** The open conversation; undefined on the screen for a new one. */
  conversationId?: string;
  composerFocusRequestId: number;
  /**
   * Last position of the centred start page composer. Owned by a parent that
   * outlives this component, because starting a conversation remounts the thread.
   */
  startComposerRef?: RefObject<StartComposerPosition | undefined>;
  onCancelRun: () => void;
  onSelectAgent: (agentName: string) => void;
  onSelectModelBinding: (modelBindingId: string) => void;
  onSelectReasoningEffort: (modelBindingId: string, effort: ReasoningEffort) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveDraftAttachment: (attachmentId: string) => void;
  onRetryDraftAttachment: (attachmentId: string) => void;
  onQueueSend: (text: string) => void;
  onSubmitMessage?: (text: string) => boolean;
}) {
  const { t } = useTranslation();
  const agent = getSelectedAgent(config, selectedAgentName);
  const initialPrompts = agent?.initialPrompts ?? [];
  // A conversation names what a tool call touched from the agents the person is offered,
  // here and in their own workspace.
  const toolSubjectAgents = useMemo(
    () => [...(config?.agents ?? []), ...agents],
    [config?.agents, agents]
  );
  const startPage =
    useAuiState((state) => state.thread.isEmpty) &&
    messagesLoaded &&
    loadedMessageCount === 0 &&
    !conversationRunning;
  const composerRef = useComposerSettleTransition(startPage, conversationId, startComposerRef);
  // The column travels with a panel that opens or closes beside the conversation.
  const columnRef = useMoveWithPanels<HTMLDivElement>();
  useKeepReadingPlace(columnRef);

  // An existing conversation stays readable; only the composer is blocked.
  if (noAgentsMessage && !messagesEnabled) {
    return (
      <section
        className="grid h-full min-h-0 place-items-center bg-background px-5"
        aria-label={t("chatRegionLabel")}
      >
        <div className="inline-flex max-w-md items-center gap-2 rounded-md border px-4 py-3 text-sm text-muted-foreground">
          <CircleAlert size={17} aria-hidden="true" />
          <span>{noAgentsMessage}</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className="grid h-full min-h-0 min-w-0 overflow-hidden bg-background"
      aria-label={t("chatRegionLabel")}
    >
      <ThreadPrimitive.Root
        className="grid h-full min-h-0 min-w-0 overflow-hidden"
        style={{ ["--thread-max-width" as string]: "52rem" }}
      >
        <ThreadPrimitive.Viewport
          turnAnchor="top"
          topAnchorMessageClamp={{ tallerThan: "16rem", visibleHeight: "12rem" }}
          scrollToBottomOnRunStart={false}
          scrollToBottomOnInitialize={!activeRunId}
          scrollToBottomOnThreadSwitch={!activeRunId}
          className="chat-thread-inset relative flex min-h-0 flex-col overflow-y-auto overflow-x-hidden scroll-smooth"
        >
          <ConversationRunTopAnchor activeRunId={activeRunId} />
          <div
            ref={columnRef}
            className="mx-auto flex min-h-full w-full max-w-[var(--thread-max-width)] flex-1 flex-col px-5 pt-(--thread-start,5rem)"
          >
            {startPage ? (
              <ThreadWelcomeHeading
                agent={agent}
                agentDisplay={agentChipDisplayFor(config?.ui)}
                agents={agents}
                // An opened conversation that is still empty has the agent in the header.
                showAgent={!messagesEnabled}
                fallbackWelcomeMessage={config?.ui.welcomeMessage ?? t("genericWelcome")}
                onSelectAgent={onSelectAgent}
              />
            ) : null}

            {threadLoading ? (
              <p
                className="flex items-center gap-2 py-1 text-body text-muted-foreground"
                data-testid="thread-loading"
                role="status"
              >
                <Spinner size="sm" />
                {t("loadingConversation")}
              </p>
            ) : null}

            {messagesEnabled ? (
              <div className="flex flex-col gap-6 pb-12 empty:hidden md:pb-16">
                <ToolSubjectsProvider agents={toolSubjectAgents}>
                  <DayMarkersProvider messageTimes={messageTimes}>
                    <ThreadPrimitive.Messages>
                      {() => (
                        <>
                          <MessageDayMarker />
                          <ThreadMessage
                            conversationRunning={conversationRunning}
                            activeRunId={activeRunId}
                            optimisticPending={optimisticPending}
                          />
                        </>
                      )}
                    </ThreadPrimitive.Messages>
                  </DayMarkersProvider>
                </ToolSubjectsProvider>
                <RunActivityRow
                  activeRunId={activeRunId}
                  conversationRunning={conversationRunning}
                  optimisticPending={optimisticPending}
                  preparingToolName={preparingToolName}
                />
              </div>
            ) : null}

            {/* The one composer: the start page only changes where it sits. */}
            <ThreadPrimitive.ViewportFooter
              className={cn(
                "z-10 shrink-0 pb-4 pt-2",
                startPage
                  ? "relative"
                  : "sticky bottom-0 mt-auto after:pointer-events-none after:absolute after:inset-0 after:z-0 after:bg-gradient-to-t after:from-background after:via-background after:to-transparent after:content-['']"
              )}
            >
              <div ref={composerRef} className="relative z-10">
                {notice ? (
                  // Something went wrong with what was sent, so it is announced at once.
                  <Banner tone="warning" role="alert" className="mb-2">
                    {notice}
                  </Banner>
                ) : null}
                {newConversationPrivate ? (
                  <p
                    className="mb-2 flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
                    data-testid="new-conversation-private-hint"
                  >
                    <Lock size={12} className="shrink-0" aria-hidden="true" />
                    <span>{t("newConversationPrivateHint")}</span>
                  </p>
                ) : null}
                {subjectLine}
                {/* A conversation without a message is a draft and keeps the start page as it is. */}
                {startPage ? null : (
                  <RetentionNotice retention={config?.retention} retainedUntil={retainedUntil} />
                )}
                <div className="relative">
                  {messagesEnabled ? (
                    <AuiIf condition={(state) => !state.thread.isEmpty}>
                      <ThreadScrollToBottom />
                    </AuiIf>
                  ) : null}
                  <AssistantComposer
                    attachments={draftAttachments}
                    localUploadingAttachments={localUploadingAttachments}
                    sendBlock={sendBlock}
                    sendQueued={sendQueued}
                    onQueueSend={onQueueSend}
                    conversationRunning={conversationRunning}
                    optimisticPending={optimisticPending}
                    attachmentsEnabled={attachmentsEnabled}
                    attachmentAccept={attachmentAccept}
                    selectableModels={selectableModels}
                    selectedModelBindingId={selectedModelBindingId}
                    selectedReasoningEffort={selectedReasoningEffort}
                    showContextIndicator={showContextIndicator}
                    contextSnapshot={contextSnapshot}
                    focusRequestId={composerFocusRequestId}
                    onCancelRun={onCancelRun}
                    onSelectModelBinding={onSelectModelBinding}
                    onSelectReasoningEffort={onSelectReasoningEffort}
                    onFilesSelected={onFilesSelected}
                    onRemoveAttachment={onRemoveDraftAttachment}
                    onRetryAttachment={onRetryDraftAttachment}
                    onSubmitMessage={onSubmitMessage}
                  />
                </div>
              </div>
            </ThreadPrimitive.ViewportFooter>

            {startPage ? (
              <ThreadStartBlock
                initialPrompts={initialPrompts}
                starters={agent?.starters ?? []}
                onStarterChosen={() => {
                  // The request stands in the composer now: the person goes on writing there.
                  window.requestAnimationFrame(() => {
                    const input = composerRef.current?.querySelector("textarea");
                    input?.focus({ preventScroll: true });
                    input?.setSelectionRange(input.value.length, input.value.length);
                  });
                }}
              />
            ) : null}
          </div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </section>
  );
}

/**
 * The product run continues after the short assistant-ui transport has closed,
 * so assistant-ui's built-in run state cannot discover the eventual projected
 * assistant message. Register that real user/assistant pair with the viewport
 * while retaining the library's reserve and scroll behavior.
 */
function ConversationRunTopAnchor({ activeRunId }: { activeRunId?: string }) {
  const viewportStore = useThreadViewportStore();
  const messages = useAuiState((state) => state.thread.messages);
  const retainedTurnRef = useRef<{ anchorId: string; targetId: string } | null>(null);
  const turn = useMemo(() => {
    const target = messages.at(-1);
    const anchor = messages.at(-2);
    if (anchor?.role !== "user" || target?.role !== "assistant") {
      return null;
    }
    const currentTurn = viewportStore.getState().topAnchorTurn;
    const startsActiveTurn = activeRunId !== undefined && target.id === activeRunId;
    const continuesActiveTurn =
      currentTurn?.anchorId === anchor.id || retainedTurnRef.current?.anchorId === anchor.id;
    if (!startsActiveTurn && !continuesActiveTurn) return null;
    return { anchorId: anchor.id, targetId: target.id };
  }, [activeRunId, messages, viewportStore]);
  if (turn) retainedTurnRef.current = turn;

  useLayoutEffect(() => {
    if (!turn) return;
    const state = viewportStore.getState();
    if (
      state.topAnchorTurn?.anchorId === turn.anchorId &&
      state.topAnchorTurn.targetId === turn.targetId
    ) {
      return;
    }
    state.setTopAnchorTurn(turn);
  }, [turn, viewportStore]);

  useAuiEvent("thread.initialize", () => {
    const retainedTurn = retainedTurnRef.current;
    if (!retainedTurn) return;
    // RuntimeMessagesBridge imports every product-run projection as external
    // state. assistant-ui clears its top anchor on each import; restore it in
    // the same frame so those projections cannot pull the viewport downward.
    queueMicrotask(() => {
      const state = viewportStore.getState();
      if (state.turnAnchor === "top") state.setTopAnchorTurn(retainedTurn);
    });
  });

  return null;
}

/**
 * Moves the composer from its centred start page position to the bottom
 * instead of letting it jump there when the first message is sent. Opening
 * another conversation is no such move: its composer is at the bottom at once.
 */
function useComposerSettleTransition(
  startPage: boolean,
  conversationId: string | undefined,
  startComposerRef: RefObject<StartComposerPosition | undefined> | undefined
) {
  const composerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer || !startComposerRef) return;
    if (startPage) {
      startComposerRef.current = { top: composer.getBoundingClientRect().top, conversationId };
      return;
    }
    const start = startComposerRef.current;
    if (!start) return;
    startComposerRef.current = undefined;
    if (start.conversationId !== conversationId) return;
    const offset = start.top - composer.getBoundingClientRect().top;
    if (
      Math.abs(offset) < 1 ||
      typeof composer.animate !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    composer.animate([{ transform: `translateY(${offset}px)` }, { transform: "none" }], {
      duration: COMPOSER_SETTLE_MS,
      easing: "cubic-bezier(0.2, 0, 0, 1)"
    });
  });

  return composerRef;
}

/** The start page heading with the agent above the welcome message. */
export function ThreadWelcomeHeading({
  agent,
  agentDisplay,
  agents,
  showAgent,
  fallbackWelcomeMessage,
  onSelectAgent
}: {
  agent: SafeConfig["agents"][number] | undefined;
  agentDisplay: AgentChipDisplay;
  agents: SafeConfig["agents"];
  showAgent: boolean;
  fallbackWelcomeMessage: string | undefined;
  onSelectAgent: (agentName: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-[2] basis-0 flex-col items-center justify-end gap-3 pb-4 text-center">
      {showAgent && agents.length > 0 ? (
        <div className="max-w-full min-w-0">
          <AgentSelector
            agents={agents}
            display={agentDisplay}
            placement="start-page"
            selectedAgentName={agent?.name}
            onSelectAgent={onSelectAgent}
          />
        </div>
      ) : null}
      <div className="grid gap-1">
        <h2 className="text-title-lg">
          {agent?.welcomeMessage ?? fallbackWelcomeMessage ?? t("genericWelcome")}
        </h2>
        {agent?.welcomeSubtitle ? (
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            {agent.welcomeSubtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// A suggestion is an outlined pill: hairline, no fill, no shadow, the hover fill.
const suggestionChipClassName =
  "inline-flex min-h-8 max-w-full items-center rounded-full border px-3 py-1 text-left text-body transition-colors hover:bg-state-hover focus-visible:focus-ring";

/** What the start page offers under the composer: the starters, then the agent's own prompts. */
export function ThreadStartBlock({
  initialPrompts,
  starters,
  onStarterChosen
}: {
  initialPrompts: Array<{ title: string; prompt: string }>;
  starters: NonNullable<SafeConfig["agents"][number]["starters"]>;
  onStarterChosen(): void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid flex-[3] basis-0 content-start gap-5 pb-8 pt-2">
      {/* What the agent's skills offer to begin with. Choosing one fills the composer and
          sends nothing, so the person reads and completes the request first. */}
      {starters.length > 0 ? (
        <StarterList label={t("chatStarters")}>
          {starters.map((starter, index) => (
            <ThreadPrimitive.Suggestion
              key={`${index}:${starter.skillName}:${starter.title}`}
              prompt={starter.prompt}
              asChild
            >
              <Starter
                icon={<SkillIcon icon={starter.icon} size="lg" />}
                title={starter.title}
                hint={starter.hint}
                onClick={onStarterChosen}
              />
            </ThreadPrimitive.Suggestion>
          ))}
        </StarterList>
      ) : null}
      {initialPrompts.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-2">
          {initialPrompts.map((initialPrompt) => (
            <ThreadPrimitive.Suggestion
              key={`${initialPrompt.title}:${initialPrompt.prompt}`}
              prompt={initialPrompt.prompt}
              className={suggestionChipClassName}
            >
              {initialPrompt.title}
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      ) : null}
      <div data-slot="workspace-apps" className="empty:hidden" />
    </div>
  );
}

function ThreadScrollToBottom() {
  const { t } = useTranslation();

  return (
    <ThreadPrimitive.ScrollToBottom
      className="absolute -top-5 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:invisible"
      aria-label={t("scrollToBottom")}
      title={t("scrollToBottom")}
    >
      <ArrowDown size={15} aria-hidden="true" />
    </ThreadPrimitive.ScrollToBottom>
  );
}

/**
 * The single progress indicator for the whole thread.
 *
 * It is mounted for as long as the thread is busy and lives at a fixed
 * position below the last message, so nothing about the assistant part tree can
 * move it, duplicate it, or blank it out. Only its wording changes.
 */
function RunActivityRow({
  activeRunId,
  conversationRunning,
  optimisticPending,
  preparingToolName
}: {
  activeRunId?: string;
  conversationRunning?: boolean;
  optimisticPending?: boolean;
  preparingToolName?: string;
}) {
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const lastAssistantParts = useAuiState((state) => {
    const lastMessage = state.thread.messages.at(-1);
    return lastMessage?.role === "assistant" ? lastMessage.parts : undefined;
  });
  const activity = useMemo(() => findRunActivity(lastAssistantParts), [lastAssistantParts]);

  if (!shouldShowRunActivity({ conversationRunning, optimisticPending, threadRunning })) {
    return null;
  }

  return (
    // `-mt-6` cancels the message list gap so the row keeps its own small
    // offset from whatever it follows, instead of inheriting message spacing.
    <div
      className="mx-auto -mt-6 w-full max-w-5xl px-1 pt-2 animate-in fade-in duration-150"
      data-role="assistant"
      data-testid="run-activity"
    >
      <AssistantActivityStatus
        activity={activity}
        preparingToolName={preparingToolName}
        variationSeed={activeRunId}
      />
    </div>
  );
}

function getSelectedAgent(
  config: SafeConfig | undefined,
  selectedAgentName: string | undefined
): SafeConfig["agents"][number] | undefined {
  return (
    config?.agents.find((candidate) => candidate.name === selectedAgentName) ??
    config?.agents.find((candidate) => candidate.name === config.defaultAgentName) ??
    config?.agents[0]
  );
}
