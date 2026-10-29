import {
  AuiIf,
  ThreadPrimitive,
  useAuiEvent,
  useAuiState,
  useThreadViewportStore
} from "@assistant-ui/react";
import { ArrowDown, CircleAlert, Lock } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { DraftAttachment, SafeConfig } from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  cn,
  SkillIcon,
  Spinner,
  Starter,
  StarterList
} from "@work-shape/catalyst-ui";
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
import { focusComposerAtEnd } from "./composer-focus-request";
import { MessageTryRunLine } from "../dock/try-run-lines";
import { DayMarkersProvider, MessageDayMarker } from "./message-day-marker";
import { AgentChangeLinesProvider, MessageAgentChangeLine } from "./agent-change-line";
import { useTranslation } from "../../shared/i18n";
import { useFooterKeepsThreadInView, useKeepReadingPlace } from "./reading-place";
import type { SendBlock } from "./send-block";
import { useMoveWithPanels } from "../surface/panel-move";
import { findRunActivity, shouldShowRunActivity } from "./thread-activity";
import { ToolSubjectsProvider } from "./tool-subjects";
import { FoldedCardsProvider } from "../conversation/card-fold-context";
import { QuestionAnswersProvider } from "../questions/question-card";
import { messageFeedbackSetup } from "../feedback/message-feedback";
import {
  PlatformReportAction,
  platformReportSetup,
  type PlatformFailure
} from "../platform-report/platform-report";
import { useEmbeddedSession } from "../../shared/embedded-session";
import { startGreeting, startStarters, type ConversationStart } from "../dock/subject-starters";
import { creationTargetLine } from "../dock/creation-target";
import { ProjectInstructionsNotice } from "../projects/project-instructions";
import { useChatStart } from "./chat-start";

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
  personalData,
  selectedModelBindingId,
  selectedReasoningEffort,
  showContextIndicator,
  contextSnapshot,
  notice,
  noticeReport,
  usageNote,
  onNewConversationForPersonalData,
  newConversationPrivate,
  subjectLine,
  start,
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
  agentChanges,
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
  /** The conversation holds data from personal connections; blocked models show disabled. */
  personalData?: boolean;
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
  /** Where the notice is a run's platform failure: the run, to report it to the operator. */
  noticeReport?: { runId: string; failure: PlatformFailure };
  /** The quiet note at 80 percent of the person's own spend limit. */
  usageNote?: { text: string; dismiss(): void };
  /**
   * Set where the conversation holds personal data and no model the agent offers is allowed
   * for it: the composer says so and offers a new conversation (MODEL-REGION-3).
   */
  onNewConversationForPersonalData?: () => void;
  newConversationPrivate?: boolean;
  /** What the open conversation is about, where it is about an asset. */
  subjectLine?: ReactNode;
  /**
   * What the empty conversation is for: an asset, or a new one of a kind beside the dock. Its
   * greeting and starters replace the agent's own.
   */
  start?: ConversationStart;
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
  /** When each message of the open conversation was written, by the thread's id: its day markers. */
  messageTimes: Readonly<Record<string, string>>;
  /** Where another agent answers from a message on: that agent's name, by the message's id. */
  agentChanges?: ReadonlyMap<string, string>;
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
  // A place that starts chats, such as a project, gives the start page its own head and foot.
  const chatStart = useChatStart();
  const startAgentNames = chatStart?.agentNames;
  const offeredAgents = useMemo(
    () =>
      startAgentNames ? agents.filter((candidate) => startAgentNames.has(candidate.name)) : agents,
    [agents, startAgentNames]
  );
  const platformReport = platformReportSetup(config, conversationId, useEmbeddedSession());
  const agent = getSelectedAgent(config, selectedAgentName);
  const initialPrompts = agent?.initialPrompts ?? [];
  // A conversation names what a tool call touched from the agents the person is offered,
  // here and in their own workspace.
  const toolSubjectAgents = useMemo(
    () => [...(config?.agents ?? []), ...agents],
    [config?.agents, agents]
  );
  const agentChangeLabels = useMemo(
    () =>
      new Map(
        [...(agentChanges ?? [])].map(([messageId, agentName]) => [
          messageId,
          toolSubjectAgents.find((candidate) => candidate.name === agentName)?.displayName ??
            agentName
        ])
      ),
    [agentChanges, toolSubjectAgents]
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
  // A notice that appears over the composer moves the thread up instead of covering it.
  useFooterKeepsThreadInView(columnRef, composerRef);

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
                agents={offeredAgents}
                // An opened conversation that is still empty has the agent in the header.
                showAgent={!messagesEnabled}
                fallbackWelcomeMessage={config?.ui.welcomeMessage ?? t("genericWelcome")}
                start={start}
                heading={chatStart?.heading}
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
                  <DayMarkersProvider
                    messageTimes={messageTimes}
                    conversationRunning={conversationRunning}
                    optimisticPending={optimisticPending}
                  >
                    <FoldedCardsProvider>
                      <QuestionAnswersProvider>
                        <AgentChangeLinesProvider lines={agentChangeLabels}>
                          <ThreadPrimitive.Messages>
                            {() => (
                              <>
                                <MessageDayMarker />
                                <MessageTryRunLine />
                                <MessageAgentChangeLine />
                                <ThreadMessage
                                  conversationRunning={conversationRunning}
                                  activeRunId={activeRunId}
                                  feedback={messageFeedbackSetup(config, conversationId)}
                                  platformReport={platformReport}
                                />
                              </>
                            )}
                          </ThreadPrimitive.Messages>
                        </AgentChangeLinesProvider>
                      </QuestionAnswersProvider>
                    </FoldedCardsProvider>
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
              data-testid="thread-footer"
              className={cn(
                "z-10 shrink-0 pb-4 pt-2",
                startPage
                  ? "relative"
                  : "sticky bottom-0 mt-auto bg-background before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-4 before:bg-gradient-to-t before:from-background before:to-transparent before:content-['']"
              )}
            >
              <div ref={composerRef} className="relative z-10">
                {/* Above the entire footer, including notices and queued follow-ups. */}
                {messagesEnabled ? (
                  <AuiIf condition={(state) => !state.thread.isEmpty}>
                    <ThreadScrollToBottom />
                  </AuiIf>
                ) : null}
                {notice ? (
                  // Something went wrong with what was sent, so it is announced at once.
                  <Banner
                    tone="warning"
                    role="alert"
                    className="mb-2"
                    action={
                      platformReport && noticeReport ? (
                        <PlatformReportAction
                          key={noticeReport.runId}
                          setup={platformReport}
                          runId={noticeReport.runId}
                          failure={noticeReport.failure}
                          variant="outline"
                        />
                      ) : undefined
                    }
                  >
                    {notice}
                  </Banner>
                ) : null}
                {usageNote ? (
                  <p
                    className="mb-2 flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
                    data-testid="usage-near-limit-note"
                  >
                    <span className="min-w-0">{usageNote.text}</span>
                    <Button variant="link" size="sm" onClick={usageNote.dismiss}>
                      {t("composerLimit.dismiss")}
                    </Button>
                  </p>
                ) : null}
                {onNewConversationForPersonalData ? (
                  <p
                    className="mb-2 flex items-center gap-1.5 pl-1 text-xs text-muted-foreground"
                    data-testid="personal-data-no-model-note"
                  >
                    <Lock size={12} className="shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">{t("personalDataNoModel")}</span>
                    <Button variant="link" size="sm" onClick={onNewConversationForPersonalData}>
                      {t("personalDataNewConversation")}
                    </Button>
                  </p>
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
                <ProjectInstructionsNotice running={conversationRunning ?? false} />
                {subjectLine}
                {/* A conversation without a message is a draft and keeps the start page as it is. */}
                {startPage ? null : (
                  <RetentionNotice retention={config?.retention} retainedUntil={retainedUntil} />
                )}
                <div className="relative">
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
                    personalData={personalData}
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
                    chip={startPage ? chatStart?.composerChip : undefined}
                    inputLabel={startPage ? chatStart?.composerLabel : undefined}
                  />
                </div>
              </div>
            </ThreadPrimitive.ViewportFooter>

            {startPage && chatStart?.below !== undefined ? (
              <div className="grid flex-[3] basis-0 content-start gap-5 pb-8 pt-2">
                {chatStart.below}
              </div>
            ) : startPage ? (
              <ThreadStartBlock
                initialPrompts={initialPrompts}
                starters={agent?.starters ?? []}
                start={start}
                onStarterChosen={() => {
                  // The request stands in the composer now: the person goes on writing there.
                  window.requestAnimationFrame(() => {
                    focusComposerAtEnd(composerRef.current?.querySelector("textarea"));
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
  start,
  heading,
  onSelectAgent
}: {
  agent: SafeConfig["agents"][number] | undefined;
  agentDisplay: AgentChipDisplay;
  agents: SafeConfig["agents"];
  showAgent: boolean;
  fallbackWelcomeMessage: string | undefined;
  /** An empty conversation about an asset, or about a new one, is greeted for that. */
  start?: ConversationStart;
  /** Stands in place of the welcome message, as a project's name does on its page. */
  heading?: ReactNode;
  onSelectAgent: (agentName: string) => void;
}) {
  const { t } = useTranslation();
  const greeting = start === undefined ? undefined : startGreeting(start);
  // Where a new asset will belong, said once under the greeting of a dock that builds one.
  const targetLine =
    start?.about === "new" && start.target !== undefined
      ? creationTargetLine(start.kind, start.target, t)
      : undefined;
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
      {heading !== undefined ? (
        heading
      ) : (
        <div className="grid gap-1">
          <h2 className="text-title-lg">
            {greeting === undefined
              ? (agent?.welcomeMessage ?? fallbackWelcomeMessage ?? t("genericWelcome"))
              : t(greeting.key, greeting.values)}
          </h2>
          {targetLine === undefined ? null : (
            <p className="text-sm leading-6 text-muted-foreground" data-dock-creation-target="">
              {targetLine}
            </p>
          )}
          {greeting === undefined && agent?.welcomeSubtitle ? (
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              {agent.welcomeSubtitle}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * What the start page offers under the composer: the starters, then the agent's own prompts,
 * all in one list of the same cards. A conversation about an asset, or about a new one, offers
 * what a person asks of that instead, and never the agent's own prompts.
 */
export function ThreadStartBlock({
  initialPrompts,
  starters,
  start,
  onStarterChosen
}: {
  initialPrompts: Array<{ title: string; prompt: string }>;
  starters: NonNullable<SafeConfig["agents"][number]["starters"]>;
  /** What the conversation is for: an asset, or a new one of a kind. */
  start?: ConversationStart;
  onStarterChosen(): void;
}) {
  const { t } = useTranslation();
  if (start !== undefined) {
    const kindStarters = startStarters(start);
    return (
      <div className="grid flex-[3] basis-0 content-start gap-5 pb-8 pt-2">
        {kindStarters.length === 0 ? null : (
          <StarterList label={t("chatStarters")}>
            {kindStarters.map(({ icon: Icon, title, hint, prompt }) => (
              <ThreadPrimitive.Suggestion key={title} prompt={t(prompt)} asChild>
                <Starter
                  icon={<Icon aria-hidden="true" className="size-5 text-muted-foreground" />}
                  title={t(title)}
                  hint={t(hint)}
                  onClick={onStarterChosen}
                />
              </ThreadPrimitive.Suggestion>
            ))}
          </StarterList>
        )}
      </div>
    );
  }
  return (
    <div className="grid flex-[3] basis-0 content-start gap-5 pb-8 pt-2">
      {/* The requests the agent's author wrote, then what its skills offer to begin with: four
          at most, which the server keeps. Choosing one fills the composer and sends nothing, so
          the person reads and completes the request first. */}
      {starters.length > 0 || initialPrompts.length > 0 ? (
        <StarterList label={t("chatStarters")}>
          {/* The request itself is the hint of the author's own, unless it only repeats the title. */}
          {initialPrompts.map((initialPrompt) => (
            <ThreadPrimitive.Suggestion
              key={`${initialPrompt.title}:${initialPrompt.prompt}`}
              prompt={initialPrompt.prompt}
              asChild
            >
              <Starter
                icon={<SkillIcon icon="prompt" size="lg" />}
                title={initialPrompt.title}
                hint={
                  initialPrompt.prompt.trim() === initialPrompt.title.trim()
                    ? undefined
                    : initialPrompt.prompt
                }
                onClick={onStarterChosen}
              />
            </ThreadPrimitive.Suggestion>
          ))}
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
      <div data-slot="workspace-apps" className="empty:hidden" />
    </div>
  );
}

function ThreadScrollToBottom() {
  const { t } = useTranslation();

  return (
    <ThreadPrimitive.ScrollToBottom
      className="absolute bottom-full mb-2 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:invisible"
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
