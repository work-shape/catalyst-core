import { Download, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ApiClient, ArtifactPreviewResponse } from "@vivd-catalyst/api-client";
import { useTranslation } from "./i18n";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Spinner } from "./ui/spinner";
import {
  artifactDisplayFilename,
  getArtifactFileType,
  type ToolArtifactDownloadRef
} from "./tool-artifacts";

export const ARTIFACT_PREVIEW_POLL_DELAYS_MS = [
  1000,
  2000,
  3000,
  5000,
  5000,
  5000,
  5000,
  5000
] as const;

type ReadyArtifactPreview = Extract<ArtifactPreviewResponse, { status: "ready" }>;

export type ArtifactSourceFallbackKind = "image" | "pdf" | "text";

export type ArtifactPreviewView =
  | {
      kind: "loading";
      fallbackKind?: ArtifactSourceFallbackKind;
    }
  | {
      kind: "pending";
      pollDelayMs?: number;
      fallbackKind?: ArtifactSourceFallbackKind;
    }
  | {
      kind: "ready";
      preview: ReadyArtifactPreview;
      refreshing: boolean;
      fallbackKind?: ArtifactSourceFallbackKind;
    }
  | {
      kind: "failed" | "unsupported";
      errorCode?: string;
      fallbackKind?: ArtifactSourceFallbackKind;
    }
  | {
      kind: "error";
      fallbackKind?: ArtifactSourceFallbackKind;
    };

export function artifactPreviewPollDelayMs(input: {
  status: ArtifactPreviewResponse["status"];
  pendingAttempt: number;
}): number | undefined {
  if (input.status !== "pending") {
    return undefined;
  }
  return ARTIFACT_PREVIEW_POLL_DELAYS_MS[input.pendingAttempt];
}

export function createArtifactPreviewView(input: {
  artifact: ToolArtifactDownloadRef;
  preview?: ArtifactPreviewResponse;
  refreshing: boolean;
  apiError: boolean;
  pendingAttempt: number;
}): ArtifactPreviewView {
  const fallbackKind = getArtifactSourceFallbackKind(input.artifact);
  if (input.apiError) {
    return { kind: "error", fallbackKind };
  }
  if (!input.preview) {
    return { kind: "loading", fallbackKind };
  }
  if (input.preview.status === "ready") {
    return {
      kind: "ready",
      preview: input.preview,
      refreshing: input.refreshing,
      fallbackKind
    };
  }
  if (input.preview.status === "pending") {
    return {
      kind: "pending",
      pollDelayMs: artifactPreviewPollDelayMs({
        status: input.preview.status,
        pendingAttempt: input.pendingAttempt
      }),
      fallbackKind
    };
  }
  return {
    kind: input.preview.status,
    errorCode: input.preview.errorCode,
    fallbackKind
  };
}

export function getArtifactSourceFallbackKind(
  artifact: ToolArtifactDownloadRef
): ArtifactSourceFallbackKind | undefined {
  const descriptor = `${artifact.mimeType ?? ""} ${artifact.kind ?? ""} ${artifact.filename ?? ""}`.toLowerCase();
  if (
    descriptor.includes("image/png") ||
    descriptor.includes("image/jpeg") ||
    descriptor.includes("image/webp") ||
    descriptor.includes("image/gif") ||
    hasExtension(descriptor, ["png", "jpg", "jpeg", "webp", "gif"])
  ) {
    return "image";
  }
  if (descriptor.includes("application/pdf") || hasExtension(descriptor, ["pdf"])) {
    return "pdf";
  }
  if (
    descriptor.includes("text/") ||
    descriptor.includes("application/json") ||
    descriptor.includes("markdown") ||
    hasExtension(descriptor, ["txt", "md", "csv", "json", "html", "rtf"])
  ) {
    return "text";
  }
  return undefined;
}

export function ArtifactPreviewPanel({
  artifact,
  client,
  conversationId,
  onDownload
}: {
  artifact: ToolArtifactDownloadRef;
  client: ApiClient;
  conversationId: string;
  onDownload: (artifact: ToolArtifactDownloadRef) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ArtifactPreviewResponse | undefined>(() => artifact.preview);
  const [refreshing, setRefreshing] = useState(true);
  const [apiError, setApiError] = useState(false);
  const [pendingAttempt, setPendingAttempt] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const filename = artifactDisplayFilename(artifact);
  const fileType = getArtifactFileType(artifact);
  const view = useMemo(
    () => createArtifactPreviewView({ artifact, preview, refreshing, apiError, pendingAttempt }),
    [apiError, artifact, pendingAttempt, preview, refreshing]
  );

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    setPreview(artifact.preview);
    setApiError(false);
    setPendingAttempt(0);

    async function loadPreview(attempt: number) {
      setRefreshing(true);
      try {
        const nextPreview = await client.conversationArtifactPreview(conversationId, artifact.artifactId);
        if (!active) {
          return;
        }
        setPreview(nextPreview);
        setApiError(false);
        setRefreshing(false);
        if (nextPreview.status === "pending") {
          setPendingAttempt(attempt);
          const delayMs = artifactPreviewPollDelayMs({
            status: nextPreview.status,
            pendingAttempt: attempt
          });
          if (delayMs !== undefined) {
            timer = window.setTimeout(() => {
              void loadPreview(attempt + 1);
            }, delayMs);
          }
        }
      } catch {
        if (!active) {
          return;
        }
        setApiError(true);
        setRefreshing(false);
      }
    }

    void loadPreview(0);

    return () => {
      active = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [artifact.artifactId, artifact.preview, client, conversationId]);

  return (
    <div className="grid gap-4">
      <div className="flex min-w-0 items-center gap-3 rounded-md border bg-card px-3 py-2 shadow-xs">
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-md text-[10px] font-bold text-white",
            fileType.className
          )}
          aria-hidden="true"
        >
          {fileType.badge}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{filename}</p>
          <p className="truncate text-xs text-muted-foreground">{artifact.mimeType ?? fileType.label}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={downloading}
          onClick={() => {
            setDownloading(true);
            void (async () => {
              try {
                await onDownload(artifact);
              } finally {
                setDownloading(false);
              }
            })();
          }}
        >
          {downloading ? <Spinner size="sm" aria-hidden="true" /> : <Download aria-hidden="true" />}
          {t("downloadFile")}
        </Button>
      </div>
      <ArtifactPreviewContent
        artifact={artifact}
        client={client}
        conversationId={conversationId}
        filename={filename}
        view={view}
      />
    </div>
  );
}

function ArtifactPreviewContent({
  artifact,
  client,
  conversationId,
  filename,
  view
}: {
  artifact: ToolArtifactDownloadRef;
  client: ApiClient;
  conversationId: string;
  filename: string;
  view: ArtifactPreviewView;
}) {
  const { t } = useTranslation();

  if (view.kind === "loading") {
    return <ArtifactPreviewStatus tone="neutral" icon="spinner" title={t("previewLoading")} />;
  }

  if (view.kind === "pending") {
    return (
      <ArtifactPreviewStatus
        tone="neutral"
        icon="spinner"
        title={view.pollDelayMs === undefined ? t("previewPendingLong") : t("previewPending")}
      />
    );
  }

  if (view.kind === "ready") {
    return (
      <div className="grid gap-3">
        {view.refreshing ? (
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Spinner size="sm" aria-hidden="true" />
            {t("previewRefreshing")}
          </div>
        ) : null}
        <ArtifactPreviewImagePages
          client={client}
          conversationId={conversationId}
          filename={filename}
          preview={view.preview}
        />
      </div>
    );
  }

  if (view.kind === "failed") {
    return (
      <ArtifactTerminalPreviewState
        artifact={artifact}
        client={client}
        conversationId={conversationId}
        fallbackKind={view.fallbackKind}
        filename={filename}
        title={t("previewFailed")}
      />
    );
  }

  if (view.kind === "unsupported") {
    return (
      <ArtifactTerminalPreviewState
        artifact={artifact}
        client={client}
        conversationId={conversationId}
        fallbackKind={view.fallbackKind}
        filename={filename}
        title={t("previewUnsupported")}
      />
    );
  }

  return (
    <ArtifactTerminalPreviewState
      artifact={artifact}
      client={client}
      conversationId={conversationId}
      fallbackKind={view.fallbackKind}
      filename={filename}
      title={t("previewApiError")}
    />
  );
}

function ArtifactPreviewImagePages({
  client,
  conversationId,
  filename,
  preview
}: {
  client: ApiClient;
  conversationId: string;
  filename: string;
  preview: ReadyArtifactPreview;
}) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<
    | { status: "loading" }
    | {
        status: "ready";
        pages: Array<{ page: ReadyArtifactPreview["pages"][number]; url: string }>;
      }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    setPages({ status: "loading" });

    void Promise.all(
      preview.pages.map(async (page) => {
        const blob = await client.conversationArtifactContent(conversationId, page.artifactId);
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        return { page, url };
      })
    )
      .then((loadedPages) => {
        if (!active) {
          for (const loadedPage of loadedPages) {
            URL.revokeObjectURL(loadedPage.url);
          }
          return;
        }
        setPages({ status: "ready", pages: loadedPages });
      })
      .catch(() => {
        for (const url of objectUrls) {
          URL.revokeObjectURL(url);
        }
        if (active) {
          setPages({ status: "error" });
        }
      });

    return () => {
      active = false;
      for (const url of objectUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [client, conversationId, preview]);

  if (preview.pages.length === 0) {
    return <ArtifactPreviewStatus tone="warning" icon="warning" title={t("previewFailed")} />;
  }

  if (pages.status === "loading") {
    return <ArtifactPreviewStatus tone="neutral" icon="spinner" title={t("previewPagesLoading")} />;
  }

  if (pages.status === "error") {
    return <ArtifactPreviewStatus tone="warning" icon="warning" title={t("previewPagesFailed")} />;
  }

  return (
    <div className="grid gap-4">
      {pages.pages.map(({ page, url }, index) => (
        <figure key={`${page.artifactId}:${index}`} className="overflow-hidden rounded-md border bg-card shadow-xs">
          <img
            src={url}
            alt={previewPageLabel(page, filename, index)}
            className="h-auto w-full bg-white object-contain"
          />
          <figcaption className="border-t px-3 py-2 text-xs text-muted-foreground">
            {previewPageLabel(page, filename, index)}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function ArtifactTerminalPreviewState({
  artifact,
  client,
  conversationId,
  fallbackKind,
  filename,
  title
}: {
  artifact: ToolArtifactDownloadRef;
  client: ApiClient;
  conversationId: string;
  fallbackKind?: ArtifactSourceFallbackKind;
  filename: string;
  title: string;
}) {
  return (
    <div className="grid gap-3">
      <ArtifactPreviewStatus tone="warning" icon="warning" title={title} />
      {fallbackKind ? (
        <ArtifactSourceFallbackPreview
          artifact={artifact}
          client={client}
          conversationId={conversationId}
          filename={filename}
          kind={fallbackKind}
        />
      ) : null}
    </div>
  );
}

function ArtifactSourceFallbackPreview({
  artifact,
  client,
  conversationId,
  filename,
  kind
}: {
  artifact: ToolArtifactDownloadRef;
  client: ApiClient;
  conversationId: string;
  filename: string;
  kind: ArtifactSourceFallbackKind;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<
    | { status: "loading" }
    | { status: "url"; url: string }
    | { status: "text"; text: string }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    setSource({ status: "loading" });

    void client
      .conversationArtifactContent(conversationId, artifact.artifactId)
      .then(async (blob) => {
        if (kind === "text") {
          const text = await blob.text();
          if (active) {
            setSource({ status: "text", text });
          }
          return;
        }
        const objectUrl = URL.createObjectURL(blob);
        objectUrls.push(objectUrl);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setSource({ status: "url", url: objectUrl });
      })
      .catch(() => {
        if (active) {
          setSource({ status: "error" });
        }
      });

    return () => {
      active = false;
      for (const objectUrl of objectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [artifact.artifactId, client, conversationId, kind]);

  if (source.status === "loading") {
    return <ArtifactPreviewStatus tone="neutral" icon="spinner" title={t("previewFallbackLoading")} />;
  }

  if (source.status === "error") {
    return <ArtifactPreviewStatus tone="warning" icon="warning" title={t("previewFallbackFailed")} />;
  }

  if (source.status === "text") {
    return (
      <pre className="chat-scrollbar max-h-[70vh] overflow-auto rounded-md border bg-card p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]">
        {source.text}
      </pre>
    );
  }

  if (kind === "image") {
    return (
      <figure className="overflow-hidden rounded-md border bg-card shadow-xs">
        <img src={source.url} alt={filename} className="h-auto max-h-[70vh] w-full object-contain" />
      </figure>
    );
  }

  return (
    <iframe
      src={source.url}
      title={filename}
      className="h-[70vh] w-full rounded-md border bg-card"
    />
  );
}

function ArtifactPreviewStatus({
  icon,
  title,
  tone
}: {
  icon: "spinner" | "warning";
  title: string;
  tone: "neutral" | "warning";
}) {
  return (
    <div
      className={cn(
        "flex min-h-28 items-center gap-3 rounded-md border bg-card px-4 py-3 text-sm shadow-xs",
        tone === "warning" && "border-border/80"
      )}
      role="status"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        {icon === "spinner" ? (
          <Spinner size="sm" aria-hidden="true" />
        ) : (
          <TriangleAlert size={18} aria-hidden="true" />
        )}
      </span>
      <span className="font-medium">{title}</span>
    </div>
  );
}

function previewPageLabel(
  page: ReadyArtifactPreview["pages"][number],
  filename: string,
  index: number
): string {
  if (page.pageNumber) {
    return `${filename} page ${page.pageNumber}`;
  }
  if (page.slideNumber) {
    return `${filename} slide ${page.slideNumber}`;
  }
  return `${filename} preview ${index + 1}`;
}

function hasExtension(value: string, extensions: string[]): boolean {
  return extensions.some((extension) => new RegExp(`\\.${escapeRegExp(extension)}(?:\\s|$)`, "iu").test(value));
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
