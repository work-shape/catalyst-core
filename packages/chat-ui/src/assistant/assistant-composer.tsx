import { ComposerPrimitive, useAuiState, useComposer } from "@assistant-ui/react";
import { AlertCircle, CheckCircle2, Paperclip, RotateCcw, Send, Square, X } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { DraftAttachment } from "@vivd-catalyst/api-client";
import { Button, cn, Spinner } from "@vivd-catalyst/ui";
import type { AgentSelectableModel, ReasoningEffort } from "../workspace/agent-model-selection";
import { AttachmentPreview } from "../attachment-preview";
import { ContextIndicator } from "./context-indicator";
import { ModelPicker } from "./model-picker";
import { useTranslation, type TranslationContextValue } from "../i18n";
import type { SendBlock } from "./send-block";
import { isComposerBlockedByActiveRun, shouldShowCancelAction } from "./thread-activity";

export interface LocalUploadingAttachment {
  id: string;
  filename: string;
  byteSize: number;
  mimeType?: string;
  status: "uploading";
}

export function AssistantComposer({
  attachments,
  localUploadingAttachments,
  sendBlock,
  sendQueued,
  conversationRunning,
  optimisticPending,
  attachmentsEnabled,
  attachmentAccept,
  selectableModels,
  selectedModelBindingId,
  selectedReasoningEffort,
  showContextIndicator,
  contextSnapshot,
  focusRequestId,
  onCancelRun,
  onSelectModelBinding,
  onSelectReasoningEffort,
  onFilesSelected,
  onRemoveAttachment,
  onRetryAttachment,
  onQueueSend,
  onSubmitMessage
}: {
  attachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  sendBlock?: SendBlock;
  /** A send is waiting for a loading block to lift. */
  sendQueued: boolean;
  conversationRunning?: boolean;
  optimisticPending?: boolean;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
  /** The active agent's own model first, then the models users may pick instead. */
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
  focusRequestId: number;
  onCancelRun: () => void;
  onSelectModelBinding: (modelBindingId: string) => void;
  onSelectReasoningEffort: (modelBindingId: string, effort: ReasoningEffort) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onRetryAttachment: (attachmentId: string) => void;
  /** Remembers a send asked for during a loading block; it goes out once the block lifts. */
  onQueueSend: (text: string) => void;
  onSubmitMessage?: (text: string) => boolean;
}) {
  const { t } = useTranslation();
  const currentText = useComposer((state) => state.text);
  const composerShellRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentActionRef = useRef<HTMLButtonElement | null>(null);
  const composerControlsRef = useRef<HTMLDivElement | null>(null);
  const previousComposerLayoutRef = useRef<ComposerLayoutSnapshot | null>(null);
  const composerLayoutAnimationsRef = useRef<Animation[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasAttachments = attachments.length > 0 || localUploadingAttachments.length > 0;
  const submitBlocked = Boolean(sendBlock);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const queueSend = useCallback(() => {
    if (shouldQueueSend({ sendBlock, sendQueued, text: currentText })) {
      onQueueSend(currentText);
    }
  }, [currentText, onQueueSend, sendBlock, sendQueued]);
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (submitBlocked) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (onSubmitMessage?.(currentText)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [currentText, onSubmitMessage, submitBlocked]
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.nativeEvent.isComposing
      ) {
        return;
      }

      if (submitBlocked) {
        event.preventDefault();
        queueSend();
        return;
      }
      if (!onSubmitMessage) {
        return;
      }

      event.preventDefault();
      onSubmitMessage(currentText);
    },
    [currentText, onSubmitMessage, queueSend, submitBlocked]
  );

  useLayoutEffect(() => {
    if (focusRequestId === 0) {
      return;
    }

    let cancelled = false;
    const animationFrameIds: number[] = [];
    const timeoutIds: number[] = [];

    function focusInput() {
      if (cancelled) {
        return;
      }
      const input = composerInputRef.current;
      if (!input || input.disabled) {
        return;
      }
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }

    focusInput();
    animationFrameIds.push(window.requestAnimationFrame(focusInput));
    timeoutIds.push(window.setTimeout(focusInput, 0));
    timeoutIds.push(window.setTimeout(focusInput, 50));

    return () => {
      cancelled = true;
      for (const frameId of animationFrameIds) {
        window.cancelAnimationFrame(frameId);
      }
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [focusRequestId]);

  useLayoutEffect(() => {
    const shell = composerShellRef.current;
    const input = composerInputRef.current;
    const controls = composerControlsRef.current;
    if (!shell || !input || !controls) {
      return;
    }

    const updateExpandedState = () => {
      const compactInputWidth = getCompactComposerInputWidth(
        shell,
        attachmentActionRef.current,
        controls,
        attachmentsEnabled
      );
      setComposerExpanded(
        shouldExpandComposer(currentText, textareaWrapsAtWidth(input, compactInputWidth))
      );
    };

    updateExpandedState();
    const resizeObserver = new ResizeObserver(updateExpandedState);
    resizeObserver.observe(shell);
    resizeObserver.observe(controls);
    return () => resizeObserver.disconnect();
  }, [attachmentsEnabled, currentText]);

  // Grid placement changes immediately; replay the previous screen position so
  // the input and controls glide into their new rows instead of snapping.
  useLayoutEffect(() => {
    const input = composerInputRef.current;
    const controls = composerControlsRef.current;
    if (!input || !controls) {
      return;
    }

    const nextLayout: ComposerLayoutSnapshot = {
      expanded: composerExpanded,
      input: input.getBoundingClientRect(),
      attachment: attachmentActionRef.current?.getBoundingClientRect(),
      controls: controls.getBoundingClientRect()
    };
    const previousLayout = previousComposerLayoutRef.current;
    previousComposerLayoutRef.current = nextLayout;

    if (
      !previousLayout ||
      previousLayout.expanded === composerExpanded ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    for (const animation of composerLayoutAnimationsRef.current) {
      animation.cancel();
    }

    composerLayoutAnimationsRef.current = [
      animateComposerLayoutShift(input, previousLayout.input, nextLayout.input, composerExpanded),
      attachmentActionRef.current && previousLayout.attachment && nextLayout.attachment
        ? animateComposerLayoutShift(
            attachmentActionRef.current,
            previousLayout.attachment,
            nextLayout.attachment
          )
        : undefined,
      animateComposerLayoutShift(controls, previousLayout.controls, nextLayout.controls)
    ].filter((animation): animation is Animation => Boolean(animation));
  });

  return (
    <ComposerPrimitive.Root className="relative grid w-full gap-2" onSubmitCapture={handleSubmit}>
      <ComposerPrimitive.Attachments>
        {() => <AttachmentPreview removable />}
      </ComposerPrimitive.Attachments>
      {hasAttachments ? (
        <DraftAttachmentList
          attachments={attachments}
          localUploadingAttachments={localUploadingAttachments}
          onRemoveAttachment={onRemoveAttachment}
          onRetryAttachment={onRetryAttachment}
        />
      ) : null}
      <ComposerPrimitive.AttachmentDropzone disabled asChild>
        <div
          ref={composerShellRef}
          className={cn(
            "grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-1 rounded-xl border bg-popover p-1.5 shadow-raised transition-colors",
            // The composer holds the focus most of the time: its line steps up and no ring shows.
            "focus-within:border-input"
          )}
        >
          {attachmentsEnabled ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                multiple
                accept={attachmentAccept}
                onChange={(event) => {
                  const files = [...(event.currentTarget.files ?? [])];
                  event.currentTarget.value = "";
                  if (files.length > 0) {
                    onFilesSelected(files);
                  }
                }}
              />
              <Button
                ref={attachmentActionRef}
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "col-start-1 size-9 shrink-0 rounded-full text-muted-foreground",
                  composerExpanded ? "row-start-2" : "row-start-1"
                )}
                title={t("addAttachment")}
                aria-label={t("addAttachment")}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={16} aria-hidden="true" />
              </Button>
            </>
          ) : null}
          <ComposerPrimitive.Input
            ref={composerInputRef}
            className={cn(
              "row-start-1 max-h-40 min-h-9 min-w-0 resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground",
              attachmentsEnabled ? "col-start-2" : "col-span-2 col-start-1",
              composerExpanded && "col-span-3 col-start-1 min-h-12 w-full"
            )}
            placeholder={t("messagePlaceholder")}
            rows={1}
            submitMode={onSubmitMessage ? "none" : "enter"}
            onKeyDown={handleKeyDown}
          />
          <div
            ref={composerControlsRef}
            className={cn(
              "col-start-3 flex min-w-0 items-end gap-1",
              composerExpanded ? "row-start-2" : "row-start-1"
            )}
          >
            {showContextIndicator && contextSnapshot ? (
              // Pulled towards the model picker, whose own padding already sets them apart.
              <div className="-mr-1.5 flex h-9 shrink-0 items-center">
                <ContextIndicator
                  inputTokens={contextSnapshot.inputTokens}
                  compactThresholdTokens={contextSnapshot.compactThresholdTokens}
                />
              </div>
            ) : null}
            <ModelPicker
              models={selectableModels}
              selectedModelBindingId={selectedModelBindingId}
              reasoningEffort={selectedReasoningEffort}
              disabled={conversationRunning}
              onSelectModelBinding={onSelectModelBinding}
              onSelectReasoningEffort={onSelectReasoningEffort}
            />
            <ComposerAction
              sendBlock={sendBlock}
              sendQueued={sendQueued}
              conversationRunning={conversationRunning}
              optimisticPending={optimisticPending}
              currentText={currentText}
              onCancelRun={onCancelRun}
              onQueueSend={queueSend}
              onSubmitMessage={onSubmitMessage}
            />
          </div>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
}

type AttachmentChipStatus = DraftAttachment["status"] | LocalUploadingAttachment["status"];

interface AttachmentChipItem {
  id: string;
  filename: string;
  byteSize: number;
  status: AttachmentChipStatus;
  removable: boolean;
  retryable: boolean;
}

const ATTACHMENT_FADE_HEIGHT = "1rem";

function DraftAttachmentList({
  attachments,
  localUploadingAttachments,
  onRemoveAttachment,
  onRetryAttachment
}: {
  attachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  onRemoveAttachment: (attachmentId: string) => void;
  onRetryAttachment: (attachmentId: string) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ above: false, below: false });

  const items: AttachmentChipItem[] = [
    ...localUploadingAttachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      byteSize: attachment.byteSize,
      status: attachment.status,
      removable: false,
      retryable: false
    })),
    ...attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      byteSize: attachment.byteSize,
      status: attachment.status,
      removable: true,
      retryable: attachment.status === "failed"
    }))
  ].sort(
    (left, right) => attachmentAttentionRank(left.status) - attachmentAttentionRank(right.status)
  );

  const totalBytes = items.reduce((sum, item) => sum + item.byteSize, 0);
  const failedCount = items.filter(
    (item) => item.status === "failed" || item.status === "unsupported"
  ).length;

  const syncOverflow = useCallback(() => {
    const node = listRef.current;
    if (!node) {
      return;
    }
    const above = node.scrollTop > 1;
    const below = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    setOverflow((previous) =>
      previous.above === above && previous.below === below ? previous : { above, below }
    );
  }, []);

  useLayoutEffect(() => {
    syncOverflow();
    const node = listRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(node);
    return () => observer.disconnect();
  }, [syncOverflow, items.length]);

  return (
    <div className="grid gap-1.5">
      {items.length > 1 ? (
        <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <Paperclip size={13} className="shrink-0" aria-hidden="true" />
            <span className="truncate">
              {items.length === 1
                ? t("attachmentsSummaryOne", { size: formatFileSize(totalBytes) })
                : t("attachmentsSummary", {
                    count: items.length,
                    size: formatFileSize(totalBytes)
                  })}
              {failedCount > 0 ? ` · ${t("attachmentsFailedCount", { count: failedCount })}` : null}
            </span>
          </span>
          {attachments.length > 1 ? (
            <button
              type="button"
              className="shrink-0 rounded px-1 py-0.5 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
              onClick={() => {
                for (const attachment of attachments) {
                  onRemoveAttachment(attachment.id);
                }
              }}
            >
              {t("attachmentsRemoveAll")}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* Paint containment keeps offscreen grid rows out of the thread's
          scrollable overflow while this nested list remains scrollable. */}
      <div className="max-h-36 overflow-hidden [contain:paint]">
        <div
          ref={listRef}
          className="grid max-h-36 gap-1.5 overflow-y-auto sm:grid-cols-2"
          style={{
            scrollbarWidth: "thin",
            scrollbarColor: "var(--border) transparent",
            maskImage: attachmentFadeMask(overflow),
            WebkitMaskImage: attachmentFadeMask(overflow)
          }}
          onScroll={syncOverflow}
        >
          {items.map((item) => (
            <AttachmentChip
              key={item.id}
              filename={item.filename}
              byteSize={item.byteSize}
              status={item.status}
              onRemove={item.removable ? () => onRemoveAttachment(item.id) : undefined}
              onRetry={item.retryable ? () => onRetryAttachment(item.id) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function attachmentAttentionRank(status: AttachmentChipStatus): number {
  if (status === "failed" || status === "unsupported") {
    return 0;
  }
  return status === "ready" || status === "deleted" ? 2 : 1;
}

function attachmentFadeMask(overflow: { above: boolean; below: boolean }): string | undefined {
  if (!overflow.above && !overflow.below) {
    return undefined;
  }
  const stops = [
    overflow.above ? `transparent 0, #000 ${ATTACHMENT_FADE_HEIGHT}` : "#000 0",
    overflow.below ? `#000 calc(100% - ${ATTACHMENT_FADE_HEIGHT}), transparent 100%` : "#000 100%"
  ];
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

function AttachmentChip({
  filename,
  byteSize,
  status,
  onRemove,
  onRetry
}: {
  filename: string;
  byteSize: number;
  status: AttachmentChipStatus;
  onRemove?: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const failed = status === "failed" || status === "unsupported";
  const pending = status === "uploading" || status === "queued" || status === "preprocessing";

  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs",
        failed ? "border-destructive/40 text-destructive" : "border-border text-foreground"
      )}
      title={filename}
    >
      {failed ? (
        <AlertCircle size={14} className="shrink-0" aria-hidden="true" />
      ) : pending ? (
        <Spinner size="xs" className="shrink-0" />
      ) : (
        <CheckCircle2
          size={14}
          className="shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 flex-1 truncate">{filename}</span>
      <span className="sr-only">{attachmentStatusLabel(status, t)}</span>
      <span className="shrink-0 text-muted-foreground">
        {pending ? attachmentStatusLabel(status, t) : formatFileSize(byteSize)}
      </span>
      {onRetry ? (
        <button
          type="button"
          className="grid size-5 shrink-0 place-items-center rounded transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
          aria-label={t("attachmentRetry")}
          title={t("attachmentRetry")}
          onClick={onRetry}
        >
          <RotateCcw size={13} aria-hidden="true" />
        </button>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
          aria-label={t("attachmentRemove")}
          title={t("attachmentRemove")}
          onClick={onRemove}
        >
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

function attachmentStatusLabel(
  status: AttachmentChipStatus,
  t: TranslationContextValue["t"]
): string {
  switch (status) {
    case "failed":
      return t("attachmentStatusFailed");
    case "unsupported":
      return t("attachmentStatusUnsupported");
    case "uploading":
      return t("attachmentStatusUploading");
    case "queued":
      return t("attachmentStatusQueued");
    case "preprocessing":
      return t("attachmentStatusPreparing");
    default:
      return t("attachmentStatusReady");
  }
}

/** A send waits only for a loading block, needs text, and is remembered once. */
export function shouldQueueSend(input: {
  sendBlock: SendBlock | undefined;
  sendQueued: boolean;
  text: string;
}): boolean {
  return Boolean(input.sendBlock?.loading) && !input.sendQueued && input.text.trim().length > 0;
}

function ComposerAction({
  sendBlock,
  sendQueued,
  conversationRunning,
  optimisticPending,
  currentText,
  onCancelRun,
  onQueueSend,
  onSubmitMessage
}: {
  sendBlock: SendBlock | undefined;
  sendQueued: boolean;
  conversationRunning?: boolean;
  optimisticPending?: boolean;
  currentText: string;
  onCancelRun: () => void;
  onQueueSend: () => void;
  onSubmitMessage?: (text: string) => boolean;
}) {
  const { t } = useTranslation();
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const activeRunBlocked = isComposerBlockedByActiveRun({ conversationRunning });
  const showCancelAction = shouldShowCancelAction({
    conversationRunning,
    optimisticPending,
    threadRunning
  });
  const effectiveDisabledReason =
    sendBlock?.reason ?? (activeRunBlocked ? t("conversationStillRunning") : undefined);
  // During a loading block the control stays usable: a click is remembered like an Enter.
  const queuesSend = Boolean(sendBlock?.loading) && !activeRunBlocked;
  const emptyText = currentText.trim().length === 0;
  const sendDisabled = queuesSend
    ? emptyText
    : Boolean(sendBlock) || activeRunBlocked || Boolean(onSubmitMessage && emptyText);
  const handleSendClick = useCallback(() => {
    onSubmitMessage?.(currentText);
  }, [currentText, onSubmitMessage]);
  const cancelButton = (
    <Button
      type="button"
      size="icon"
      className="absolute inset-0 size-9 rounded-full"
      aria-label={t("stopGenerating")}
      onClick={onCancelRun}
    >
      <Square size={14} className="fill-current" aria-hidden="true" />
    </Button>
  );

  return (
    <div className="relative ml-auto size-9">
      {showCancelAction ? (
        threadRunning ? (
          <ComposerPrimitive.Cancel asChild>{cancelButton}</ComposerPrimitive.Cancel>
        ) : (
          cancelButton
        )
      ) : queuesSend ? (
        <Button
          type="button"
          size="icon"
          className="absolute inset-0 size-9 rounded-xl"
          aria-label={t("sendMessage")}
          title={effectiveDisabledReason}
          disabled={sendDisabled}
          loading={sendQueued}
          onClick={onQueueSend}
        >
          <Send size={17} aria-hidden="true" />
        </Button>
      ) : onSubmitMessage ? (
        <Button
          type="button"
          size="icon"
          className="absolute inset-0 size-9 rounded-full"
          aria-label={t("sendMessage")}
          title={effectiveDisabledReason ?? t("sendMessage")}
          disabled={sendDisabled}
          onClick={handleSendClick}
        >
          <Send size={17} aria-hidden="true" />
        </Button>
      ) : (
        <ComposerPrimitive.Send asChild>
          <Button
            type="button"
            size="icon"
            className="absolute inset-0 size-9 rounded-full"
            aria-label={t("sendMessage")}
            title={effectiveDisabledReason ?? t("sendMessage")}
            disabled={sendDisabled}
          >
            <Send size={17} aria-hidden="true" />
          </Button>
        </ComposerPrimitive.Send>
      )}
    </div>
  );
}

function formatFileSize(byteSize: number): string {
  if (byteSize < 1024) {
    return `${byteSize} B`;
  }
  if (byteSize < 1024 * 1024) {
    return `${Math.round(byteSize / 102.4) / 10} KB`;
  }
  return `${Math.round(byteSize / 1024 / 102.4) / 10} MB`;
}

export function shouldExpandComposer(text: string, wrapsAtCompactWidth = false): boolean {
  return text.includes("\n") || wrapsAtCompactWidth;
}

function getCompactComposerInputWidth(
  shell: HTMLDivElement,
  attachment: HTMLButtonElement | null,
  controls: HTMLDivElement,
  attachmentsEnabled: boolean
): number {
  const style = window.getComputedStyle(shell);
  const contentWidth =
    shell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const gapCount = attachmentsEnabled ? 2 : 1;
  const occupiedWidth =
    controls.offsetWidth + (attachmentsEnabled ? (attachment?.offsetWidth ?? 0) : 0);
  return Math.max(1, contentWidth - occupiedWidth - parseFloat(style.columnGap) * gapCount);
}

function textareaWrapsAtWidth(input: HTMLTextAreaElement, width: number): boolean {
  if (input.value.length === 0) {
    return false;
  }

  const style = window.getComputedStyle(input);
  const lineHeight = parseFloat(style.lineHeight);
  const singleLineHeight =
    lineHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const measurementInput = input.cloneNode() as HTMLTextAreaElement;
  measurementInput.value = input.value;
  measurementInput.tabIndex = -1;
  measurementInput.setAttribute("aria-hidden", "true");
  Object.assign(measurementInput.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${width}px`,
    height: "0",
    minHeight: "0",
    maxHeight: "none",
    overflow: "hidden",
    visibility: "hidden"
  });
  document.body.append(measurementInput);
  const wraps = measurementInput.scrollHeight > singleLineHeight + 1;
  measurementInput.remove();
  return wraps;
}

interface ComposerLayoutSnapshot {
  expanded: boolean;
  input: DOMRect;
  attachment: DOMRect | undefined;
  controls: DOMRect;
}

function animateComposerLayoutShift(
  element: HTMLElement,
  previous: DOMRect,
  next: DOMRect,
  revealAddedWidth = false
): Animation | undefined {
  const x = previous.x - next.x;
  const y = previous.y - next.y;
  const clippedWidth = revealAddedWidth ? Math.max(0, next.width - previous.width) : 0;
  if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5 && clippedWidth < 0.5) {
    return undefined;
  }

  return element.animate(
    [
      {
        transform: `translate3d(${x}px, ${y}px, 0)`,
        clipPath: `inset(0 ${clippedWidth}px 0 0)`
      },
      {
        transform: "translate3d(0, 0, 0)",
        clipPath: "inset(0)"
      }
    ],
    {
      duration: 180,
      easing: "cubic-bezier(0.2, 0, 0, 1)"
    }
  );
}
