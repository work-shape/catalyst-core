import { AttachmentPrimitive, useAuiState } from "@assistant-ui/react";
import { ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn, Spinner } from "@vivd-catalyst/ui";
import { managedFileIdFromUrl, useAttachmentContentContext } from "./attachment-content";
import { useOpenConversationFile } from "./conversation-file-presentation";
import { useTranslation } from "./i18n";

/** `row` renders the file as a full-width list entry inside a grouped attachment card. */
export type AttachmentPreviewVariant = "chip" | "row";

export function AttachmentPreview({
  removable,
  variant = "chip"
}: {
  removable: boolean;
  variant?: AttachmentPreviewVariant;
}) {
  const attachment = useAuiState((state) => state.attachment as AttachmentSnapshot);
  const imageUrl = useAttachmentImageUrl(attachment);
  const managedFileId = managedFileIdFromAttachmentContent(attachment.content);
  const attachmentContent = useAttachmentContentContext();
  const openConversationFile = useOpenConversationFile();
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const conversationId = attachmentContent?.selectedConversationId;
  const client = attachmentContent?.client;
  const filename = attachment.name || "Attached file";
  const previewAvailable = Boolean(!removable && managedFileId && client && conversationId);

  async function openPreview() {
    if (!managedFileId || !client || !conversationId || opening) {
      return;
    }
    setOpening(true);
    try {
      await openConversationFile({ client, conversationId, fileId: managedFileId, filename });
    } finally {
      if (mounted.current) {
        setOpening(false);
      }
    }
  }

  if (isImageAttachment(attachment)) {
    return (
      <AttachmentPrimitive.Root className="group/attachment relative max-w-xs">
        <figure className="grid gap-1 overflow-hidden rounded-md border bg-card p-1 shadow-xs">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={attachment.name || t("attachmentImageFallbackAlt")}
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

  const row = variant === "row";
  const fileClassName = cn(
    "items-center gap-1.5 rounded-md text-xs text-muted-foreground",
    row ? "flex w-full px-2 py-1.5 text-left" : "inline-flex max-w-full bg-muted/45 px-2 py-1"
  );

  return (
    <AttachmentPrimitive.Root
      className={cn("group/attachment relative", row ? "min-w-0" : "max-w-72")}
    >
      {previewAvailable ? (
        <button
          type="button"
          className={cn(
            fileClassName,
            "cursor-pointer transition-colors",
            "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          )}
          title={t("openArtifactPreview", { filename })}
          aria-label={t("openArtifactPreview", { filename })}
          aria-busy={opening}
          disabled={opening}
          onClick={() => void openPreview()}
        >
          {opening ? (
            <Spinner size="sm" />
          ) : (
            <AttachmentPrimitive.unstable_Thumb className="shrink-0 font-mono text-[0.65rem] uppercase leading-none text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">
            <AttachmentPrimitive.Name />
          </span>
        </button>
      ) : (
        <div className={fileClassName}>
          <AttachmentPrimitive.unstable_Thumb className="shrink-0 font-mono text-[0.65rem] uppercase leading-none text-muted-foreground" />
          <span className="min-w-0 truncate">
            <AttachmentPrimitive.Name />
          </span>
        </div>
      )}
      <RemoveAttachmentButton removable={removable} />
    </AttachmentPrimitive.Root>
  );
}

function RemoveAttachmentButton({ removable }: { removable: boolean }) {
  const { t } = useTranslation();
  if (!removable) {
    return null;
  }
  return (
    <AttachmentPrimitive.Remove
      className={cn(
        "absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-xs transition-opacity",
        "group-hover/attachment:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      )}
      aria-label={t("attachmentRemove")}
      title={t("attachmentRemove")}
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

export function managedFileIdFromAttachmentContent(
  content: AttachmentContentPart[] | undefined
): string | undefined {
  for (const part of content ?? []) {
    const url =
      typeof part.data === "string"
        ? part.data
        : typeof part.image === "string"
          ? part.image
          : undefined;
    const fileId = managedFileIdFromUrl(url);
    if (fileId) {
      return fileId;
    }
  }
  return undefined;
}

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
    void attachmentContent.client.conversations.files
      .get_content({
        params: { conversationId: attachmentContent.selectedConversationId, fileId }
      })
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
  }, [
    attachmentContent?.client,
    attachmentContent?.selectedConversationId,
    sourceFile,
    sourceKind,
    sourceUrl
  ]);

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

function imageSourceFromContent(
  content: AttachmentContentPart[] | undefined
): AttachmentImageSource {
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

export function isImageAttachment(attachment: {
  type?: string;
  contentType?: string;
  name?: string;
}): boolean {
  return (
    attachment.type === "image" ||
    isImageMimeType(attachment.contentType) ||
    isImageFilename(attachment.name)
  );
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
