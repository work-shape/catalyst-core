import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  useAuiState
} from "@assistant-ui/react";
import { Check, Copy, FileText, Pencil, RefreshCw, User } from "lucide-react";
import { AttachmentPreview } from "./attachment-preview";
import { useTranslation } from "./i18n";
import { MarkdownText } from "./markdown-text";
import { DataPart, ToolCallPart } from "./tool-call";
import { TooltipIconButton, tooltipIconButtonClassName } from "./tooltip-icon-button";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

export function ThreadMessage() {
  const role = useAuiState((state) => state.message.role);
  const isEditing = useAuiState((state) => state.message.composer.isEditing);

  if (isEditing) {
    return <DisabledEditComposer />;
  }

  if (role === "user") {
    return <UserMessage />;
  }

  return <AssistantMessage />;
}

function AssistantMessage() {
  const { t } = useTranslation();

  return (
    <MessagePrimitive.Root
      className="group/message mx-auto w-full max-w-5xl animate-in fade-in slide-in-from-bottom-1 duration-150"
      data-role="assistant"
    >
      <div className="min-w-0 rounded-md px-1 py-1 text-sm leading-6">
        <MessagePrimitive.Parts
          components={{
            Text: AssistantTextPart,
            File: FilePart,
            tools: {
              Override: ToolCallPart
            },
            data: {
              Fallback: DataPart
            }
          }}
        />
        <MessageError />
      </div>
      <div className="mt-1 flex min-h-8 items-center gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100">
        <ActionBarPrimitive.Copy className={tooltipIconButtonClassName} title={t("copy")} aria-label={t("copy")}>
          <CopiedState />
        </ActionBarPrimitive.Copy>
        <TooltipIconButton tooltip={t("regenerateResponse")} disabled>
          <RefreshCw aria-hidden="true" />
        </TooltipIconButton>
      </div>
    </MessagePrimitive.Root>
  );
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
        <MessagePrimitive.Parts components={{ Text: UserTextPart, File: FilePart }} />
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

function AssistantTextPart() {
  const showThinking = useAuiState(
    (state) =>
      state.part.type === "text" &&
      state.part.status.type === "running" &&
      state.part.text.length === 0
  );

  if (showThinking) {
    return <AssistantThinking />;
  }

  return (
    <div className="max-w-3xl">
      <MarkdownText />
    </div>
  );
}

function AssistantThinking() {
  const { t } = useTranslation();

  return (
    <div
      className="inline-flex items-center gap-2 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
      data-testid="assistant-working-indicator"
    >
      <span>{t("thinking")}</span>
      <span className="inline-flex items-center gap-1" aria-hidden="true">
        <span className="size-1.5 rounded-full bg-primary/55 animate-pulse" />
        <span className="size-1.5 rounded-full bg-primary/55 animate-pulse [animation-delay:150ms]" />
        <span className="size-1.5 rounded-full bg-primary/55 animate-pulse [animation-delay:300ms]" />
      </span>
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
  return (
    <div className="my-2 inline-flex max-w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm shadow-xs">
      <FileText size={16} aria-hidden="true" className="text-muted-foreground" />
      <span className="truncate">{file.filename ?? file.mimeType ?? "file"}</span>
    </div>
  );
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
