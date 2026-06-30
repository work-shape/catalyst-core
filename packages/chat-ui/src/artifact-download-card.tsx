import { Download, FileText } from "lucide-react";
import { useState } from "react";
import { useAttachmentContentContext } from "./attachment-content";
import { useTranslation } from "./i18n";
import { Spinner } from "./ui/spinner";
import { cn } from "./ui/cn";
import {
  artifactDisplayFilename,
  artifactDownloadFilename,
  getArtifactFileType,
  type ArtifactFileType,
  type ToolArtifactDownloadRef
} from "./tool-artifacts";

export function ToolArtifactList({
  artifacts,
  className,
  variant = "compact"
}: {
  artifacts: ToolArtifactDownloadRef[];
  className?: string;
  variant?: "compact" | "deliverable";
}) {
  const { t } = useTranslation();
  const attachmentContent = useAttachmentContentContext();
  const [downloadingArtifactId, setDownloadingArtifactId] = useState<string | undefined>();

  if (artifacts.length === 0) {
    return null;
  }

  const downloadAvailable = Boolean(attachmentContent?.client && attachmentContent.selectedConversationId);

  async function downloadArtifact(artifact: ToolArtifactDownloadRef) {
    if (!attachmentContent?.client || !attachmentContent.selectedConversationId) {
      return;
    }
    setDownloadingArtifactId(artifact.artifactId);
    try {
      const blob = await attachmentContent.client.conversationArtifactContent(
        attachmentContent.selectedConversationId,
        artifact.artifactId
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifactDownloadFilename(artifact);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setDownloadingArtifactId(undefined);
    }
  }

  return (
    <div className={cn("grid gap-1.5", className)}>
      {artifacts.map((artifact) => {
        const filename = artifactDisplayFilename(artifact);
        const downloading = downloadingArtifactId === artifact.artifactId;
        const fileType = getArtifactFileType(artifact);
        return (
          <button
            key={artifact.artifactId}
            type="button"
            disabled={!downloadAvailable || downloading}
            title={downloadAvailable ? t("downloadArtifact", { filename }) : t("downloadUnavailable")}
            aria-label={downloadAvailable ? t("downloadArtifact", { filename }) : t("downloadUnavailable")}
            onClick={() => void downloadArtifact(artifact)}
            className={cn(
              "flex w-full min-w-0 items-center gap-3 rounded-md border bg-background text-left text-sm text-foreground shadow-xs transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60",
              variant === "deliverable" ? "min-h-20 px-4 py-3" : "min-h-10 px-3 py-2"
            )}
          >
            <ArtifactFileIcon fileType={fileType} large={variant === "deliverable"} />
            <span className="min-w-0 flex-1 truncate">
              <span className={cn("block truncate font-medium", variant === "deliverable" && "text-base")}>
                {filename}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {artifactDetail(fileType, artifact)}
              </span>
            </span>
            {downloading ? (
              <Spinner size="sm" className="shrink-0 text-muted-foreground" />
            ) : (
              <Download size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function ArtifactFileIcon({
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
