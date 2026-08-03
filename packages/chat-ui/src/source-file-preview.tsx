import { useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";
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
import { useWorkspaceApiClient } from "./api/workspace-api-client";
import { workspaceQueryKeys } from "./api/workspace-query-keys";
import { useTranslation } from "./i18n";
import { ResourceDownloadButton } from "./resource-download-button";
import { useToolDisplayPanel, type ToolDisplayPanelEntry } from "./tool-display-panel";
import type { ToolArtifactDownloadRef } from "./tool-artifacts";
import { Spinner } from "./ui/spinner";

const SOURCE_FILE_AUTH_SCOPE = "standalone";

const ArtifactPreview = lazy(() =>
  import("./artifact-preview").then((module) => ({ default: module.ArtifactPreview }))
);
const SpreadsheetFilePreview = lazy(() =>
  import("./artifact-preview").then((module) => ({ default: module.SpreadsheetFilePreview }))
);

export type SourceFileResource = Extract<
  ConversationResourceListItem,
  { resourceType: "source_file" }
>;

type OpenSourceFilePreviewInput = {
  client: ApiClient;
  conversationId: string;
  filename?: string;
} & ({ fileId: string } | { attachmentId: string });

export function findSourceFileResource(
  resources: ConversationResourceListItem[],
  fileId: string
): SourceFileResource | undefined {
  return resources.find(
    (resource): resource is SourceFileResource =>
      resource.resourceType === "source_file" &&
      resource.download.fileId === fileId
  );
}

export function findSourceFileResourceByAttachmentId(
  resources: ConversationResourceListItem[],
  attachmentId: string
): SourceFileResource | undefined {
  return resources.find(
    (resource): resource is SourceFileResource =>
      resource.resourceType === "source_file" &&
      resource.attachmentId === attachmentId
  );
}

/**
 * Opens a conversation source file in the display panel, resolving its managed
 * file or attachment id against the conversation's resources first. Shared by
 * attachment chips, structured-data sources, and tool display widgets.
 */
export function useOpenSourceFilePreview(): (
  input: OpenSourceFilePreviewInput
) => Promise<void> {
  const displayPanel = useToolDisplayPanel();
  const queryClient = useQueryClient();
  const { apiBaseUrl } = useWorkspaceApiClient();
  const { t } = useTranslation();

  return useCallback(
    async (input) => {
      const { client, conversationId, filename } = input;
      const sourceId = "fileId" in input ? input.fileId : input.attachmentId;
      const title = filename ?? sourceId;
      displayPanel.show({
        key: `source-file-loading:${sourceId}`,
        title,
        node: (
          <div className="flex min-h-64 items-center justify-center">
            <Spinner size="sm" />
          </div>
        )
      });
      try {
        const response = await queryClient.fetchQuery({
          queryKey: workspaceQueryKeys.conversationResources(
            apiBaseUrl,
            SOURCE_FILE_AUTH_SCOPE,
            conversationId
          ),
          queryFn: () => client.conversationResources(conversationId)
        });
        const resource =
          "fileId" in input
            ? findSourceFileResource(response.resources, input.fileId)
            : findSourceFileResourceByAttachmentId(
                response.resources,
                input.attachmentId
              );
        if (!resource) {
          throw new Error("Source file preview resource was not found");
        }
        displayPanel.show(createSourceFilePreviewEntry({ client, conversationId, resource }));
      } catch {
        displayPanel.show({
          key: `source-file-error:${sourceId}`,
          title,
          node: (
            <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
              {t("resourcesLoadFailed")}
            </div>
          )
        });
      }
    },
    [apiBaseUrl, displayPanel, queryClient, t]
  );
}

export function createSourceFilePreviewEntry({
  client,
  conversationId,
  resource
}: {
  client: ApiClient;
  conversationId: string;
  resource: SourceFileResource;
}): ToolDisplayPanelEntry {
  const headerActions = (
    <ResourceDownloadButton
      client={client}
      conversationId={conversationId}
      resource={resource}
    />
  );

  if (resource.preview.kind === "artifact") {
    const preview: ToolArtifactDownloadRef = {
      artifactId: resource.preview.artifactId,
      mimeType: resource.preview.mimeType
    };
    return {
      key: `resource:${resource.resourceId}`,
      title: resource.title,
      subtitle: resource.subtitle,
      headerActions,
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

  const previewKind = getSourceFilePreviewKind(
    resource.download.filename,
    resource.mimeType
  );
  return {
    key: `resource:${resource.resourceId}`,
    title: resource.title,
    subtitle: resource.subtitle,
    headerActions,
    node: previewKind ? (
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
  const previewKind = getSourceFilePreviewKind(filename, mimeType);
  const pdf = previewKind === "pdf";
  const spreadsheet = previewKind === "spreadsheet";
  const directUrl = client.browserManagedDownloads && previewKind === "image"
    ? client.conversationFileContentUrl(conversationId, fileId)
    : undefined;
  const [url, setUrl] = useState<string | undefined>(directUrl);
  const [blob, setBlob] = useState<Blob | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (directUrl) {
      setUrl(directUrl);
      setBlob(undefined);
      setFailed(false);
      return undefined;
    }

    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setBlob(undefined);
    setFailed(false);
    void client
      .conversationFileContent(conversationId, fileId, pdf)
      .then((blob) => {
        if (active) {
          if (spreadsheet) {
            setBlob(blob);
          } else {
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
          }
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
  }, [client, conversationId, directUrl, fileId, pdf, spreadsheet]);

  if (failed) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        {t("resourcesLoadFailed")}
      </div>
    );
  }
  if (spreadsheet && blob) {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-64 items-center justify-center">
            <Spinner size="sm" />
          </div>
        }
      >
        <SpreadsheetFilePreview blob={blob} />
      </Suspense>
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

export type SourceFilePreviewKind = "image" | "pdf" | "spreadsheet";

export function getSourceFilePreviewKind(
  filename: string,
  mimeType?: string
): SourceFilePreviewKind | undefined {
  if (mimeType?.startsWith("image/")) {
    return "image";
  }
  if (mimeType === "application/pdf") {
    return "pdf";
  }
  const value = `${mimeType ?? ""} ${filename}`.toLowerCase();
  return value.includes("spreadsheet") ||
    value.includes("excel") ||
    /\.(?:xlsx|xlsm|xls)$/i.test(filename)
    ? "spreadsheet"
    : undefined;
}

function FileDetails({
  children,
  resource
}: {
  children: ReactNode;
  resource: SourceFileResource;
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
