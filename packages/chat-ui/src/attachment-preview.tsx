import { AttachmentPrimitive, useAuiState } from "@assistant-ui/react";
import { ImageIcon, X } from "lucide-react";
import { useEffect, useState } from "react";
import { managedFileIdFromUrl, useAttachmentContentContext } from "./attachment-content";
import { cn } from "./ui/cn";

export function AttachmentPreview({ removable }: { removable: boolean }) {
  const attachment = useAuiState((state) => state.attachment as AttachmentSnapshot);
  const imageUrl = useAttachmentImageUrl(attachment);

  if (isImageAttachment(attachment)) {
    return (
      <AttachmentPrimitive.Root className="group/attachment relative max-w-xs">
        <figure className="grid gap-1 overflow-hidden rounded-md border bg-card p-1 shadow-xs">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={attachment.name || "Attached image"}
              className="max-h-72 w-auto max-w-full rounded object-contain"
            />
          ) : (
            <div className="flex min-h-20 items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <ImageIcon size={16} aria-hidden="true" />
              <span className="min-w-0 truncate">
                <AttachmentPrimitive.Name />
              </span>
            </div>
          )}
          {attachment.name ? (
            <figcaption className="truncate px-1 pb-1 text-xs text-muted-foreground">
              <AttachmentPrimitive.Name />
            </figcaption>
          ) : null}
        </figure>
        <RemoveAttachmentButton removable={removable} />
      </AttachmentPrimitive.Root>
    );
  }

  return (
    <AttachmentPrimitive.Root className="group/attachment relative max-w-72">
      <div className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted/45 px-2 py-1 text-xs text-muted-foreground">
        <AttachmentPrimitive.unstable_Thumb className="shrink-0 font-mono text-[0.65rem] uppercase leading-none text-muted-foreground" />
        <span className="min-w-0 truncate">
          <AttachmentPrimitive.Name />
        </span>
      </div>
      <RemoveAttachmentButton removable={removable} />
    </AttachmentPrimitive.Root>
  );
}

function RemoveAttachmentButton({ removable }: { removable: boolean }) {
  if (!removable) {
    return null;
  }
  return (
    <AttachmentPrimitive.Remove
      className={cn(
        "absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-xs transition-opacity",
        "group-hover/attachment:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      )}
      aria-label="Remove attachment"
      title="Remove attachment"
    >
      <X size={12} aria-hidden="true" />
    </AttachmentPrimitive.Remove>
  );
}

type AttachmentSnapshot = {
  type?: string;
  name?: string;
  contentType?: string;
  file?: File;
  content?: AttachmentContentPart[];
};

type AttachmentContentPart = {
  type?: string;
  image?: unknown;
  data?: unknown;
  mimeType?: string;
};

type AttachmentImageSource =
  | {
      kind: "direct";
      url: string;
    }
  | {
      kind: "file";
      file: File;
    }
  | {
      kind: "managed";
      url: string;
    }
  | {
      kind: "none";
    };

function useAttachmentImageUrl(attachment: AttachmentSnapshot): string | undefined {
  const attachmentContent = useAttachmentContentContext();
  const source = imageSourceFromAttachment(attachment);
  const sourceFile = source.kind === "file" ? source.file : undefined;
  const sourceKind = source.kind;
  const sourceUrl = source.kind === "direct" || source.kind === "managed" ? source.url : undefined;
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (sourceKind === "direct" || sourceKind === "none") {
      setObjectUrl(undefined);
      return undefined;
    }

    if (sourceKind === "file") {
      if (!sourceFile || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        setObjectUrl(undefined);
        return undefined;
      }
      const nextUrl = URL.createObjectURL(sourceFile);
      setObjectUrl(nextUrl);
      return () => URL.revokeObjectURL(nextUrl);
    }

    const fileId = managedFileIdFromUrl(sourceUrl);
    if (!fileId || !attachmentContent?.client || !attachmentContent.selectedConversationId) {
      setObjectUrl(undefined);
      return undefined;
    }

    let active = true;
    let nextUrl: string | undefined;
    void attachmentContent.client
      .conversationFileContent(attachmentContent.selectedConversationId, fileId)
      .then((blob) => {
        if (!active) {
          return;
        }
        nextUrl = URL.createObjectURL(blob);
        setObjectUrl(nextUrl);
      })
      .catch(() => {
        if (active) {
          setObjectUrl(undefined);
        }
      });

    return () => {
      active = false;
      if (nextUrl) {
        URL.revokeObjectURL(nextUrl);
      }
    };
  }, [attachmentContent?.client, attachmentContent?.selectedConversationId, sourceFile, sourceKind, sourceUrl]);

  return sourceKind === "direct" ? sourceUrl : objectUrl;
}

function imageSourceFromAttachment(attachment: AttachmentSnapshot): AttachmentImageSource {
  const contentSource = imageSourceFromContent(attachment.content);
  if (contentSource.kind !== "none") {
    return contentSource;
  }

  if (isImageMimeType(attachment.contentType) && attachment.file) {
    return {
      kind: "file",
      file: attachment.file
    };
  }

  return {
    kind: "none"
  };
}

function imageSourceFromContent(content: AttachmentContentPart[] | undefined): AttachmentImageSource {
  for (const part of content ?? []) {
    const image = typeof part.image === "string" ? part.image : undefined;
    if (part.type === "image" && image) {
      return image.startsWith("vivd-file://")
        ? {
            kind: "managed",
            url: image
          }
        : {
            kind: "direct",
            url: image
          };
    }

    const data = typeof part.data === "string" ? part.data : undefined;
    if (part.type === "file" && isImageMimeType(part.mimeType) && data) {
      return data.startsWith("vivd-file://")
        ? {
            kind: "managed",
            url: data
          }
        : {
            kind: "direct",
            url: data
          };
    }
  }

  return {
    kind: "none"
  };
}

function isImageAttachment(attachment: AttachmentSnapshot): boolean {
  return attachment.type === "image" || isImageMimeType(attachment.contentType) || isImageFilename(attachment.name);
}

function isImageMimeType(value: string | undefined): boolean {
  return normalizedMimeType(value)?.startsWith("image/") ?? false;
}

function normalizedMimeType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase();
}

function isImageFilename(value: string | undefined): boolean {
  return /\.(gif|jpe?g|png|webp)$/iu.test(value ?? "");
}
