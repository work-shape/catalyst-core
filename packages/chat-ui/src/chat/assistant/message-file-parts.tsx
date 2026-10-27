import { MessagePartPrimitive, useAuiState } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { managedFileIdFromUrl, useAttachmentContentContext } from "../files/attachment-content";
import { resolveFileType } from "../files/file-type";
import { FileTypeIcon } from "../files/file-type-icon";
import { useImageFailed } from "../files/image-failure";
import { viewerObjectUrl } from "../files/viewer-object-url";
import { useTranslation } from "../../shared/i18n";

/** File and image parts of a message: a file chip, or the image itself when it can be shown. */
export function FilePart() {
  const { t } = useTranslation();
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
    <div className="chat-message-block my-2 inline-flex max-w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm shadow-xs">
      <FileTypeIcon type={resolveFileType({ filename: file.filename, mimeType })} />
      <span className="truncate">{file.filename ?? mimeType ?? t("attachmentFallbackName")}</span>
    </div>
  );
}

export function ImagePart() {
  const { t } = useTranslation();
  const image = useAuiState((state) => (state.part.type === "image" ? state.part : undefined));
  if (!image) {
    return null;
  }
  return (
    <div className="chat-message-block my-2 overflow-hidden rounded-md border bg-card shadow-xs">
      <MessagePartPrimitive.Image
        alt={image.filename ?? t("attachmentImageFallbackAlt")}
        className="max-h-96 w-auto max-w-full object-contain"
      />
    </div>
  );
}

export function ImageFilePart({
  data,
  filename,
  mimeType
}: {
  data: string;
  filename?: string;
  mimeType: string;
}) {
  const attachmentContent = useAttachmentContentContext();
  const { t } = useTranslation();
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
    void attachmentClient.conversations.files
      .get_content({ params: { conversationId: selectedConversationId, fileId } })
      .then((blob) => {
        if (!active) {
          return;
        }
        objectUrl = viewerObjectUrl(blob, "image");
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
  const image = useImageFailed(imageUrl);

  if (!imageUrl || image.failed) {
    return (
      <div className="chat-message-block my-2 inline-flex max-w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm shadow-xs">
        <FileTypeIcon type={resolveFileType({ filename, mimeType })} />
        <span className="truncate">{filename ?? mimeType}</span>
      </div>
    );
  }

  return (
    <figure className="chat-message-block my-2 grid gap-1 overflow-hidden rounded-md border bg-card p-1 shadow-xs">
      <img
        src={imageUrl}
        alt={filename ?? t("attachmentImageFallbackAlt")}
        className="max-h-96 w-auto max-w-full rounded object-contain"
        onError={image.onError}
      />
      {filename ? (
        <figcaption className="truncate px-1 pb-1 text-xs text-muted-foreground">
          {filename}
        </figcaption>
      ) : null}
    </figure>
  );
}

function isDirectImageUrl(value: string | undefined): value is string {
  return Boolean(value && /^(https:\/\/|blob:|data:image\/)/u.test(value));
}

function isSupportedImageMimeType(value: string | undefined): value is string {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/gif"
  );
}

function filePartMimeType(file: { mediaType?: string; mimeType?: string }): string | undefined {
  return file.mediaType ?? file.mimeType;
}

function filePartUrl(file: { url?: string; data?: unknown }): string {
  if (typeof file.url === "string") {
    return file.url;
  }
  return typeof file.data === "string" ? file.data : "";
}
