import { useQueryClient } from "@tanstack/react-query";
import type { ApiClient, ConversationResourceListItem } from "@vivd-catalyst/api-client";
import { resolveFilePreviewCapability } from "@vivd-catalyst/core";
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
import { Button, cn, Spinner } from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "./api/workspace-api-client";
import { workspaceQueryKeys } from "./api/workspace-query-keys";
import {
  conversationFileContentUrl,
  loadConversationFileBlob,
  saveBlobAsFile,
  useConversationFileBlob,
  type ConversationFileContentRef
} from "./conversation-file-content";
import { NativeFilePreview } from "./artifact-preview-shell";
import { useTranslation } from "./i18n";
import type { Surface, SurfaceOf } from "./surface/surface";
import { useToolDisplayPanel } from "./tool-display-panel";
import {
  artifactDisplayFilename,
  artifactDownloadFilename,
  getArtifactPreviewKind,
  type ToolArtifactDownloadRef
} from "./tool-artifacts";

const SOURCE_FILE_AUTH_SCOPE = "standalone";

const ArtifactPreview = lazy(() =>
  import("./artifact-preview").then((module) => ({ default: module.ArtifactPreview }))
);
const SpreadsheetFilePreview = lazy(() =>
  import("./artifact-preview").then((module) => ({ default: module.SpreadsheetFilePreview }))
);

export type ConversationFileResource = Extract<
  ConversationResourceListItem,
  { resourceType: "source_file" | "generated_file" }
>;

export interface ConversationFilePresentation {
  key: string;
  title: string;
  subtitle?: string;
  filename: string;
  downloadLabel: string;
  mimeType?: string;
  preview:
    | { kind: "artifact"; artifact: ToolArtifactDownloadRef }
    | { kind: "source_file"; attachmentId: string; fileId: string };
  download: ConversationFileContentRef;
  headerDownloadVariant: ConversationFileDownloadVariant;
}

type OpenConversationFileInput = {
  client: ApiClient;
  conversationId: string;
  filename?: string;
} & ({ fileId: string } | { attachmentId: string });

type ConversationFileDownloadVariant = "compact" | "deliverable" | "panel" | "icon" | "labelled";

export function conversationFileFromArtifact(
  artifact: ToolArtifactDownloadRef,
  subtitle?: string
): ConversationFilePresentation {
  return {
    key: `artifact-preview:${artifact.artifactId}`,
    title: artifactDisplayFilename(artifact),
    ...(subtitle ? { subtitle } : {}),
    filename: artifactDownloadFilename(artifact),
    downloadLabel: artifactDisplayFilename(artifact),
    mimeType: artifact.mimeType,
    preview: { kind: "artifact", artifact },
    download: { kind: "artifact", artifactId: artifact.artifactId },
    headerDownloadVariant: "panel"
  };
}

export function conversationFileFromResource(
  resource: ConversationFileResource
): ConversationFilePresentation {
  if (resource.resourceType === "generated_file") {
    return {
      key: `resource:${resource.resourceId}`,
      title: resource.title,
      subtitle: resource.subtitle,
      filename: resource.download.filename,
      downloadLabel: resource.download.filename,
      preview: {
        kind: "artifact",
        artifact: {
          artifactId: resource.preview.artifactId,
          filename: resource.download.filename
        }
      },
      download: { kind: "artifact", artifactId: resource.download.artifactId },
      headerDownloadVariant: "panel"
    };
  }

  const preview =
    resource.preview.kind === "artifact"
      ? {
          kind: "artifact" as const,
          artifact: {
            artifactId: resource.preview.artifactId,
            filename: resource.download.filename,
            mimeType: resource.preview.mimeType ?? resource.mimeType
          }
        }
      : {
          kind: "source_file" as const,
          attachmentId: resource.attachmentId,
          fileId: resource.preview.fileId
        };
  return {
    key: `resource:${resource.resourceId}`,
    title: resource.title,
    subtitle: resource.subtitle,
    filename: resource.download.filename,
    downloadLabel: resource.download.filename,
    mimeType: resource.mimeType,
    preview,
    download: { kind: "source_file", fileId: resource.download.fileId },
    headerDownloadVariant: "icon"
  };
}

export function isConversationFileResource(
  resource: ConversationResourceListItem
): resource is ConversationFileResource {
  return resource.resourceType === "source_file" || resource.resourceType === "generated_file";
}

export function conversationFilePreviewAvailable(file: ConversationFilePresentation): boolean {
  return file.preview.kind === "artifact"
    ? Boolean(getArtifactPreviewKind(file.preview.artifact))
    : Boolean(getSourceFilePreviewKind(file.filename, file.mimeType));
}

export function findSourceFileResource(
  resources: ConversationResourceListItem[],
  fileId: string
): Extract<ConversationFileResource, { resourceType: "source_file" }> | undefined {
  return resources.find(
    (resource): resource is Extract<ConversationFileResource, { resourceType: "source_file" }> =>
      resource.resourceType === "source_file" && resource.download.fileId === fileId
  );
}

export function findSourceFileResourceByAttachmentId(
  resources: ConversationResourceListItem[],
  attachmentId: string
): Extract<ConversationFileResource, { resourceType: "source_file" }> | undefined {
  return resources.find(
    (resource): resource is Extract<ConversationFileResource, { resourceType: "source_file" }> =>
      resource.resourceType === "source_file" && resource.attachmentId === attachmentId
  );
}

/** Opens a user-visible conversation file after resolving its durable resource. */
export function useOpenConversationFile(): (input: OpenConversationFileInput) => Promise<void> {
  const displayPanel = useToolDisplayPanel();
  const queryClient = useQueryClient();
  const { apiBaseUrl } = useWorkspaceApiClient();
  const { t } = useTranslation();

  return useCallback(
    async (input) => {
      const { client, conversationId, filename } = input;
      const resourceId = "fileId" in input ? input.fileId : input.attachmentId;
      const title = filename ?? resourceId;
      displayPanel.show(
        createPanelStatusEntry(`file-loading:${resourceId}`, title, <Spinner size="sm" />)
      );
      try {
        const response = await queryClient.fetchQuery({
          queryKey: workspaceQueryKeys.conversationResources(
            apiBaseUrl,
            SOURCE_FILE_AUTH_SCOPE,
            conversationId
          ),
          queryFn: () => client.conversations.resources.list(conversationId)
        });
        const resource =
          "fileId" in input
            ? findSourceFileResource(response, input.fileId)
            : findSourceFileResourceByAttachmentId(response, input.attachmentId);
        if (!resource) {
          throw new Error("Conversation file resource was not found");
        }
        displayPanel.show(
          createConversationFilePanelEntry({
            client,
            conversationId,
            file: conversationFileFromResource(resource)
          })
        );
      } catch {
        displayPanel.show(
          createPanelStatusEntry(
            `file-error:${resourceId}`,
            title,
            <span>{t("resourcesLoadFailed")}</span>
          )
        );
      }
    },
    [apiBaseUrl, displayPanel, queryClient, t]
  );
}

export function createConversationFilePanelEntry({
  client,
  conversationId,
  file
}: {
  client: ApiClient;
  conversationId: string;
  file: ConversationFilePresentation;
}): SurfaceOf<"file_preview"> {
  return {
    kind: "file_preview",
    key: file.key,
    title: file.title,
    subtitle: file.subtitle,
    headerActions: (
      <ConversationFileDownloadButton
        client={client}
        conversationId={conversationId}
        file={file}
        variant={file.headerDownloadVariant}
      />
    ),
    node: (
      <ConversationFilePanelPreview client={client} conversationId={conversationId} file={file} />
    )
  };
}

export function ConversationFileDownloadButton({
  client,
  conversationId,
  file,
  variant = "compact"
}: {
  client: ApiClient | undefined;
  conversationId: string | undefined;
  file: ConversationFilePresentation;
  variant?: ConversationFileDownloadVariant;
}) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);
  const available = Boolean(client && conversationId);
  const labelled = variant !== "icon";
  const nativeUrl =
    available &&
    client?.browserManagedDownloads &&
    conversationId &&
    file.download.kind === "artifact"
      ? conversationFileContentUrl(client, conversationId, file.download)
      : undefined;

  async function download() {
    if (!client || !conversationId) {
      return;
    }
    setDownloading(true);
    try {
      saveBlobAsFile(
        await loadConversationFileBlob(client, conversationId, file.download, true),
        file.filename
      );
    } finally {
      setDownloading(false);
    }
  }

  const title = available
    ? t("downloadArtifact", { filename: file.downloadLabel })
    : t("downloadUnavailable");
  if (variant === "icon" || variant === "labelled") {
    return (
      <Button
        type="button"
        variant={variant === "labelled" ? "outline" : "ghost"}
        size={variant === "labelled" ? "sm" : "icon"}
        className={
          variant === "labelled"
            ? "h-8 text-xs"
            : "size-7 shrink-0 opacity-70 group-hover:opacity-100"
        }
        title={title}
        aria-label={title}
        disabled={!available || downloading}
        onClick={(event) => {
          event.stopPropagation();
          void download();
        }}
      >
        {downloading ? <Spinner size="sm" /> : <Download size={14} aria-hidden="true" />}
        {labelled ? <span>{t("downloadArtifactButton")}</span> : null}
      </Button>
    );
  }

  const large = variant === "deliverable";
  const className = cn(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border bg-background font-medium text-foreground no-underline transition-colors",
    "hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
    large ? "h-10 px-4 text-sm" : "h-8 px-3 text-xs",
    (!available || downloading) && "pointer-events-none opacity-60"
  );
  const contents = (
    <>
      {downloading ? (
        <Spinner size="sm" className="text-muted-foreground" />
      ) : (
        <Download size={large ? 16 : 14} aria-hidden="true" />
      )}
      <span>{t("downloadArtifactButton")}</span>
    </>
  );

  return nativeUrl ? (
    <a
      href={nativeUrl}
      download={file.filename}
      title={title}
      aria-label={title}
      className={className}
      onClick={stopPreviewOpen}
    >
      {contents}
    </a>
  ) : (
    <button
      type="button"
      disabled={!available || downloading}
      title={title}
      aria-label={title}
      className={className}
      onClick={(event) => {
        stopPreviewOpen(event);
        void download();
      }}
    >
      {contents}
    </button>
  );
}

function ConversationFilePanelPreview({
  client,
  conversationId,
  file
}: {
  client: ApiClient;
  conversationId: string;
  file: ConversationFilePresentation;
}) {
  const { t } = useTranslation();
  if (file.preview.kind === "source_file") {
    const previewKind = getSourceFilePreviewKind(file.filename, file.mimeType);
    return previewKind ? (
      <SourceFilePreview
        client={client}
        conversationId={conversationId}
        attachmentId={file.preview.attachmentId}
        fileId={file.preview.fileId}
        filename={file.filename}
        mimeType={file.mimeType}
      />
    ) : (
      <FileDetails file={file}>
        <ConversationFileDownloadButton
          client={client}
          conversationId={conversationId}
          file={file}
          variant="labelled"
        />
      </FileDetails>
    );
  }

  return (
    <ArtifactPreviewErrorBoundary
      key={file.preview.artifact.artifactId}
      fallback={
        <PanelMessage
          title={t("artifactPreviewFailed")}
          detail={t("artifactPreviewUnsupported")}
          card
        />
      }
    >
      <Suspense fallback={<PanelLoading label={t("artifactPreviewLoading")} />}>
        <ArtifactPreview
          artifact={file.preview.artifact}
          client={client}
          conversationId={conversationId}
        />
      </Suspense>
    </ArtifactPreviewErrorBoundary>
  );
}

export function SourceFilePreview({
  client,
  conversationId,
  attachmentId,
  fileId,
  filename,
  mimeType
}: {
  client: ApiClient;
  conversationId: string;
  attachmentId: string;
  fileId: string;
  filename: string;
  mimeType?: string;
}) {
  const { t } = useTranslation();
  const [nativeFailed, setNativeFailed] = useState(false);
  const previewKind = getSourceFilePreviewKind(filename, mimeType);
  const office = previewKind === "office";
  const directUrl =
    client.browserManagedDownloads && (previewKind === "image" || previewKind === "pdf")
      ? conversationFileContentUrl(client, conversationId, { kind: "source_file", fileId })
      : undefined;
  const state = useConversationFileBlob({
    client,
    conversationId,
    content: { kind: "source_file", fileId },
    download: previewKind !== "image",
    createObjectUrl: previewKind !== "spreadsheet",
    enabled: !office && !directUrl
  });

  useEffect(() => {
    setNativeFailed(false);
  }, [directUrl, fileId]);

  if (office) {
    return (
      <AttachmentOfficePreview
        client={client}
        conversationId={conversationId}
        attachmentId={attachmentId}
        filename={filename}
        mimeType={mimeType}
      />
    );
  }
  if (state.status === "failed" || nativeFailed) {
    return <PanelMessage title={t("resourcesLoadFailed")} />;
  }
  if (previewKind === "spreadsheet" && state.status === "ready") {
    return (
      <Suspense fallback={<PanelLoading />}>
        <SpreadsheetFilePreview blob={state.blob} />
      </Suspense>
    );
  }
  const url = directUrl ?? (state.status === "ready" ? state.url : undefined);
  return url ? (
    <NativeFilePreview
      kind={previewKind === "pdf" ? "pdf" : "image"}
      title={filename}
      url={url}
      onError={() => setNativeFailed(true)}
    />
  ) : (
    <PanelLoading />
  );
}

export type SourceFilePreviewKind = "image" | "pdf" | "spreadsheet" | "office";

export function getSourceFilePreviewKind(
  filename: string,
  mimeType?: string
): SourceFilePreviewKind | undefined {
  const capability = resolveFilePreviewCapability({ filename, mimeType });
  return capability === "native_image"
    ? "image"
    : capability === "native_pdf"
      ? "pdf"
      : capability === "spreadsheet"
        ? "spreadsheet"
        : capability === "office_document_pages" || capability === "office_presentation_pages"
          ? "office"
          : undefined;
}

function AttachmentOfficePreview({
  client,
  conversationId,
  attachmentId,
  filename,
  mimeType
}: {
  client: ApiClient;
  conversationId: string;
  attachmentId: string;
  filename: string;
  mimeType?: string;
}) {
  const { t } = useTranslation();
  const [artifactId, setArtifactId] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setArtifactId(undefined);
    setFailed(false);
    void client.conversations.artifacts
      .startAttachmentPreview(conversationId, attachmentId)
      .then((preview) => {
        if (active) {
          setArtifactId(preview.artifactId);
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [attachmentId, client, conversationId]);

  if (failed) {
    return <PanelMessage title={t("resourcesLoadFailed")} />;
  }
  if (!artifactId) {
    return <PanelLoading />;
  }
  return (
    <Suspense fallback={<PanelLoading />}>
      <ArtifactPreview
        artifact={{ artifactId, filename, mimeType }}
        client={client}
        conversationId={conversationId}
      />
    </Suspense>
  );
}

function FileDetails({
  children,
  file
}: {
  children: ReactNode;
  file: ConversationFilePresentation;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-64 place-items-center p-6">
      <div className="grid max-w-sm justify-items-center gap-3 text-center">
        <FileText size={32} className="text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="font-medium">{file.filename}</p>
          <p className="text-sm text-muted-foreground">
            {file.mimeType ?? t("resourcesUnknownFileType")}
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

function createPanelStatusEntry(key: string, title: string, content: ReactNode): Surface {
  return { kind: "file_preview", key, title, node: <PanelLoading>{content}</PanelLoading> };
}

function PanelLoading({ children, label }: { children?: ReactNode; label?: string }) {
  return (
    <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
      {children ?? <Spinner size="sm" />}
      {label ? <span>{label}</span> : null}
    </div>
  );
}

function PanelMessage({
  card = false,
  detail,
  title
}: {
  card?: boolean;
  detail?: string;
  title: string;
}) {
  return (
    <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
      <div
        className={cn(
          "max-w-sm",
          card && "rounded-md border bg-card px-4 py-3 text-left shadow-xs"
        )}
      >
        <p className="font-medium text-foreground">{title}</p>
        {detail ? <p className="mt-1 text-xs">{detail}</p> : null}
      </div>
    </div>
  );
}

function stopPreviewOpen(event: MouseEvent<HTMLElement>) {
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
