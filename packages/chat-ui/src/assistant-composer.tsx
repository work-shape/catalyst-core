import { ComposerPrimitive, useAuiState, useComposer } from "@assistant-ui/react";
import { CheckCircle2, FileText, ImageIcon, Paperclip, RotateCcw, Send, Square, X } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { DraftAttachment } from "@vivd-catalyst/api-client";
import { AttachmentPreview } from "./attachment-preview";
import { useTranslation } from "./i18n";
import { isComposerBlockedByBackgroundRun, shouldShowCancelAction } from "./thread-activity";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Spinner } from "./ui/spinner";

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
  attachmentsEnabled,
  attachmentAccept,
  focusRequestId,
  onCancelRun,
  onFilesSelected,
  onRemoveAttachment,
  onRetryAttachment,
  onSubmitMessage
}: {
  attachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  sendBlockedReason?: string;
  conversationRunning?: boolean;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
  focusRequestId: number;
  onCancelRun: () => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onRetryAttachment: (attachmentId: string) => void;
  onSubmitMessage?: (text: string) => boolean;
}) {
  const { t } = useTranslation();
  const currentText = useComposer((state) => state.text);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasAttachments = attachments.length > 0 || localUploadingAttachments.length > 0;
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (onSubmitMessage?.(currentText)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [currentText, onSubmitMessage]
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        !onSubmitMessage ||
        event.key !== "Enter" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.nativeEvent.isComposing
      ) {
        return;
      }

      event.preventDefault();
      onSubmitMessage(currentText);
    },
    [currentText, onSubmitMessage]
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
          className={cn(
            "grid gap-2 rounded-lg border bg-background p-2 shadow-sm transition-colors",
            "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30"
          )}
        >
          <ComposerPrimitive.Input
            ref={composerInputRef}
            className="max-h-40 min-h-12 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground"
            placeholder={t("messagePlaceholder")}
            rows={1}
            submitMode={onSubmitMessage ? "none" : "enter"}
            onKeyDown={handleKeyDown}
          />
          <div className="flex items-center justify-between gap-2">
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
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground"
                  title={t("addAttachment")}
                  aria-label={t("addAttachment")}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={16} aria-hidden="true" />
                </Button>
              </>
            ) : null}
            <ComposerAction
              disabled={Boolean(sendBlockedReason)}
              disabledReason={sendBlockedReason}
              conversationRunning={conversationRunning}
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
          onRetry={attachment.status === "failed" ? () => onRetryAttachment(attachment.id) : undefined}
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
        failed || unsupported ? "border-destructive/40 text-destructive" : "border-border text-foreground",
        ready ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300" : undefined
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
  currentText,
  onCancelRun,
  onSubmitMessage
}: {
  disabled: boolean;
  disabledReason?: string;
  conversationRunning?: boolean;
  currentText: string;
  onCancelRun: () => void;
  onSubmitMessage?: (text: string) => boolean;
}) {
  const { t } = useTranslation();
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const backgroundRunBlocked = isComposerBlockedByBackgroundRun({
    conversationRunning,
    threadRunning
  });
  const showCancelAction = shouldShowCancelAction({
    conversationRunning,
    threadRunning
  });
  const effectiveDisabledReason = disabledReason ?? (backgroundRunBlocked ? t("conversationStillRunning") : undefined);
  const sendDisabled = disabled || backgroundRunBlocked || Boolean(onSubmitMessage && currentText.trim().length === 0);
  const handleSendClick = useCallback(
    () => {
      onSubmitMessage?.(currentText);
    },
    [currentText, onSubmitMessage]
  );
  const cancelButton = (
    <Button
      type="button"
      size="icon"
      className="absolute inset-0 size-9"
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
      ) : (
        onSubmitMessage ? (
          <Button
            type="button"
            size="icon"
            className="absolute inset-0 size-9"
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
              className="absolute inset-0 size-9"
              aria-label={t("sendMessage")}
              title={effectiveDisabledReason ?? t("sendMessage")}
              disabled={sendDisabled}
            >
              <Send size={17} aria-hidden="true" />
            </Button>
          </ComposerPrimitive.Send>
        )
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
  return mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp" || mimeType === "image/gif";
}
