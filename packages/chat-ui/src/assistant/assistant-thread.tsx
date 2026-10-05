import {
  AuiIf,
  ThreadPrimitive,
  useAuiEvent,
  useAuiState,
  useThreadViewportStore
} from "@assistant-ui/react";
import { ArrowDown, Bot, CircleAlert, Sparkles } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { DraftAttachment, SafeConfig } from "@vivd-catalyst/api-client";
import { AssistantActivityStatus } from "./assistant-activity-status";
import { AssistantComposer, type LocalUploadingAttachment } from "./assistant-composer";
import { ThreadMessage } from "./assistant-message";
import { useTranslation } from "../i18n";
import { findRunActivity, shouldShowRunActivity } from "./thread-activity";
import { cn } from "../ui/cn";

/** How long the composer takes to settle at the bottom after the first message. */
const COMPOSER_SETTLE_MS = 220;

export function AssistantThread({
  config,
  agents,
  selectedAgentName,
  selectedModelBindingId,
  showContextIndicator,
  contextSnapshot,
  notice,
  draftAttachments,
  localUploadingAttachments,
  sendBlockedReason,
  attachmentsEnabled,
  attachmentAccept,
  conversationRunning,
  activeRunId,
  preparingToolName,
  optimisticPending,
  messagesEnabled,
  messagesLoaded,
  composerFocusRequestId,
  startComposerTopRef,
  onCancelRun,
  onSelectAgent,
  onSelectModelBinding,
  onFilesSelected,
  onRemoveDraftAttachment,
  onRetryDraftAttachment,
  onSubmitMessage
}: {
  config: SafeConfig | undefined;
  /** Agents offered on the start page. */
  agents: SafeConfig["agents"];
  selectedAgentName: string | undefined;
  selectedModelBindingId: string | undefined;
  showContextIndicator: boolean;
  contextSnapshot:
    | {
        inputTokens: number;
        compactThresholdTokens: number;
      }
    | undefined;
  notice: string | undefined;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  sendBlockedReason?: string;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
  conversationRunning?: boolean;
  activeRunId?: string;
  preparingToolName?: string;
  optimisticPending?: boolean;
  messagesEnabled: boolean;
  /** False while a selected conversation is still loading, so it is not mistaken for an empty one. */
  messagesLoaded: boolean;
  composerFocusRequestId: number;
  /**
   * Last viewport position of the centred start page composer. Owned by a
   * parent that outlives this component, because starting a conversation
   * remounts the thread.
   */
  startComposerTopRef?: RefObject<number | undefined>;
  onCancelRun: () => void;
  onSelectAgent: (agentName: string) => void;
  onSelectModelBinding: (modelBindingId: string) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveDraftAttachment: (attachmentId: string) => void;
  onRetryDraftAttachment: (attachmentId: string) => void;
  onSubmitMessage?: (text: string) => boolean;
}) {
  const { t } = useTranslation();
  const agent = getSelectedAgent(config, selectedAgentName);
  const initialPrompts = agent?.initialPrompts ?? [];
  const startPage =
    useAuiState((state) => state.thread.isEmpty) && messagesLoaded && !conversationRunning;
  const composerRef = useComposerSettleTransition(startPage, startComposerTopRef);

  if (config && config.agents.length === 0) {
    return (
      <section
        className="grid h-full min-h-0 place-items-center bg-background px-5"
        aria-label="Chat"
      >
        <div className="inline-flex max-w-md items-center gap-2 rounded-md border px-4 py-3 text-sm text-muted-foreground">
          <CircleAlert size={17} aria-hidden="true" />
          <span>{t("instanceNotConfigured")}</span>
        </div>
      </section>
    );
  }

  return (
    <section
      className="grid h-full min-h-0 min-w-0 overflow-hidden bg-background"
      aria-label="Chat"
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
          className="chat-scrollbar chat-thread-inset relative flex min-h-0 flex-col overflow-y-auto overflow-x-hidden scroll-smooth"
        >
          <ConversationRunTopAnchor activeRunId={activeRunId} />
          <div className="mx-auto flex min-h-full w-full max-w-[var(--thread-max-width)] flex-1 flex-col px-5 pt-20">
            {startPage ? (
              <ThreadWelcomeHeading
                agent={agent}
                fallbackWelcomeMessage={config?.ui.welcomeMessage ?? t("genericWelcome")}
              />
            ) : null}

            {messagesEnabled ? (
              <div className="flex flex-col gap-6 pb-12 empty:hidden md:pb-16">
                <ThreadPrimitive.Messages>
                  {() => (
                    <ThreadMessage
                      conversationRunning={conversationRunning}
                      activeRunId={activeRunId}
                      optimisticPending={optimisticPending}
                    />
                  )}
                </ThreadPrimitive.Messages>
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
                  <div
                    role="alert"
                    className="mb-2 inline-flex w-fit max-w-full items-center gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow-sm"
                  >
                    <CircleAlert size={17} className="shrink-0" aria-hidden="true" />
                    <span>{notice}</span>
                  </div>
                ) : null}
                <div className="relative">
                  {messagesEnabled ? (
                    <AuiIf condition={(state) => !state.thread.isEmpty}>
                      <ThreadScrollToBottom />
                    </AuiIf>
                  ) : null}
                  <AssistantComposer
                    attachments={draftAttachments}
                    localUploadingAttachments={localUploadingAttachments}
                    sendBlockedReason={sendBlockedReason}
                    conversationRunning={conversationRunning}
                    optimisticPending={optimisticPending}
                    attachmentsEnabled={attachmentsEnabled}
                    attachmentAccept={attachmentAccept}
                    selectableModels={config?.selectableModels ?? []}
                    selectedModelBindingId={selectedModelBindingId}
                    showContextIndicator={showContextIndicator}
                    contextSnapshot={contextSnapshot}
                    focusRequestId={composerFocusRequestId}
                    onCancelRun={onCancelRun}
                    onSelectModelBinding={onSelectModelBinding}
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
                agents={agents}
                initialPrompts={initialPrompts}
                selectedAgentName={agent?.name}
                onSelectAgent={onSelectAgent}
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
 * instead of letting it jump there when the first message is sent.
 */
function useComposerSettleTransition(
  startPage: boolean,
  startComposerTopRef: RefObject<number | undefined> | undefined
) {
  const composerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer || !startComposerTopRef) return;
    if (startPage) {
      startComposerTopRef.current = composer.getBoundingClientRect().top;
      return;
    }
    const startTop = startComposerTopRef.current;
    if (startTop === undefined) return;
    startComposerTopRef.current = undefined;
    const offset = startTop - composer.getBoundingClientRect().top;
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

function ThreadWelcomeHeading({
  agent,
  fallbackWelcomeMessage
}: {
  agent: SafeConfig["agents"][number] | undefined;
  fallbackWelcomeMessage: string | undefined;
}) {
  return (
    <div className="flex flex-1 basis-0 flex-col items-center justify-end gap-3 pb-4 text-center">
      <span className="grid size-10 place-items-center rounded-lg border bg-card text-primary shadow-xs">
        <Bot size={20} aria-hidden="true" />
      </span>
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold tracking-normal">
          {agent?.welcomeMessage ?? fallbackWelcomeMessage ?? "How can I help?"}
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

const startCardClassName = cn(
  "rounded-md border bg-card p-3 text-left text-sm shadow-xs transition-colors",
  "hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
);

function ThreadStartBlock({
  agents,
  initialPrompts,
  selectedAgentName,
  onSelectAgent
}: {
  agents: SafeConfig["agents"];
  initialPrompts: Array<{ title: string; prompt: string }>;
  selectedAgentName: string | undefined;
  onSelectAgent: (agentName: string) => void;
}) {
  return (
    <div className="grid flex-1 basis-0 content-start gap-5 pb-8 pt-2">
      {initialPrompts.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {initialPrompts.map((initialPrompt) => (
            <ThreadPrimitive.Suggestion
              key={`${initialPrompt.title}:${initialPrompt.prompt}`}
              prompt={initialPrompt.prompt}
              className={cn(startCardClassName, "group/suggestion grid min-h-20 content-between")}
            >
              <span className="font-medium">{initialPrompt.title}</span>
              <Sparkles
                size={15}
                className="mt-2 text-muted-foreground group-hover/suggestion:text-primary"
                aria-hidden="true"
              />
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      ) : null}
      <StartPageAgentCards
        agents={agents}
        selectedAgentName={selectedAgentName}
        onSelectAgent={onSelectAgent}
      />
      <div data-slot="workspace-apps" className="empty:hidden" />
    </div>
  );
}

/** One card per available agent; a single agent leaves nothing to choose. */
export function StartPageAgentCards({
  agents,
  selectedAgentName,
  onSelectAgent
}: {
  agents: SafeConfig["agents"];
  selectedAgentName: string | undefined;
  onSelectAgent: (agentName: string) => void;
}) {
  const { t } = useTranslation();

  if (agents.length < 2) {
    return null;
  }

  return (
    <div role="group" aria-label={t("selectAgent")} className="grid gap-2 sm:grid-cols-3">
      {agents.map((agent) => {
        const selected = agent.name === selectedAgentName;
        return (
          <button
            key={agent.name}
            type="button"
            aria-pressed={selected}
            data-testid="start-page-agent-card"
            className={cn(
              startCardClassName,
              "grid min-w-0 content-start gap-1",
              selected && "border-primary/60 bg-accent"
            )}
            onClick={() => onSelectAgent(agent.name)}
          >
            <span className="flex min-w-0 items-center gap-2 font-medium">
              <Bot
                size={15}
                className={cn("shrink-0", selected ? "text-primary" : "text-muted-foreground")}
                aria-hidden="true"
              />
              <span className="truncate">{agent.displayName}</span>
            </span>
            {agent.description ? (
              <span className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                {agent.description}
              </span>
            ) : null}
          </button>
        );
      })}
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
