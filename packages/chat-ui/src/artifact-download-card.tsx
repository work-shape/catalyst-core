import { Download, FileText } from "lucide-react";
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode
} from "react";
import { useAttachmentContentContext } from "./attachment-content";
import { useTranslation } from "./i18n";
import { useToolDisplayPanel, type ToolDisplayPanelEntry } from "./tool-display-panel";
import { Spinner } from "./ui/spinner";
import { cn } from "./ui/cn";
import {
  artifactDisplayFilename,
  artifactDownloadFilename,
  getArtifactFileType,
  getArtifactPreviewKind,
  type ArtifactFileType,
  type ToolArtifactDownloadRef
} from "./tool-artifacts";

const ArtifactPreview = lazy(() =>
  import("./artifact-preview").then((module) => ({ default: module.ArtifactPreview }))
);

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
  const [downloadingArtifactId, setDownloadingArtifactId] = useState<string | undefined>();
  const client = attachmentContent?.client;
  const conversationId = attachmentContent?.selectedConversationId;
  const downloadAvailable = Boolean(client && conversationId);

  const previewPanelEntry = useCallback(
    (artifact: ToolArtifactDownloadRef): ToolDisplayPanelEntry | undefined => {
      if (!client || !conversationId || !getArtifactPreviewKind(artifact)) {
        return undefined;
      }
      const filename = artifactDisplayFilename(artifact);
      const fileType = getArtifactFileType(artifact);
      return {
        key: artifactPreviewPanelKey(artifact),
        title: filename,
        subtitle: artifactDetail(fileType, artifact),
        node: (
          <ArtifactPreviewErrorBoundary
            key={artifact.artifactId}
            fallback={
              <ArtifactPreviewPanelMessage
                title={t("artifactPreviewFailed")}
                detail={t("artifactPreviewUnsupported")}
              />
            }
          >
            <Suspense
              fallback={
                <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Spinner size="sm" />
                  <span>{t("artifactPreviewLoading")}</span>
                </div>
              }
            >
              <ArtifactPreview artifact={artifact} client={client} conversationId={conversationId} />
            </Suspense>
          </ArtifactPreviewErrorBoundary>
        )
      };
    },
    [client, conversationId, t]
  );

  useEffect(() => {
    if (!autoPreview) {
      return;
    }
    const artifact = artifacts.find((candidate) => getArtifactPreviewKind(candidate));
    const entry = artifact ? previewPanelEntry(artifact) : undefined;
    if (entry) {
      showOnce(entry);
    }
  }, [artifacts, autoPreview, previewPanelEntry, showOnce]);

  if (artifacts.length === 0) {
    return null;
  }

  async function downloadArtifact(artifact: ToolArtifactDownloadRef) {
    if (!client || !conversationId) {
      return;
    }
    setDownloadingArtifactId(artifact.artifactId);
    try {
      const blob = await client.conversationArtifactContent(conversationId, artifact.artifactId);
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
        const downloadFilename = artifactDownloadFilename(artifact);
        const downloading = downloadingArtifactId === artifact.artifactId;
        const fileType = getArtifactFileType(artifact);
        const previewAvailable = downloadAvailable && Boolean(getArtifactPreviewKind(artifact));
        const nativeDownloadUrl =
          downloadAvailable &&
          client?.browserManagedArtifactDownloads &&
          conversationId
            ? client.conversationArtifactContentUrl(conversationId, artifact.artifactId)
            : undefined;
        const cardClassName = cn(
          "flex w-full min-w-0 items-center gap-3 rounded-md border bg-background text-left text-sm text-foreground shadow-xs transition-colors",
          variant === "deliverable" ? "min-h-20 px-4 py-3" : "min-h-10 px-3 py-2",
          previewAvailable &&
            "cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        );
        const downloadButtonClassName = cn(
          "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border bg-background font-medium text-foreground no-underline transition-colors",
          "hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
          variant === "deliverable" ? "h-10 px-4 text-sm" : "h-8 px-3 text-xs",
          (!downloadAvailable || downloading) && "pointer-events-none opacity-60"
        );
        const downloadAction = nativeDownloadUrl ? (
          <a
            href={nativeDownloadUrl}
            download={downloadFilename}
            title={t("downloadArtifact", { filename })}
            aria-label={t("downloadArtifact", { filename })}
            className={downloadButtonClassName}
            onClick={stopCardPreview}
          >
            <Download size={variant === "deliverable" ? 16 : 14} aria-hidden="true" />
            <span>{t("downloadArtifactButton")}</span>
          </a>
        ) : (
          <button
            type="button"
            disabled={!downloadAvailable || downloading}
            title={downloadAvailable ? t("downloadArtifact", { filename }) : t("downloadUnavailable")}
            aria-label={downloadAvailable ? t("downloadArtifact", { filename }) : t("downloadUnavailable")}
            onClick={(event) => {
              stopCardPreview(event);
              void downloadArtifact(artifact);
            }}
            className={downloadButtonClassName}
          >
            {downloading ? (
              <Spinner size="sm" className="text-muted-foreground" />
            ) : (
              <Download size={variant === "deliverable" ? 16 : 14} aria-hidden="true" />
            )}
            <span>{t("downloadArtifactButton")}</span>
          </button>
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
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      previewArtifact(artifact);
                    }
                  }
                : undefined
            }
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
            {downloadAction}
          </div>
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

function artifactPreviewPanelKey(artifact: ToolArtifactDownloadRef): string {
  return `artifact-preview:${artifact.artifactId}`;
}

function stopCardPreview(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

class ArtifactPreviewErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ArtifactPreviewPanelMessage({ detail, title }: { detail?: string; title: string }) {
  return (
    <div className="flex min-h-64 items-center justify-center">
      <div className="max-w-sm rounded-md border bg-card px-4 py-3 text-sm shadow-xs">
        <p className="font-medium">{title}</p>
        {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
      </div>
    </div>
  );
}
