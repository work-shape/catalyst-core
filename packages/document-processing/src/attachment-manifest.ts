import type {
  AttachmentManifest,
  AttachmentManifestEntry,
  ConversationAttachment,
  DraftAttachment
} from "@vivd-catalyst/core";

export function createAttachmentManifest(
  attachments: readonly ConversationAttachment[],
  preprocessingVersion: string
): AttachmentManifest {
  return {
    version: 1,
    attachments: attachments.flatMap((attachment): AttachmentManifestEntry[] => {
      if (attachment.status !== "ready") {
        return [];
      }
      return [
        {
          fileId: attachment.fileId,
          attachmentId: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          byteSize: attachment.byteSize,
          status: "ready",
          readable: true,
          readToolName: "read_document",
          metadata: toPreparedDocumentMetadata(attachment, preprocessingVersion)
        }
      ];
    })
  };
}

export function hasBlockingDraftAttachment(attachments: readonly DraftAttachment[]): boolean {
  return attachments.some((attachment) => attachment.status !== "ready");
}

export function blockingDraftAttachmentMessage(
  attachments: readonly DraftAttachment[]
): string | undefined {
  if (attachments.some((attachment) => attachment.status === "failed")) {
    return "Remove or retry failed file attachments before sending.";
  }
  if (attachments.some((attachment) => attachment.status === "unsupported")) {
    return "Remove unsupported file attachments before sending.";
  }
  if (
    attachments.some(
      (attachment) => attachment.status === "queued" || attachment.status === "preprocessing"
    )
  ) {
    return "Wait for file processing to finish before sending.";
  }
  return undefined;
}

export function toPreparedDocumentMetadata(
  attachment: ConversationAttachment,
  preprocessingVersion: string
): AttachmentManifestEntry["metadata"] {
  return {
    fileId: attachment.fileId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    format: attachment.format,
    characterCount: attachment.characterCount,
    wordCount: attachment.wordCount,
    pageCount: attachment.pageCount,
    warnings: attachment.warnings,
    preprocessingVersion
  };
}
