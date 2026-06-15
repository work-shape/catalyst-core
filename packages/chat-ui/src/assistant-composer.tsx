import { AuiIf, ComposerPrimitive } from "@assistant-ui/react";
import { FileText, Paperclip, RotateCcw, Send, Square, X } from "lucide-react";
import { useRef } from "react";
import type { DraftAttachment } from "@vivd-catalyst/api-client";
import { AttachmentPreview } from "./attachment-preview";
import { useTranslation } from "./i18n";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

export interface LocalUploadingAttachment {
  id: string;
  filename: string;
  byteSize: number;
  status: "uploading";
}

export function AssistantComposer({
  attachments,
  localUploadingAttachments,
  sendBlockedReason,
  onFilesSelected,
  onRemoveAttachment,
  onRetryAttachment
}: {
  attachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  sendBlockedReason?: string;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onRetryAttachment: (attachmentId: string) => void;
}) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasAttachments = attachments.length > 0 || localUploadingAttachments.length > 0;

  return (
    <ComposerPrimitive.Root className="relative grid w-full gap-2">
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
            className="max-h-40 min-h-12 w-full resize-none bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground"
            placeholder={t("messagePlaceholder")}
            rows={1}
            submitMode="enter"
          />
          <div className="flex items-center justify-between gap-2">
            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              multiple
              accept=".pdf,.docx,.txt,.md,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
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
            <ComposerAction disabled={Boolean(sendBlockedReason)} disabledReason={sendBlockedReason} />
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
          status={attachment.status}
        />
      ))}
      {attachments.map((attachment) => (
        <AttachmentChip
          key={attachment.id}
          filename={attachment.filename}
          byteSize={attachment.byteSize}
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
  status,
  failed,
  unsupported,
  onRemove,
  onRetry
}: {
  filename: string;
  byteSize: number;
  status: DraftAttachment["status"] | LocalUploadingAttachment["status"];
  failed?: boolean;
  unsupported?: boolean;
  onRemove?: () => void;
  onRetry?: () => void;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs shadow-xs",
        failed || unsupported ? "border-destructive/40 text-destructive" : "border-border text-foreground"
      )}
    >
      <FileText size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate font-medium">{filename}</span>
      <span className="shrink-0 text-muted-foreground">{status}</span>
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

function ComposerAction({
  disabled,
  disabledReason
}: {
  disabled: boolean;
  disabledReason?: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="relative size-9">
      <AuiIf condition={(state) => state.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Button type="button" size="icon" className="absolute inset-0 size-9" aria-label={t("stopGenerating")}>
            <Square size={14} className="fill-current" aria-hidden="true" />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
      <AuiIf condition={(state) => !state.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <Button
            type="button"
            size="icon"
            className="absolute inset-0 size-9"
            aria-label={t("sendMessage")}
            title={disabledReason ?? t("sendMessage")}
            disabled={disabled}
          >
            <Send size={17} aria-hidden="true" />
          </Button>
        </ComposerPrimitive.Send>
      </AuiIf>
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
