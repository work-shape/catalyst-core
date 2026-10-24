import { useWaitsForDecision } from "../approvals/tool-decision-context";
import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  useAuiState,
  useThreadViewport,
  useThreadViewportStore,
  type PartState
} from "@assistant-ui/react";
import { Check, Copy, ListRestart, User } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn, IconButton } from "@work-shape/catalyst-ui";
import { ApprovalDecisionLine } from "../approvals/approval-decision-line";
import { MessageAttachments } from "../files/message-attachments";
import { FilePart, ImagePart } from "./message-file-parts";
import {
  ASSISTANT_WORK_GROUP,
  countAssistantWorkTimelineSteps,
  createCompletedAssistantWorkIndices,
  createAssistantMessageGroupBy,
  createRenderableAssistantToolGroupIndices,
  createAssistantWorkTimelineItems,
  createVisibleFinalAssistantPartIndices,
  findFinalAssistantTextPartIndex,
  type AssistantWorkTimelineItem
} from "./assistant-work-grouping";
import type { AssistantUiMessageCustomMetadata } from "./assistant-ui-adapter";
import { AssistantSourcePart } from "./assistant-source-part";
import { useTranslation } from "../../shared/i18n";
import { MarkdownText } from "../markdown/markdown-text";
import { DataPart, ToolCallFoldLabel, ToolCallPart } from "../tools/tool-call";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "./assistant-tool-group";
import { formatWorkHistoryLabel } from "./thread-time";
import {
  acknowledgeRecentlyActiveAssistantRunId,
  isRecentlyActiveAssistantRunId,
  rememberRecentlyActiveAssistantRunId
} from "./recently-active-runs";
import { isWorkspacePromotedSurfacesData } from "../tools/tool-surfaces";
import {
  MessageFeedbackAction,
  MessageFeedbackPanel,
  useMessageFeedback,
  type MessageFeedbackSetup
} from "../feedback/message-feedback";

const chronologicalAssistantMessageGroupBy = createAssistantMessageGroupBy();

export function ThreadMessage({
  conversationRunning,
  activeRunId,
  feedback
}: {
  conversationRunning?: boolean;
  activeRunId?: string;
  /** Where the module `feedback` is on: the action under each finished answer. */
  feedback?: MessageFeedbackSetup;
}) {
  const role = useAuiState((state) => state.message.role);

  if (role === "user") {
    return <UserMessage />;
  }

  if (role === "system") {
    return <ApprovalDecisionMessage />;
  }

  return (
    <AssistantMessage
      activeRunId={activeRunId}
      conversationRunning={conversationRunning}
      feedback={feedback}
    />
  );
}

/**
 * The only system message the thread shows. It is a record between turns, so
 * it gets no bubble and no actions, and sits closer to the message it follows.
 */
function ApprovalDecisionMessage() {
  const decision = useAuiState(
    (state) =>
      (state.message.metadata.custom as AssistantUiMessageCustomMetadata | undefined)
        ?.approvalDecision
  );

  if (!decision) {
    return null;
  }

  return (
    <MessagePrimitive.Root
      className="mx-auto -mt-4 w-full max-w-5xl px-1 last:mb-8"
      data-role="system"
    >
      <ApprovalDecisionLine decision={decision} showSummary={decision.ambiguous} />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({
  activeRunId,
  conversationRunning,
  feedback
}: {
  activeRunId?: string;
  conversationRunning?: boolean;
  feedback?: MessageFeedbackSetup;
}) {
  const { t } = useTranslation();
  const messageId = useAuiState((state) => state.message.id);
  const messageParts = useAuiState((state) => state.message.parts);
  const activeRunProjectionMessage = useAuiState(
    (state) =>
      (state.message.metadata.custom as AssistantUiMessageCustomMetadata | undefined)?.source ===
      "active-run"
  );
  const activeRunCompleted = useAuiState(
    (state) =>
      (state.message.metadata.custom as AssistantUiMessageCustomMetadata | undefined)
        ?.activeRunCompleted === true
  );
  const completedRunId = useAuiState(
    (state) =>
      (state.message.metadata.custom as AssistantUiMessageCustomMetadata | undefined)
        ?.completedRunId
  );
  const runDurationMs = useAuiState(
    (state) =>
      (state.message.metadata.custom as AssistantUiMessageCustomMetadata | undefined)?.runDurationMs
  );
  const contextCompacted = useAuiState(
    (state) =>
      (state.message.metadata.custom as AssistantUiMessageCustomMetadata | undefined)
        ?.contextCompacted === true
  );
  const matchesActiveRun = Boolean(activeRunId && messageId === activeRunId);
  const activeRunMessage = Boolean(
    conversationRunning && (activeRunProjectionMessage || matchesActiveRun)
  );
  const messageRunning = useAuiState(
    (state) =>
      state.message.role === "assistant" &&
      (state.message.status?.type === "running" || activeRunMessage)
  );
  const finalTextIndex = findFinalAssistantTextPartIndex(messageParts);
  // Only a finished run's answer takes feedback: it names the run the comment is about.
  const messageFeedback = useMessageFeedback(feedback, messageRunning ? undefined : completedRunId);
  const toolUIs = useAuiState((state) => state.tools.toolUIs);
  const completedWorkIndices = useMemo(
    () => createCompletedAssistantWorkIndices(messageParts, finalTextIndex),
    [finalTextIndex, messageParts]
  );
  const visibleFinalPartIndices = useMemo(
    () => createVisibleFinalAssistantPartIndices(messageParts, finalTextIndex),
    [finalTextIndex, messageParts]
  );
  const completedWorkTimelineItems = useMemo(
    () => createAssistantWorkTimelineItems(messageParts, completedWorkIndices, { toolUIs }),
    [completedWorkIndices, messageParts, toolUIs]
  );
  const completedWorkStepCount = useMemo(
    () => countAssistantWorkTimelineSteps(completedWorkTimelineItems),
    [completedWorkTimelineItems]
  );
  const completedWorkSummary =
    !messageRunning &&
    !activeRunProjectionMessage &&
    completedWorkStepCount > 0 &&
    finalTextIndex >= 0;
  // Reading this must not consume it: auto-collapse and auto-preview both
  // depend on it, and whichever ran first used to silently disable the other.
  // Capture this for the lifetime of the mounted message, then acknowledge it
  // after the first paint. Returning to the conversation mounts a fresh message
  // without replaying completion-only effects such as the collapse animation.
  const [justCompletedRun] = useState(() => isRecentlyActiveAssistantRunId(completedRunId));
  const autoCollapseCompletedWorkSummary = justCompletedRun;
  const autoPreviewSurfaces = justCompletedRun || activeRunCompleted;
  const assistantPartComponents = useAssistantPartComponents({
    autoPreviewSurfaces,
    displayPresentation: "full"
  });
  const completedWorkPartComponents = useAssistantPartComponents({
    autoPreviewSurfaces: false,
    displayPresentation: "summary"
  });
  useEffect(() => {
    if (activeRunProjectionMessage) {
      rememberRecentlyActiveAssistantRunId(messageId);
    }
  }, [activeRunProjectionMessage, messageId]);
  useEffect(() => {
    if (justCompletedRun) {
      acknowledgeRecentlyActiveAssistantRunId(completedRunId);
    }
  }, [completedRunId, justCompletedRun]);

  return (
    <MessagePrimitive.Root
      className="group/message mx-auto w-full max-w-5xl animate-in fade-in slide-in-from-bottom-1 duration-150"
      data-role="assistant"
    >
      {contextCompacted ? (
        <div
          className="mb-3 flex items-center gap-2 px-1 text-sm text-muted-foreground"
          data-testid="context-compaction-notice"
        >
          <ListRestart size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>{t("contextAutomaticallyCompacted")}</span>
        </div>
      ) : null}
      <div className="min-w-0 rounded-md px-1 pb-1 pt-5 text-sm leading-6">
        {completedWorkSummary ? (
          <>
            <AssistantWorkGroup
              count={completedWorkStepCount}
              summary
              durationMs={runDurationMs}
              autoCollapse={autoCollapseCompletedWorkSummary}
            >
              <AssistantWorkTimeline
                items={completedWorkTimelineItems}
                partComponents={completedWorkPartComponents}
              />
            </AssistantWorkGroup>
            {visibleFinalPartIndices.map((index) => (
              <MessagePrimitive.PartByIndex
                key={`part-${index}`}
                index={index}
                components={assistantPartComponents}
              />
            ))}
          </>
        ) : (
          <MessagePrimitive.GroupedParts groupBy={chronologicalAssistantMessageGroupBy}>
            {({ part, children }) =>
              renderAssistantGroupedPart({
                part,
                children,
                autoPreviewSurfaces,
                assistantPartComponents,
                messageParts
              })
            }
          </MessagePrimitive.GroupedParts>
        )}
        <MessageError />
      </div>
      {!messageRunning ? (
        <div className="mt-1 flex min-h-8 items-center gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100">
          <ActionBarPrimitive.Copy asChild>
            <IconButton label={t("copy")}>
              <CopiedState />
            </IconButton>
          </ActionBarPrimitive.Copy>
          {messageFeedback ? <MessageFeedbackAction state={messageFeedback} /> : null}
        </div>
      ) : null}
      {messageFeedback ? <MessageFeedbackPanel state={messageFeedback} /> : null}
    </MessagePrimitive.Root>
  );
}

function useAssistantPartComponents(options: {
  autoPreviewSurfaces: boolean;
  displayPresentation: "full" | "summary";
}) {
  return useMemo(
    () => createAssistantPartComponents(options),
    [options.autoPreviewSurfaces, options.displayPresentation]
  );
}

function createAssistantPartComponents(options: {
  autoPreviewSurfaces: boolean;
  displayPresentation: "full" | "summary";
}): Parameters<typeof MessagePrimitive.PartByIndex>[0]["components"] {
  return {
    Text: AssistantTextPart,
    Reasoning: AssistantReasoningPart,
    Source: AssistantSourcePart,
    Image: ImagePart,
    File: FilePart,
    tools: {
      Override: (part) => (
        <ToolCallPart {...part} displayPresentation={options.displayPresentation} />
      )
    },
    data: {
      Fallback: (part) => (
        <DataPart
          {...part}
          autoPreviewSurfaces={options.autoPreviewSurfaces}
          displayPresentation={options.displayPresentation}
        />
      )
    }
  };
}

type AssistantGroupedRenderInfo = Parameters<
  Parameters<typeof MessagePrimitive.GroupedParts>[0]["children"]
>[0];

function renderAssistantGroupedPart({
  part,
  children,
  autoPreviewSurfaces,
  assistantPartComponents,
  messageParts
}: AssistantGroupedRenderInfo & {
  autoPreviewSurfaces: boolean;
  assistantPartComponents: Parameters<typeof MessagePrimitive.PartByIndex>[0]["components"];
  messageParts: readonly PartState[];
}) {
  switch (part.type) {
    case ASSISTANT_WORK_GROUP:
      const renderableIndices = createRenderableAssistantToolGroupIndices(
        messageParts,
        part.indices
      );
      return (
        <AssistantWorkGroup
          count={renderableIndices.length}
          only={onlyToolCall(messageParts, renderableIndices)}
          last={lastToolCall(messageParts, renderableIndices)}
          toolCallIds={toolCallIdsOf(messageParts, renderableIndices)}
          summary={false}
        >
          {renderableIndices.map((index) => (
            <MessagePrimitive.PartByIndex
              key={`part-${index}`}
              index={index}
              components={assistantPartComponents}
            />
          ))}
        </AssistantWorkGroup>
      );
    case "text":
      return <AssistantTextPart />;
    case "tool-call":
      return part.toolUI ?? <ToolCallPart {...part} displayPresentation="full" />;
    case "data":
      return autoPreviewSurfaces && isWorkspacePromotedSurfacesData(part.data) ? (
        <DataPart {...part} autoPreviewSurfaces={autoPreviewSurfaces} displayPresentation="full" />
      ) : (
        (part.dataRendererUI ?? <DataPart {...part} displayPresentation="full" />)
      );
    case "reasoning":
      return <AssistantReasoningPart />;
    case "source":
      return <AssistantSourcePart {...part} />;
    case "image":
      return <ImagePart />;
    case "file":
      return <FilePart />;
    default:
      return null;
  }
}

function AssistantWorkTimeline({
  items,
  partComponents
}: {
  items: readonly AssistantWorkTimelineItem[];
  partComponents: Parameters<typeof MessagePrimitive.PartByIndex>[0]["components"];
}) {
  const messageParts = useAuiState((state) => state.message.parts);

  return (
    <div className="chat-work-timeline">
      {items.map((item) => {
        if (item.type === "tool-group") {
          const renderableIndices = createRenderableAssistantToolGroupIndices(
            messageParts,
            item.indices
          );
          return (
            <AssistantWorkGroup
              key={`tool-group-${item.indices[0]}`}
              count={renderableIndices.length}
              only={onlyToolCall(messageParts, renderableIndices)}
              last={lastToolCall(messageParts, renderableIndices)}
              toolCallIds={toolCallIdsOf(messageParts, renderableIndices)}
              nested
              summary={false}
            >
              {renderableIndices.map((index) => (
                <MessagePrimitive.PartByIndex
                  key={`part-${index}`}
                  index={index}
                  components={partComponents}
                />
              ))}
            </AssistantWorkGroup>
          );
        }
        if (item.type === "source-group") {
          return (
            <div key={`source-group-${item.indices[0]}`} className="chat-source-chip-group">
              {item.indices.map((index) => (
                <MessagePrimitive.PartByIndex
                  key={`part-${index}`}
                  index={index}
                  components={partComponents}
                />
              ))}
            </div>
          );
        }
        return (
          <MessagePrimitive.PartByIndex
            key={`part-${item.index}`}
            index={item.index}
            components={partComponents}
          />
        );
      })}
    </div>
  );
}

/** How long the work history of a run that just ended stays open before it folds itself. */
const WORK_SUMMARY_AUTO_COLLAPSE_DELAY_MS = 80;

type ToolCallPartState = Extract<PartState, { type: "tool-call" }>;

/** The one tool call of a group that holds a single call. */
function onlyToolCall(
  parts: readonly PartState[],
  indices: readonly number[]
): ToolCallPartState | undefined {
  const part = indices.length === 1 ? parts[indices[0] ?? -1] : undefined;
  return part?.type === "tool-call" ? part : undefined;
}

/** The last tool call of a group. */
function lastToolCall(
  parts: readonly PartState[],
  indices: readonly number[]
): ToolCallPartState | undefined {
  for (let position = indices.length - 1; position >= 0; position -= 1) {
    const part = parts[indices[position] ?? -1];
    if (part?.type === "tool-call") {
      return part;
    }
  }
  return undefined;
}

/** The tool calls of a group. */
function toolCallIdsOf(parts: readonly PartState[], indices: readonly number[]): string[] {
  return indices.flatMap((index) => {
    const part = parts[index];
    return part?.type === "tool-call" ? [part.toolCallId] : [];
  });
}

function AssistantWorkGroup({
  count,
  only,
  last,
  toolCallIds = [],
  children,
  nested = false,
  summary,
  durationMs,
  autoCollapse = false
}: {
  count: number;
  /** The group's one tool call, where it holds a single call. */
  only?: ToolCallPartState;
  /** The group's last tool call. */
  last?: ToolCallPartState;
  /** The group's tool calls: one that waits for a decision keeps the group open. */
  toolCallIds?: readonly string[];
  children: ReactNode;
  nested?: boolean;
  summary: boolean;
  durationMs?: number;
  autoCollapse?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(autoCollapse);
  const [suppressOpenAnimation, setSuppressOpenAnimation] = useState(autoCollapse);
  // A call that waits for a decision shows its card, so the person sees what to answer.
  const waitsForDecision = useWaitsForDecision(toolCallIds);

  // The whole timer lives in this effect, so a second run of it, as StrictMode makes one,
  // starts the timer its cleanup has just cleared.
  useEffect(() => {
    if (!summary || !autoCollapse) {
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      setSuppressOpenAnimation(false);
      setOpen(false);
    }, WORK_SUMMARY_AUTO_COLLAPSE_DELAY_MS);
    return () => globalThis.clearTimeout(timeout);
  }, [autoCollapse, summary]);

  const countLabel = summary ? (
    formatWorkHistoryLabel(t("workHistory"), durationMs)
  ) : (
    <ToolCallFoldLabel only={only} last={last} count={count} />
  );

  return (
    <ToolGroupRoot
      // A leading group uses the message container's uniform top spacing.
      // Later groups own their top margin; whatever follows owns the spacing below.
      className={cn(
        "chat-tool-work max-w-5xl",
        nested ? "chat-tool-work-nested my-0" : "mt-4 first:mt-0"
      )}
      open={open || waitsForDecision}
      onOpenChange={setOpen}
      variant="ghost"
    >
      <ToolGroupTrigger
        data-testid="assistant-work-group-trigger"
        count={count}
        label={countLabel}
      />
      <ToolGroupContent
        className={cn(
          summary && "chat-work-summary-content",
          suppressOpenAnimation && "chat-tool-group-suppress-open-animation"
        )}
      >
        {children}
      </ToolGroupContent>
    </ToolGroupRoot>
  );
}

function UserMessage() {
  const { t } = useTranslation();
  const messageId = useAuiState((state) => state.message.id);
  const activeAnchorId = useThreadViewport((state) => state.topAnchorTurn?.anchorId);
  const viewportStore = useThreadViewportStore();
  const anchorMarkerRef = useRef<HTMLDivElement>(null);

  // Offset the viewport's scroll target without adding space between turns.
  useLayoutEffect(() => {
    const marker = anchorMarkerRef.current;
    if (!marker || messageId !== activeAnchorId) return;
    return viewportStore.getState().registerAnchorElement(marker);
  }, [activeAnchorId, messageId, viewportStore]);

  return (
    <MessagePrimitive.Root
      className="group/message relative mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] justify-items-end gap-1 animate-in fade-in slide-in-from-bottom-1 duration-150"
      data-role="user"
    >
      <div
        ref={anchorMarkerRef}
        className="pointer-events-none absolute inset-x-0 h-full"
        style={{ top: "calc(-1 * clamp(100px, 20dvh, 250px))" }}
        data-message-id={messageId}
        aria-hidden="true"
      />
      <MessageAttachments />
      <div className="chat-user-message-bubble max-w-[min(42rem,88%)] rounded-2xl rounded-tr-md bg-secondary px-4 py-2.5 text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
        <CollapsibleUserContent>
          <MessagePrimitive.Parts
            components={{ Text: UserTextPart, File: FilePart, Image: ImagePart }}
          />
        </CollapsibleUserContent>
      </div>
      <div className="flex min-h-8 items-center gap-1 opacity-100 md:absolute md:right-0 md:top-full md:opacity-0 md:transition-opacity md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100">
        <ActionBarPrimitive.Copy asChild>
          <IconButton label={t("copy")}>
            <CopiedState />
          </IconButton>
        </ActionBarPrimitive.Copy>
      </div>
    </MessagePrimitive.Root>
  );
}

const USER_MESSAGE_COLLAPSED_HEIGHT = 240;
// Only collapse when it hides a meaningful amount; a few extra lines stay visible.
const USER_MESSAGE_COLLAPSE_THRESHOLD = 320;

/** Long pasted messages stay one click away so the thread keeps its shape. */
function CollapsibleUserContent({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setOverflowing(content.scrollHeight > USER_MESSAGE_COLLAPSE_THRESHOLD);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const collapsed = overflowing && !expanded;

  return (
    <div className="grid min-w-0 gap-1.5">
      <div
        ref={contentRef}
        className="min-w-0 overflow-hidden"
        style={
          collapsed
            ? {
                maxHeight: USER_MESSAGE_COLLAPSED_HEIGHT,
                maskImage: "linear-gradient(to bottom, black 70%, transparent)"
              }
            : undefined
        }
      >
        {children}
      </div>
      {overflowing ? (
        <button
          type="button"
          className="w-fit cursor-pointer rounded-sm text-xs font-medium underline underline-offset-2 opacity-90 hover:opacity-100 focus-visible:focus-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("showLess") : t("showMore")}
        </button>
      ) : null}
    </div>
  );
}

function UserTextPart() {
  return <MarkdownText />;
}

function AssistantTextPart() {
  // An empty text part still carries the adjacency margins from styles.css,
  // which reads as a large blank gap while the next tokens are pending.
  const empty = useAuiState(
    (state) => state.part.type === "text" && state.part.text.trim().length === 0
  );

  if (empty) {
    return null;
  }

  return (
    <div className="chat-assistant-text max-w-3xl">
      <MarkdownText />
    </div>
  );
}

// Reasoning has no visible body of its own; the thread's activity row reports it.
function AssistantReasoningPart() {
  return null;
}

function CopiedState() {
  const isCopied = useAuiState((state) => state.message.isCopied);
  return isCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />;
}

function MessageError() {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        <ErrorPrimitive.Message />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}
