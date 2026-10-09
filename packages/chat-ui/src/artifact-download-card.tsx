import { FileText } from "lucide-react";
import { useCallback, useEffect } from "react";
import { cn } from "@vivd-catalyst/ui";
import { useAttachmentContentContext } from "./attachment-content";
import {
  ConversationFileDownloadButton,
  conversationFileFromArtifact,
  conversationFilePreviewAvailable,
  createConversationFilePanelEntry
} from "./conversation-file-presentation";
import { useTranslation } from "./i18n";
import type { Surface } from "./surface/surface";
import { useToolDisplayPanel } from "./tool-display-panel";
import {
  artifactDisplayFilename,
  getArtifactFileType,
  type ArtifactFileType,
  type ToolArtifactDownloadRef
} from "./tool-artifacts";

export function ToolArtifactList({
  autoPreview = false,
  artifacts,
  className,
  variant = "compact"
}: {
  autoPreview?: boolean;
  artifacts: ToolArtifactDownloadRef[];
  className?: string;
  variant?: "compact" | "deliverable";
}) {
  const { t } = useTranslation();
  const attachmentContent = useAttachmentContentContext();
  const { show, showOnce } = useToolDisplayPanel();
  const client = attachmentContent?.client;
  const conversationId = attachmentContent?.selectedConversationId;
  const downloadAvailable = Boolean(client && conversationId);

  const previewPanelEntry = useCallback(
    (artifact: ToolArtifactDownloadRef): Surface | undefined => {
      const fileType = getArtifactFileType(artifact);
      const file = conversationFileFromArtifact(artifact, artifactDetail(fileType, artifact));
      if (!client || !conversationId || !conversationFilePreviewAvailable(file)) {
        return undefined;
      }
      return createConversationFilePanelEntry({ client, conversationId, file });
    },
    [client, conversationId]
  );

  useEffect(() => {
    if (!autoPreview) {
      return;
    }
    const artifact = artifacts.find((candidate) =>
      conversationFilePreviewAvailable(conversationFileFromArtifact(candidate))
    );
    const entry = artifact ? previewPanelEntry(artifact) : undefined;
    if (entry) {
      showOnce(entry);
    }
  }, [artifacts, autoPreview, previewPanelEntry, showOnce]);

  if (artifacts.length === 0) {
    return null;
  }

  function previewArtifact(artifact: ToolArtifactDownloadRef) {
    const entry = previewPanelEntry(artifact);
    if (entry) {
      show(entry);
    }
  }

  return (
    <div className={cn("grid gap-1.5", className)}>
      {artifacts.map((artifact) => {
        const filename = artifactDisplayFilename(artifact);
        const fileType = getArtifactFileType(artifact);
        const file = conversationFileFromArtifact(artifact, artifactDetail(fileType, artifact));
        const previewAvailable = downloadAvailable && conversationFilePreviewAvailable(file);
        const cardClassName = cn(
          "flex w-full min-w-0 items-center gap-3 rounded-md border bg-background text-left text-sm text-foreground shadow-xs transition-colors",
          variant === "deliverable" ? "min-h-20 px-4 py-3" : "min-h-10 px-3 py-2",
          previewAvailable &&
            "cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        );
        return (
          <div
            key={artifact.artifactId}
            className={cardClassName}
            role={previewAvailable ? "button" : undefined}
            tabIndex={previewAvailable ? 0 : undefined}
            title={previewAvailable ? t("openArtifactPreview", { filename }) : undefined}
            aria-label={previewAvailable ? t("openArtifactPreview", { filename }) : undefined}
            onClick={previewAvailable ? () => previewArtifact(artifact) : undefined}
            onKeyDown={
              previewAvailable
                ? (event) => {
                    if (
                      event.target === event.currentTarget &&
                      (event.key === "Enter" || event.key === " ")
                    ) {
                      event.preventDefault();
                      previewArtifact(artifact);
                    }
                  }
                : undefined
            }
          >
            <ArtifactFileIcon fileType={fileType} large={variant === "deliverable"} />
            <span className="min-w-0 flex-1 truncate">
              <span
                className={cn(
                  "block truncate font-medium",
                  variant === "deliverable" && "text-base"
                )}
              >
                {filename}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {artifactDetail(fileType, artifact)}
              </span>
            </span>
            <ConversationFileDownloadButton
              client={client}
              conversationId={conversationId}
              file={file}
              variant={variant}
            />
          </div>
        );
      })}
    </div>
  );
}

export function ArtifactFileIcon({
  fileType,
  large
}: {
  fileType: ArtifactFileType;
  large?: boolean;
}) {
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center rounded-md text-[10px] font-bold tracking-wide text-white shadow-xs",
        large ? "h-12 w-12" : "h-8 w-8",
        fileType.className
      )}
      aria-hidden="true"
    >
      <FileText size={large ? 24 : 18} className="absolute opacity-20" />
      <span className="relative">{fileType.badge}</span>
    </span>
  );
}

function artifactDetail(fileType: ArtifactFileType, artifact: ToolArtifactDownloadRef): string {
  const detail = artifact.kind ?? artifact.mimeType;
  return detail ? `${fileType.label} · ${detail}` : fileType.label;
}
