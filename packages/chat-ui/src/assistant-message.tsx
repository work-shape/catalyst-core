import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  groupPartByType,
  useAuiState
} from "@assistant-ui/react";
import { Check, Copy, FileText, ImageIcon, Pencil, RefreshCw, User } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AttachmentPreview } from "./attachment-preview";
import { managedFileIdFromUrl, useAttachmentContentContext } from "./attachment-content";
import { AssistantCursor } from "./assistant-cursor";
import { useTranslation } from "./i18n";
import { MarkdownText } from "./markdown-text";
import { DataPart, ToolCallPart } from "./tool-call";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "./assistant-tool-group";
import { TooltipIconButton, tooltipIconButtonClassName } from "./tooltip-icon-button";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

const assistantMessageGroupBy = groupPartByType({
  "tool-call": ["group-work"],
  "standalone-tool-call": []
});

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
  const messageRunning = useAuiState(
    (state) => state.message.role === "assistant" && state.message.status?.type === "running"
  );

  return (
    <MessagePrimitive.Root
      className="group/message mx-auto w-full max-w-5xl animate-in fade-in slide-in-from-bottom-1 duration-150"
      data-role="assistant"
    >
      <div className="min-w-0 rounded-md px-1 py-1 text-sm leading-6">
        <MessagePrimitive.GroupedParts groupBy={assistantMessageGroupBy} indicator="always">
          {({ part, children }) => {
            switch (part.type) {
              case "group-work":
                return (
                  <AssistantWorkGroup count={part.indices.length} active={part.status.type === "running"}>
                    {children}
                  </AssistantWorkGroup>
                );
              case "text":
                return <AssistantTextPart />;
              case "tool-call":
                return part.toolUI ?? <ToolCallPart {...part} />;
              case "data":
                return part.dataRendererUI ?? <DataPart {...part} />;
              case "reasoning":
                return <HiddenReasoningPart />;
              case "image":
                return <ImagePart />;
              case "file":
                return <FilePart />;
              case "indicator":
                return <AssistantStreamingIndicator />;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
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

function AssistantWorkGroup({ count, active, children }: { count: number; active: boolean; children: ReactNode }) {
  const { t } = useTranslation();

  return (
    <ToolGroupRoot className="chat-tool-work my-4 max-w-5xl" variant="ghost">
      <ToolGroupTrigger
        active={active}
        count={count}
        label={t(count === 1 ? "toolCallCountSingular" : "toolCallCount", { count })}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
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

function AssistantTextPart() {
  const isRunning = useAuiState((state) => state.part.status.type === "running");

  return (
    <div className={cn("chat-assistant-text max-w-3xl", isRunning && "chat-assistant-text-running")}>
      <MarkdownText />
    </div>
  );
}

function AssistantStreamingIndicator() {
  const showIndicator = useAuiState((state) => {
    const lastPart = state.message.parts.at(-1);
    if (lastPart === undefined || lastPart.type !== "text") {
      return true;
    }
    return lastPart.text.trim().length === 0;
  });

  return showIndicator ? <AssistantCursor className="my-1" /> : null;
}

function HiddenReasoningPart() {
  return null;
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
