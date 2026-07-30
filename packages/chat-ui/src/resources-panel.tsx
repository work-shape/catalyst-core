import * as Collapsible from "@radix-ui/react-collapsible";
import {
  BarChart3,
  ChevronDown,
  Database,
  Download,
  FileText,
  Library,
  X
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ReactNode
} from "react";
import type {
  ApiClient,
  ConversationResourceListItem
} from "@vivd-catalyst/api-client";
import { ArtifactDownloadButton, ArtifactFileIcon } from "./artifact-download-card";
import { useWorkspaceApiClient } from "./api/workspace-api-client";
import {
  useConversationResourcesQuery,
  useStructuredDataResourceQuery
} from "./api/workspace-queries";
import {
  isToolDisplayPayload,
  useToolDisplayWidget
} from "./domain-ui-widgets";
import { useTranslation } from "./i18n";
import {
  groupConversationResources,
  resolveResourcesPanelOpen,
  type ResourceSectionType
} from "./resources-panel-model";
import {
  StructuredDataCopyAllButton,
  StructuredDataView
} from "./structured-data-view";
import {
  displayPanelKey,
  renderBuiltInDisplay
} from "./tool-display-rendering";
import {
  useToolDisplayPanel,
  type ToolDisplayPanelEntry
} from "./tool-display-panel";
import { getArtifactFileType, type ToolArtifactDownloadRef } from "./tool-artifacts";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { useWorkspacePreferences } from "./workspace/workspace-ui-state";

const AUTH_SCOPE = "standalone";
const ArtifactPreview = lazy(() =>
  import("./artifact-preview").then((module) => ({ default: module.ArtifactPreview }))
);

export function useResourcesPanelState({
  conversationId,
  enabled
}: {
  conversationId: string | undefined;
  enabled: boolean;
}) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const {
    resourcesPanelPreference,
    setResourcesPanelPreference
  } = useWorkspacePreferences();
  const [desktop, setDesktop] = useState(false);
  const query = useConversationResourcesQuery({
    apiBaseUrl,
    authScope: AUTH_SCOPE,
    client,
    conversationId,
    enabled: enabled && Boolean(conversationId)
  });
  const resources = query.data?.resources ?? [];

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const open =
    enabled &&
    Boolean(conversationId) &&
    resolveResourcesPanelOpen({
      preference: resourcesPanelPreference,
      desktop,
      hasResources: resources.length > 0
    });

  return {
    client,
    error: Boolean(query.error),
    loading: query.isLoading,
    open,
    resources,
    close: () => setResourcesPanelPreference("closed"),
    openExplicitly: () => setResourcesPanelPreference("open")
  };
}

export function ResourcesPanelToggle({ onOpen }: { onOpen(): void }) {
  const { t } = useTranslation();
  return (
    <div className="animate-in fade-in zoom-in-95 absolute top-20 right-6 z-[45] duration-200">
      <TooltipIconButton
        className="size-9 rounded-md border bg-popover text-muted-foreground shadow-lg hover:bg-accent hover:text-accent-foreground"
        tooltip={t("resourcesToggle")}
        onClick={onOpen}
      >
        <Library size={16} aria-hidden="true" />
      </TooltipIconButton>
    </div>
  );
}

export function ResourcesPanel({
  client,
  conversationId,
  error = false,
  loading,
  onClose,
  open,
  resources
}: {
  client: ApiClient;
  conversationId: string;
  error?: boolean;
  loading: boolean;
  onClose(): void;
  open: boolean;
  resources: ConversationResourceListItem[];
}) {
  const { locale, t } = useTranslation();
  const displayPanel = useToolDisplayPanel();
  const displayWidget = useToolDisplayWidget();
  const sections = groupConversationResources(resources);

  const showEntry = useCallback(
    (entry: ToolDisplayPanelEntry) => displayPanel.show(entry),
    [displayPanel]
  );

  const artifactEntry = useCallback(
    (
      resource: Extract<ConversationResourceListItem, { resourceType: "generated_file" }>,
      artifactId: string
    ): ToolDisplayPanelEntry => {
      const artifact: ToolArtifactDownloadRef = {
        artifactId,
        filename: resource.download.filename
      };
      return {
        key: `resource:${resource.resourceId}`,
        title: resource.title,
        subtitle: resource.subtitle,
        headerActions: (
          <ArtifactDownloadButton
            artifact={artifact}
            client={client}
            conversationId={conversationId}
            variant="panel"
          />
        ),
        node: (
          <Suspense
            fallback={
              <div className="flex min-h-64 items-center justify-center">
                <Spinner size="sm" />
              </div>
            }
          >
            <ArtifactPreview
              artifact={artifact}
              client={client}
              conversationId={conversationId}
            />
          </Suspense>
        )
      };
    },
    [client, conversationId]
  );

  const sourceEntry = useCallback(
    (
      resource: Extract<
        ConversationResourceListItem,
        { resourceType: "source_file" }
      >
    ): ToolDisplayPanelEntry => {
      if (resource.preview.kind === "artifact") {
        const preview: ToolArtifactDownloadRef = {
          artifactId: resource.preview.artifactId,
          mimeType: resource.preview.mimeType
        };
        return {
          key: `resource:${resource.resourceId}`,
          title: resource.title,
          subtitle: resource.subtitle,
          headerActions: (
            <ResourceDownloadButton
              client={client}
              conversationId={conversationId}
              resource={resource}
            />
          ),
          node: (
            <Suspense
              fallback={
                <div className="flex min-h-64 items-center justify-center">
                  <Spinner size="sm" />
                </div>
              }
            >
              <ArtifactPreview
                artifact={preview}
                client={client}
                conversationId={conversationId}
              />
            </Suspense>
          )
        };
      }
      const inline =
        (resource.mimeType?.startsWith("image/") ?? false) ||
        resource.mimeType === "application/pdf";
      return {
        key: `resource:${resource.resourceId}`,
        title: resource.title,
        subtitle: resource.subtitle,
        headerActions: (
          <ResourceDownloadButton
            client={client}
            conversationId={conversationId}
            resource={resource}
          />
        ),
        node: inline ? (
          <SourceFilePreview
            client={client}
            conversationId={conversationId}
            fileId={resource.preview.fileId}
            filename={resource.download.filename}
            mimeType={resource.mimeType}
          />
        ) : (
          <FileDetails resource={resource}>
            <ResourceDownloadButton
              client={client}
              conversationId={conversationId}
              resource={resource}
              labelled
            />
          </FileDetails>
        )
      };
    },
    [client, conversationId]
  );

  function previewResource(resource: ConversationResourceListItem) {
    if (resource.resourceType === "source_file") {
      showEntry(sourceEntry(resource));
      return;
    }
    if (resource.resourceType === "generated_file") {
      showEntry(artifactEntry(resource, resource.preview.artifactId));
      return;
    }
    if (resource.resourceType === "analysis") {
      const display = resource.preview.display;
      const customNode =
        isToolDisplayPayload(display) && displayWidget
          ? displayWidget({
              display,
              locale,
              source: "message-metadata"
            })
          : undefined;
      const node =
        customNode ??
        (isToolDisplayPayload(display) ? renderBuiltInDisplay(display) : undefined) ??
        <pre className="overflow-auto whitespace-pre-wrap p-4 text-xs">
          {JSON.stringify(display, null, 2)}
        </pre>;
      showEntry({
        key: displayPanelKey(display, resource.resourceId),
        title: resource.title,
        subtitle: resource.subtitle,
        node
      });
      return;
    }

    const sourceResources = resources.filter(
      (
        candidate
      ): candidate is Extract<
        ConversationResourceListItem,
        { resourceType: "source_file" }
      > => candidate.resourceType === "source_file"
    );
    const detail = {
      conversationId,
      structuredDataResourceId: resource.preview.structuredDataResourceId,
      onSourceOpen: (attachmentId: string) => {
        const source = sourceResources.find(
          (candidate) => candidate.attachmentId === attachmentId
        );
        if (source) {
          showEntry(sourceEntry(source));
        }
      }
    };
    showEntry({
      key: `resource:${resource.resourceId}`,
      title: resource.title,
      subtitle: resource.subtitle,
      headerActions: <StructuredDataHeaderAction {...detail} />,
      node: <StructuredDataPreview {...detail} />
    });
  }

  if (!open) {
    return null;
  }

  return (
    <aside
      aria-label={t("resourcesTitle")}
      className="animate-in fade-in zoom-in-95 absolute top-20 right-6 z-[45] flex max-h-[calc(100%-6rem)] w-[min(22rem,calc(100%-3rem))] flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg duration-200"
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <h2 className="text-sm font-semibold">{t("resourcesTitle")}</h2>
        <TooltipIconButton
          className="size-7"
          tooltip={t("resourcesClose")}
          onClick={onClose}
        >
          <X size={15} aria-hidden="true" />
        </TooltipIconButton>
      </div>
      <div className="chat-scrollbar min-h-0 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
            <Spinner size="sm" />
            <span>{t("resourcesLoading")}</span>
          </div>
        ) : error ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t("resourcesLoadFailed")}
          </p>
        ) : sections.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t("resourcesEmpty")}
          </p>
        ) : (
          <div className="grid gap-1">
            {sections.map((section) => (
              <Collapsible.Root key={section.type} defaultOpen>
                <Collapsible.Trigger className="group flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
                  <ChevronDown
                    size={14}
                    className="transition-transform group-data-[state=closed]:-rotate-90"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {sectionLabel(section.type, t)}
                  </span>
                  <span className="font-normal tabular-nums">{section.resources.length}</span>
                </Collapsible.Trigger>
                <Collapsible.Content className="grid gap-0.5 pb-1">
                  {section.resources.map((resource) => (
                    <ResourceRow
                      key={resource.resourceId}
                      client={client}
                      conversationId={conversationId}
                      resource={resource}
                      onPreview={() => previewResource(resource)}
                    />
                  ))}
                </Collapsible.Content>
              </Collapsible.Root>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function ResourceRow({
  client,
  conversationId,
  resource,
  onPreview
}: {
  client: ApiClient;
  conversationId: string;
  resource: ConversationResourceListItem;
  onPreview(): void;
}) {
  const { locale } = useTranslation();

  return (
    <div
      role="button"
      tabIndex={0}
      className="group flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      onClick={onPreview}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPreview();
        }
      }}
    >
      <ResourceRowIcon resource={resource} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{resource.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {new Date(resource.createdAt).toLocaleDateString(locale, {
            dateStyle: "medium"
          })}
        </span>
      </span>
      {resource.resourceType === "source_file" ||
      resource.resourceType === "generated_file" ? (
        <ResourceDownloadButton
          client={client}
          conversationId={conversationId}
          resource={resource}
        />
      ) : null}
    </div>
  );
}

function ResourceDownloadButton({
  client,
  conversationId,
  labelled = false,
  resource
}: {
  client: ApiClient;
  conversationId: string;
  labelled?: boolean;
  resource: Extract<
    ConversationResourceListItem,
    { resourceType: "source_file" | "generated_file" }
  >;
}) {
  const { t } = useTranslation();
  const [downloading, setDownloading] = useState(false);
  const filename = resource.download.filename;

  async function download() {
    setDownloading(true);
    try {
      const blob =
        resource.download.kind === "artifact"
          ? await client.conversationArtifactContent(
              conversationId,
              resource.download.artifactId
            )
          : await client.conversationFileContent(
              conversationId,
              resource.download.fileId,
              true
            );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Button
      type="button"
      variant={labelled ? "outline" : "ghost"}
      size={labelled ? "sm" : "icon"}
      className={labelled ? "h-8 text-xs" : "size-7 shrink-0 opacity-70 group-hover:opacity-100"}
      title={t("downloadArtifact", { filename })}
      aria-label={t("downloadArtifact", { filename })}
      disabled={downloading}
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

export function SourceFilePreview({
  client,
  conversationId,
  fileId,
  filename,
  mimeType
}: {
  client: ApiClient;
  conversationId: string;
  fileId: string;
  filename: string;
  mimeType?: string;
}) {
  const { t } = useTranslation();
  const pdf = mimeType === "application/pdf";
  const directUrl = client.browserManagedDownloads && !pdf
    ? client.conversationFileContentUrl(conversationId, fileId)
    : undefined;
  const [url, setUrl] = useState<string | undefined>(directUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (directUrl) {
      setUrl(directUrl);
      setFailed(false);
      return undefined;
    }

    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    void client
      .conversationFileContent(conversationId, fileId, pdf)
      .then((blob) => {
        if (active) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true);
        }
      });
    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [client, conversationId, directUrl, fileId, pdf]);

  if (failed) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        {t("resourcesLoadFailed")}
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner size="sm" />
      </div>
    );
  }
  return pdf ? (
    <iframe title={filename} src={url} className="h-full min-h-64 w-full border-0" />
  ) : (
    <div className="flex h-full min-h-64 items-center justify-center bg-muted/20 p-4">
      <img
        src={url}
        alt={filename}
        className="max-h-full max-w-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function FileDetails({
  children,
  resource
}: {
  children: ReactNode;
  resource: Extract<ConversationResourceListItem, { resourceType: "source_file" }>;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-64 place-items-center p-6">
      <div className="grid max-w-sm justify-items-center gap-3 text-center">
        <FileText size={32} className="text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="font-medium">{resource.download.filename}</p>
          <p className="text-sm text-muted-foreground">
            {resource.mimeType ?? t("resourcesUnknownFileType")}
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

function StructuredDataPreview({
  conversationId,
  structuredDataResourceId,
  onSourceOpen
}: {
  conversationId: string;
  structuredDataResourceId: string;
  onSourceOpen(attachmentId: string): void;
}) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const { t } = useTranslation();
  const query = useStructuredDataResourceQuery({
    apiBaseUrl,
    authScope: AUTH_SCOPE,
    client,
    conversationId,
    structuredDataResourceId
  });

  if (!query.data) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        {query.error ? t("resourcesLoadFailed") : <Spinner size="sm" />}
      </div>
    );
  }
  return (
    <StructuredDataView
      resource={query.data}
      onSourceOpen={(source) => onSourceOpen(source.attachmentId)}
    />
  );
}

function StructuredDataHeaderAction({
  conversationId,
  structuredDataResourceId
}: {
  conversationId: string;
  structuredDataResourceId: string;
  onSourceOpen(attachmentId: string): void;
}) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const query = useStructuredDataResourceQuery({
    apiBaseUrl,
    authScope: AUTH_SCOPE,
    client,
    conversationId,
    structuredDataResourceId
  });
  return query.data ? <StructuredDataCopyAllButton resource={query.data} /> : null;
}

function ResourceRowIcon({ resource }: { resource: ConversationResourceListItem }) {
  if (
    resource.resourceType === "source_file" ||
    resource.resourceType === "generated_file"
  ) {
    const fileType = getArtifactFileType({
      artifactId: "",
      filename: resource.download.filename,
      mimeType: resource.resourceType === "source_file" ? resource.mimeType : undefined
    });
    return <ArtifactFileIcon fileType={fileType} />;
  }
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
      aria-hidden="true"
    >
      {resource.resourceType === "structured_data" ? (
        <Database size={16} />
      ) : (
        <BarChart3 size={16} />
      )}
    </span>
  );
}

function sectionLabel(
  type: ResourceSectionType,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  if (type === "structured_data") {
    return t("resourcesCustomerData");
  }
  if (type === "analysis") {
    return t("resourcesAnalyses");
  }
  if (type === "generated_file") {
    return t("resourcesCreatedFiles");
  }
  return t("resourcesUploadedFiles");
}
