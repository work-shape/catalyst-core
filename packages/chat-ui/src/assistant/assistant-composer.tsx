import { ComposerPrimitive, useAuiState, useComposer } from "@assistant-ui/react";
import {
  CheckCircle2,
  FileText,
  ImageIcon,
  Paperclip,
  RotateCcw,
  Send,
  Square,
  X
} from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { DraftAttachment, SafeConfig } from "@vivd-catalyst/api-client";
import { AttachmentPreview } from "../attachment-preview";
import { ContextIndicator } from "./context-indicator";
import { useTranslation } from "../i18n";
import { isComposerBlockedByActiveRun, shouldShowCancelAction } from "./thread-activity";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Spinner } from "../ui/spinner";

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
  sendBlockedReason,
  conversationRunning,
  optimisticPending,
  attachmentsEnabled,
  attachmentAccept,
  selectableModels,
  selectedModelBindingId,
  showContextIndicator,
  contextSnapshot,
  focusRequestId,
  onCancelRun,
  onSelectModelBinding,
  onFilesSelected,
  onRemoveAttachment,
  onRetryAttachment,
  onSubmitMessage
}: {
  attachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  sendBlockedReason?: string;
  conversationRunning?: boolean;
  optimisticPending?: boolean;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
  selectableModels: SafeConfig["selectableModels"];
  selectedModelBindingId: string | undefined;
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
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onRetryAttachment: (attachmentId: string) => void;
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
  const submitBlocked = Boolean(sendBlockedReason);
  const [composerExpanded, setComposerExpanded] = useState(false);
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
        return;
      }
      if (!onSubmitMessage) {
        return;
      }

      event.preventDefault();
      onSubmitMessage(currentText);
    },
    [currentText, onSubmitMessage, submitBlocked]
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
            "grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-1 rounded-2xl border bg-background p-1.5 shadow-sm transition-colors",
            "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30"
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
                  "col-start-1 size-9 shrink-0 rounded-xl text-muted-foreground",
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
            {selectableModels.length > 1 ? (
              <label className="min-w-0 shrink">
                <span className="sr-only">{t("selectModel")}</span>
                <select
                  className="h-9 max-w-44 truncate rounded-full bg-transparent px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50"
                  aria-label={t("selectModel")}
                  value={selectedModelBindingId ?? ""}
                  disabled={conversationRunning}
                  onChange={(event) => onSelectModelBinding(event.target.value)}
                >
                  {selectableModels.map((model) => (
                    <option key={model.bindingId} value={model.bindingId}>
                      {formatModelLabel(model.model)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {showContextIndicator && contextSnapshot ? (
              <div className="flex h-9 shrink-0 items-center">
                <ContextIndicator
                  inputTokens={contextSnapshot.inputTokens}
                  compactThresholdTokens={contextSnapshot.compactThresholdTokens}
                />
              </div>
            ) : null}
            <ComposerAction
              disabled={Boolean(sendBlockedReason)}
              disabledReason={sendBlockedReason}
              conversationRunning={conversationRunning}
              optimisticPending={optimisticPending}
              currentText={currentText}
              onCancelRun={onCancelRun}
              onSubmitMessage={onSubmitMessage}
            />
          </div>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
}

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
  return (
    <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto">
      {localUploadingAttachments.map((attachment) => (
        <AttachmentChip
          key={attachment.id}
          filename={attachment.filename}
          byteSize={attachment.byteSize}
          mimeType={attachment.mimeType}
          status={attachment.status}
        />
      ))}
      {attachments.map((attachment) => (
        <AttachmentChip
          key={attachment.id}
          filename={attachment.filename}
          byteSize={attachment.byteSize}
          mimeType={attachment.mimeType}
          status={attachment.status}
          failed={attachment.status === "failed"}
          unsupported={attachment.status === "unsupported"}
          onRemove={() => onRemoveAttachment(attachment.id)}
          onRetry={
            attachment.status === "failed" ? () => onRetryAttachment(attachment.id) : undefined
          }
        />
      ))}
    </div>
  );
}

function AttachmentChip({
  filename,
  byteSize,
  mimeType,
  status,
  failed,
  unsupported,
  onRemove,
  onRetry
}: {
  filename: string;
  byteSize: number;
  mimeType?: string;
  status: DraftAttachment["status"] | LocalUploadingAttachment["status"];
  failed?: boolean;
  unsupported?: boolean;
  onRemove?: () => void;
  onRetry?: () => void;
}) {
  const ready = status === "ready";

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs shadow-xs",
        failed || unsupported
          ? "border-destructive/40 text-destructive"
          : "border-border text-foreground",
        ready
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
          : undefined
      )}
    >
      {isImageMimeType(mimeType) ? (
        <ImageIcon
          size={14}
          className={cn(
            "shrink-0 text-muted-foreground",
            ready ? "text-emerald-600 dark:text-emerald-400" : undefined
          )}
          aria-hidden="true"
        />
      ) : (
        <FileText
          size={14}
          className={cn(
            "shrink-0 text-muted-foreground",
            ready ? "text-emerald-600 dark:text-emerald-400" : undefined
          )}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 truncate font-medium">{filename}</span>
      <AttachmentStatusIndicator status={status} />
      <span className="shrink-0 text-muted-foreground">{formatFileSize(byteSize)}</span>
      {onRetry ? (
        <button
          type="button"
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Retry attachment"
          title="Retry"
          onClick={onRetry}
        >
          <RotateCcw size={13} aria-hidden="true" />
        </button>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Remove attachment"
          title="Remove"
          onClick={onRemove}
        >
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

function AttachmentStatusIndicator({
  status
}: {
  status: DraftAttachment["status"] | LocalUploadingAttachment["status"];
}) {
  if (status === "ready") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 size={13} aria-hidden="true" />
        <span>{status}</span>
      </span>
    );
  }

  if (status === "uploading" || status === "queued" || status === "preprocessing") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
        <Spinner size="xs" />
        <span>{status}</span>
      </span>
    );
  }

  return <span className="shrink-0 text-muted-foreground">{status}</span>;
}

function ComposerAction({
  disabled,
  disabledReason,
  conversationRunning,
  optimisticPending,
  currentText,
  onCancelRun,
  onSubmitMessage
}: {
  disabled: boolean;
  disabledReason?: string;
  conversationRunning?: boolean;
  optimisticPending?: boolean;
  currentText: string;
  onCancelRun: () => void;
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
    disabledReason ?? (activeRunBlocked ? t("conversationStillRunning") : undefined);
  const sendDisabled =
    disabled || activeRunBlocked || Boolean(onSubmitMessage && currentText.trim().length === 0);
  const handleSendClick = useCallback(() => {
    onSubmitMessage?.(currentText);
  }, [currentText, onSubmitMessage]);
  const cancelButton = (
    <Button
      type="button"
      size="icon"
      className="absolute inset-0 size-9 rounded-xl"
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
      ) : onSubmitMessage ? (
        <Button
          type="button"
          size="icon"
          className="absolute inset-0 size-9 rounded-xl"
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
            className="absolute inset-0 size-9 rounded-xl"
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

function isImageMimeType(mimeType: string | undefined): boolean {
  return (
    mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/webp" ||
    mimeType === "image/gif"
  );
}

export function formatModelLabel(model: string): string {
  return model.replace(/^gpt-/iu, "GPT-").replace(/-(sol|terra|luna)$/iu, (_, tier: string) => {
    return ` ${tier.charAt(0).toUpperCase()}${tier.slice(1).toLowerCase()}`;
  });
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
