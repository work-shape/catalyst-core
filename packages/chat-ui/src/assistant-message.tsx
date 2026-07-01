import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  useAuiState,
  type PartState
} from "@assistant-ui/react";
import { Check, Copy, FileText, ImageIcon, Pencil, RefreshCw, User } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AssistantCursor } from "./assistant-cursor";
import { AttachmentPreview } from "./attachment-preview";
import { managedFileIdFromUrl, useAttachmentContentContext } from "./attachment-content";
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
import type { AssistantUiMessageMetadata } from "./assistant-ui-adapter";
import { AssistantSourcePart } from "./assistant-source-part";
import { useTranslation } from "./i18n";
import { MarkdownText } from "./markdown-text";
import { DataPart, ToolCallPart } from "./tool-call";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "./assistant-tool-group";
import { TooltipIconButton, tooltipIconButtonClassName } from "./tooltip-icon-button";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

const chronologicalAssistantMessageGroupBy = createAssistantMessageGroupBy();
const recentlyActiveAssistantRunIds = new Set<string>();

export function ThreadMessage({
  conversationRunning,
  activeRunId,
  optimisticPending: _optimisticPending
}: {
  conversationRunning?: boolean;
  activeRunId?: string;
  optimisticPending?: boolean;
}) {
  const role = useAuiState((state) => state.message.role);
  const isEditing = useAuiState((state) => state.message.composer.isEditing);

  if (isEditing) {
    return <DisabledEditComposer />;
  }

  if (role === "user") {
    return <UserMessage />;
  }

  return (
    <AssistantMessage activeRunId={activeRunId} conversationRunning={conversationRunning} />
  );
}

function AssistantMessage({
  activeRunId,
  conversationRunning
}: {
  activeRunId?: string;
  conversationRunning?: boolean;
}) {
  const { t } = useTranslation();
  const messageId = useAuiState((state) => state.message.id);
  const messageParts = useAuiState((state) => state.message.parts);
  const activeRunProjectionMessage = useAuiState(
    (state) => (state.message.metadata as AssistantUiMessageMetadata | undefined)?.source === "active-run"
  );
  const completedRunId = useAuiState(
    (state) => (state.message.metadata as AssistantUiMessageMetadata | undefined)?.completedRunId
  );
  const lastPartIndex = useAuiState((state) => state.message.parts.length - 1);
  const activeRunMessage = Boolean(conversationRunning && activeRunId && messageId === activeRunId);
  const messageRunning = useAuiState(
    (state) =>
      state.message.role === "assistant" &&
      (state.message.status?.type === "running" || activeRunMessage)
  );
  const finalTextIndex = findFinalAssistantTextPartIndex(messageParts);
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
  const [autoCollapseCompletedWorkSummary] = useState(() => {
    if (!completedRunId || !recentlyActiveAssistantRunIds.has(completedRunId)) {
      return false;
    }
    recentlyActiveAssistantRunIds.delete(completedRunId);
    return true;
  });
  const assistantPartComponents = useAssistantPartComponents(activeRunMessage, {
    autoPreviewSurfaces: autoCollapseCompletedWorkSummary,
    displayPresentation: "full"
  });
  const completedWorkPartComponents = useAssistantPartComponents(activeRunMessage, {
    autoPreviewSurfaces: false,
    displayPresentation: "summary"
  });
  const showFallbackCursor = useAuiState((state) => {
    if (
      state.message.role !== "assistant" ||
      (state.message.status?.type !== "running" && !activeRunMessage)
    ) {
      return false;
    }
    return (
      !state.message.parts.some(partShowsOwnActivity) &&
      !state.message.parts.some(partHasVisibleAssistantContent)
    );
  });
  useEffect(() => {
    if (activeRunProjectionMessage) {
      rememberRecentlyActiveAssistantRunId(messageId);
    }
  }, [activeRunProjectionMessage, messageId]);

  return (
    <MessagePrimitive.Root
      className="group/message mx-auto w-full max-w-5xl animate-in fade-in slide-in-from-bottom-1 duration-150"
      data-role="assistant"
    >
      <div className="min-w-0 rounded-md px-1 py-1 text-sm leading-6">
        {showFallbackCursor ? <AssistantFallbackCursor /> : null}
        {completedWorkSummary ? (
          <>
            <AssistantWorkGroup
              count={completedWorkStepCount}
              active={false}
              summary
              autoCollapse={autoCollapseCompletedWorkSummary}
            >
              <AssistantWorkTimeline
                activeRunMessage={activeRunMessage}
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
                activeRunMessage,
                assistantPartComponents,
                lastPartIndex,
                messageParts
              })}
          </MessagePrimitive.GroupedParts>
        )}
        <MessageError />
      </div>
      {!messageRunning ? (
        <div className="mt-1 flex min-h-8 items-center gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100">
          <ActionBarPrimitive.Copy className={tooltipIconButtonClassName} title={t("copy")} aria-label={t("copy")}>
            <CopiedState />
          </ActionBarPrimitive.Copy>
          <TooltipIconButton tooltip={t("regenerateResponse")} disabled>
            <RefreshCw aria-hidden="true" />
          </TooltipIconButton>
        </div>
      ) : null}
    </MessagePrimitive.Root>
  );
}

function useAssistantPartComponents(
  activeRunMessage: boolean,
  options: {
    autoPreviewSurfaces: boolean;
    displayPresentation: "full" | "summary";
  }
) {
  return useMemo(
    () => createAssistantPartComponents(activeRunMessage, options),
    [activeRunMessage, options.autoPreviewSurfaces, options.displayPresentation]
  );
}

function createAssistantPartComponents(
  activeRunMessage: boolean,
  options: {
    autoPreviewSurfaces: boolean;
    displayPresentation: "full" | "summary";
  }
): Parameters<typeof MessagePrimitive.PartByIndex>[0]["components"] {
  return {
    Text: () => <AssistantTextPart active={activeRunMessage} />,
    Reasoning: () => <AssistantReasoningPart activeRunMessage={activeRunMessage} />,
    Source: AssistantSourcePart,
    Image: ImagePart,
    File: FilePart,
    tools: {
      Override: (part) => (
        <ToolCallPart
          {...part}
          displayPresentation={options.displayPresentation}
        />
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
  activeRunMessage,
  assistantPartComponents,
  lastPartIndex,
  messageParts
}: AssistantGroupedRenderInfo & {
  activeRunMessage: boolean;
  assistantPartComponents: Parameters<typeof MessagePrimitive.PartByIndex>[0]["components"];
  lastPartIndex: number;
  messageParts: readonly PartState[];
}) {
  switch (part.type) {
    case ASSISTANT_WORK_GROUP:
      const renderableIndices = createRenderableAssistantToolGroupIndices(messageParts, part.indices);
      return (
        <AssistantWorkGroup
          count={renderableIndices.length}
          active={part.status.type === "running" || (activeRunMessage && renderableIndices.includes(lastPartIndex))}
          indices={renderableIndices}
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
      return <AssistantTextPart active={activeRunMessage} />;
    case "tool-call":
      return part.toolUI ?? <ToolCallPart {...part} displayPresentation="full" />;
    case "data":
      return part.dataRendererUI ?? <DataPart {...part} displayPresentation="full" />;
    case "reasoning":
      return <AssistantReasoningPart activeRunMessage={activeRunMessage} />;
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
  activeRunMessage,
  items,
  partComponents
}: {
  activeRunMessage: boolean;
  items: readonly AssistantWorkTimelineItem[];
  partComponents: Parameters<typeof MessagePrimitive.PartByIndex>[0]["components"];
}) {
  const messageParts = useAuiState((state) => state.message.parts);

  return (
    <div className="chat-work-timeline">
      {items.map((item) => {
        if (item.type === "tool-group") {
          const renderableIndices = createRenderableAssistantToolGroupIndices(messageParts, item.indices);
          return (
            <AssistantWorkGroup
              key={`tool-group-${item.indices[0]}`}
              count={renderableIndices.length}
              active={activeRunMessage && renderableIndices.some((index) => messageParts[index]?.status?.type === "running")}
              indices={renderableIndices}
              nested
              summary={false}
            >
              {renderableIndices.map((index) => (
                <MessagePrimitive.PartByIndex key={`part-${index}`} index={index} components={partComponents} />
              ))}
            </AssistantWorkGroup>
          );
        }
        if (item.type === "source-group") {
          return (
            <div key={`source-group-${item.indices[0]}`} className="chat-source-chip-group">
              {item.indices.map((index) => (
                <MessagePrimitive.PartByIndex key={`part-${index}`} index={index} components={partComponents} />
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

function AssistantWorkGroup({
  count,
  active,
  children,
  indices = [],
  nested = false,
  summary,
  autoCollapse = false
}: {
  count: number;
  active: boolean;
  children: ReactNode;
  indices?: readonly number[];
  nested?: boolean;
  summary: boolean;
  autoCollapse?: boolean;
}) {
  const { t } = useTranslation();
  const hasDisplay = useAuiState((state) =>
    !summary && indices.some((index) => partHasDisplay(state.message.parts[index]))
  );
  const [open, setOpen] = useState(autoCollapse);
  const [suppressOpenAnimation, setSuppressOpenAnimation] = useState(autoCollapse);
  const openedForDisplayRef = useRef(false);
  const autoCollapseStartedRef = useRef(false);

  useEffect(() => {
    if (summary || !hasDisplay || openedForDisplayRef.current) {
      return;
    }
    openedForDisplayRef.current = true;
    setOpen(true);
  }, [hasDisplay, summary]);

  useEffect(() => {
    if (!summary || !autoCollapse || autoCollapseStartedRef.current) {
      return;
    }
    autoCollapseStartedRef.current = true;
    const timeout = globalThis.setTimeout(() => {
      setSuppressOpenAnimation(false);
      setOpen(false);
    }, 80);
    return () => globalThis.clearTimeout(timeout);
  }, [autoCollapse, summary]);

  const countLabel = summary
    ? t(count === 1 ? "workStepCountSingular" : "workStepCount", { count })
    : t(count === 1 ? "toolCallCountSingular" : "toolCallCount", { count });

  return (
    <ToolGroupRoot
      className={cn("chat-tool-work max-w-5xl", nested ? "chat-tool-work-nested my-0" : "my-4")}
      open={open}
      onOpenChange={setOpen}
      variant="ghost"
    >
      <ToolGroupTrigger
        data-testid="assistant-work-group-trigger"
        active={active}
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

function partHasDisplay(part: unknown): boolean {
  if (!isRecord(part) || part.type !== "tool-call" || !isRecord(part.result)) {
    return false;
  }
  return isRecord(part.result.display);
}

function partShowsOwnActivity(part: unknown): boolean {
  if (!isRecord(part)) {
    return false;
  }
  const type = typeof part.type === "string" ? part.type : undefined;
  const status = isRecord(part.status) && typeof part.status.type === "string" ? part.status.type : undefined;
  if (type === "reasoning" && status === "running") {
    return true;
  }
  if (type === "text") {
    return status === "running" && typeof part.text === "string" && part.text.trim().length > 0;
  }
  return status === "running";
}

function partHasVisibleAssistantContent(part: unknown): boolean {
  if (!isRecord(part)) {
    return false;
  }
  const type = typeof part.type === "string" ? part.type : undefined;
  if (type === "text") {
    return typeof part.text === "string" && part.text.trim().length > 0;
  }
  if (type === "indicator" || type === "step-start") {
    return false;
  }
  if (type === "reasoning") {
    return typeof part.text === "string" && part.text.trim().length > 0;
  }
  return true;
}

function rememberRecentlyActiveAssistantRunId(runId: string): void {
  recentlyActiveAssistantRunIds.delete(runId);
  recentlyActiveAssistantRunIds.add(runId);
  if (recentlyActiveAssistantRunIds.size <= 20) {
    return;
  }
  const oldestRunId = recentlyActiveAssistantRunIds.values().next().value;
  if (typeof oldestRunId === "string") {
    recentlyActiveAssistantRunIds.delete(oldestRunId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function UserMessage() {
  const { t } = useTranslation();

  return (
    <MessagePrimitive.Root
      className="group/message mx-auto grid w-full max-w-3xl justify-items-end gap-1 animate-in fade-in slide-in-from-bottom-1 duration-150"
      data-role="user"
    >
      <MessagePrimitive.Attachments>{() => <AttachmentPreview removable={false} />}</MessagePrimitive.Attachments>
      <div className="max-w-[min(42rem,88%)] rounded-2xl rounded-tr-md bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground shadow-xs [overflow-wrap:anywhere]">
        <MessagePrimitive.Parts components={{ Text: UserTextPart, File: FilePart, Image: ImagePart }} />
      </div>
      <div className="flex min-h-8 items-center gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100">
        <ActionBarPrimitive.Copy className={tooltipIconButtonClassName} title={t("copy")} aria-label={t("copy")}>
          <CopiedState />
        </ActionBarPrimitive.Copy>
        <TooltipIconButton tooltip={t("editMessage")} disabled>
          <Pencil aria-hidden="true" />
        </TooltipIconButton>
      </div>
    </MessagePrimitive.Root>
  );
}

function UserTextPart() {
  return <MarkdownText />;
}

function AssistantTextPart({ active }: { active?: boolean }) {
  const showCursor = useAuiState((state) => {
    if (
      state.part.type !== "text" ||
      (state.part.status.type !== "running" && !active) ||
      state.part.text.trim().length === 0
    ) {
      return false;
    }

    const lastPart = state.message.parts.at(-1);
    return (
      lastPart?.type === "text" &&
      lastPart.text === state.part.text &&
      (lastPart.status.type === "running" || active)
    );
  });

  return (
    <div className={cn("chat-assistant-text max-w-3xl", showCursor && "chat-assistant-text-running")}>
      <MarkdownText />
    </div>
  );
}

function AssistantFallbackCursor() {
  return (
    <div className="chat-assistant-text max-w-3xl">
      <AssistantCursor className="my-1" />
    </div>
  );
}

function AssistantReasoningPart({ activeRunMessage }: { activeRunMessage?: boolean }) {
  const { t } = useTranslation();
  const active = useAuiState((state) => {
    if (state.part.status.type === "running") {
      return true;
    }
    const lastPart = state.message.parts.at(-1);
    return activeRunMessage && lastPart === state.part;
  });

  if (!active) {
    return null;
  }

  return (
    <div className="chat-assistant-text my-1 flex min-h-6 max-w-3xl items-center text-sm" role="status" aria-live="polite">
      <span className="chat-reasoning-status leading-6">{t("thinking")}</span>
    </div>
  );
}

function CopiedState() {
  const isCopied = useAuiState((state) => state.message.isCopied);
  return isCopied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />;
}

function FilePart() {
  const file = useAuiState((state) => (state.part.type === "file" ? state.part : undefined));
  if (!file) {
    return null;
  }
  const mimeType = filePartMimeType(file);
  const url = filePartUrl(file);
  if (isSupportedImageMimeType(mimeType)) {
    return <ImageFilePart data={url} filename={file.filename} mimeType={mimeType} />;
  }
  return (
    <div className="my-2 inline-flex max-w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm shadow-xs">
      <FileText size={16} aria-hidden="true" className="text-muted-foreground" />
      <span className="truncate">{file.filename ?? mimeType ?? "file"}</span>
    </div>
  );
}

function ImagePart() {
  const image = useAuiState((state) => (state.part.type === "image" ? state.part : undefined));
  if (!image) {
    return null;
  }
  return (
    <div className="my-2 overflow-hidden rounded-md border bg-card shadow-xs">
      <MessagePartPrimitive.Image
        alt={image.filename ?? "Attached image"}
        className="max-h-96 w-auto max-w-full object-contain"
      />
    </div>
  );
}

function ImageFilePart({
  data,
  filename,
  mimeType
}: {
  data: string;
  filename?: string;
  mimeType: string;
}) {
  const attachmentContent = useAttachmentContentContext();
  const attachmentClient = attachmentContent?.client;
  const selectedConversationId = attachmentContent?.selectedConversationId;
  const [imageUrl, setImageUrl] = useState<string | undefined>(() =>
    isDirectImageUrl(data) ? data : undefined
  );

  useEffect(() => {
    if (isDirectImageUrl(data)) {
      setImageUrl(data);
      return undefined;
    }

    const fileId = managedFileIdFromUrl(data);
    if (!fileId || !attachmentClient || !selectedConversationId) {
      setImageUrl(undefined);
      return undefined;
    }

    let active = true;
    let objectUrl: string | undefined;
    void attachmentClient
      .conversationFileContent(selectedConversationId, fileId)
      .then((blob) => {
        if (!active) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (active) {
          setImageUrl(undefined);
        }
      });

    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [attachmentClient, data, selectedConversationId]);

  if (!imageUrl) {
    return (
      <div className="my-2 inline-flex max-w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm shadow-xs">
        <ImageIcon size={16} aria-hidden="true" className="text-muted-foreground" />
        <span className="truncate">{filename ?? mimeType}</span>
      </div>
    );
  }

  return (
    <figure className="my-2 grid gap-1 overflow-hidden rounded-md border bg-card p-1 shadow-xs">
      <img src={imageUrl} alt={filename ?? "Attached image"} className="max-h-96 w-auto max-w-full rounded object-contain" />
      {filename ? <figcaption className="truncate px-1 pb-1 text-xs text-muted-foreground">{filename}</figcaption> : null}
    </figure>
  );
}

function isDirectImageUrl(value: string | undefined): value is string {
  return Boolean(value && /^(https:\/\/|blob:|data:image\/)/u.test(value));
}

function isSupportedImageMimeType(value: string | undefined): value is string {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

function filePartMimeType(file: {
  mediaType?: string;
  mimeType?: string;
}): string | undefined {
  return file.mediaType ?? file.mimeType;
}

function filePartUrl(file: {
  url?: string;
  data?: unknown;
}): string {
  if (typeof file.url === "string") {
    return file.url;
  }
  return typeof file.data === "string" ? file.data : "";
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

function DisabledEditComposer() {
  const { t } = useTranslation();

  return (
    <MessagePrimitive.Root className="mx-auto w-full max-w-3xl">
      <ComposerPrimitive.Root className="grid gap-2 rounded-md border bg-muted/50 p-3">
        <ComposerPrimitive.Input
          className="min-h-20 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          disabled
        />
        <div className="flex justify-end gap-2">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm">
              {t("cancel")}
            </Button>
          </ComposerPrimitive.Cancel>
          <Button size="sm" disabled>
            {t("update")}
          </Button>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}
