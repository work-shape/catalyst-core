import type { ApiClient, ArtifactPreviewResponse } from "@vivd-catalyst/api-client";
import { useEffect, useState } from "react";
import { useTranslation } from "./i18n";
import { ArtifactPreviewFrame, ArtifactPreviewMessage } from "./artifact-preview-shell";
import {
  artifactDisplayFilename,
  getArtifactPreviewKind,
  readArtifactImagePagesPreview,
  type ArtifactFileType,
  type ToolArtifactDownloadRef,
  type ToolArtifactImagePagesPreview
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

export function shouldUseLiveArtifactPreviewState(artifact: ToolArtifactDownloadRef): boolean {
  const previewKind = getArtifactPreviewKind(artifact);
  return (
    previewKind === "image-pages" ||
    previewKind === "document" ||
    previewKind === "presentation" ||
    previewKind === "pdf"
  );
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
    artifactPreviewDescriptorHasExtension(descriptor, ["png", "jpg", "jpeg", "webp", "gif"])
  ) {
    return "image";
  }
  if (descriptor.includes("application/pdf") || artifactPreviewDescriptorHasExtension(descriptor, ["pdf"])) {
    return "pdf";
  }
  if (
    descriptor.includes("text/") ||
    descriptor.includes("application/json") ||
    descriptor.includes("markdown") ||
    artifactPreviewDescriptorHasExtension(descriptor, ["txt", "md", "csv", "json", "html", "rtf"])
  ) {
    return "text";
  }
  return undefined;
}

export interface ImagePagesArtifactPreviewLoadPlan {
  key: string;
  pages: ToolArtifactImagePagesPreview["pages"];
}

export function createImagePagesArtifactPreviewLoadPlan(
  artifact: ToolArtifactDownloadRef
): ImagePagesArtifactPreviewLoadPlan | undefined {
  const preview = readArtifactImagePagesPreview(artifact);
  return preview
    ? {
        key: JSON.stringify(preview.pages.map((page) => page.artifactId)),
        pages: preview.pages
      }
    : undefined;
}

export function LiveArtifactPreview({
  artifact,
  client,
  conversationId,
  fileType
}: {
  artifact: ToolArtifactDownloadRef;
  client: ApiClient;
  conversationId: string;
  fileType: ArtifactFileType;
}) {
  const { t } = useTranslation();
  const embeddedPreviewKey = artifactPreviewStateKey(artifact.preview);
  const [state, setState] = useState<{
    apiError: boolean;
    pendingAttempt: number;
    preview?: ArtifactPreviewResponse;
    refreshing: boolean;
  }>(() => ({
    apiError: false,
    pendingAttempt: 0,
    preview: artifact.preview,
    refreshing: Boolean(artifact.preview)
  }));

  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const poll = (pendingAttempt: number) => {
      setState((current) => ({
        apiError: false,
        pendingAttempt,
        preview: current.preview,
        refreshing: true
      }));
      void client
        .conversationArtifactPreview(conversationId, artifact.artifactId)
        .then((preview) => {
          if (cancelled) {
            return;
          }
          setState({
            apiError: false,
            pendingAttempt,
            preview,
            refreshing: false
          });
          const delay = artifactPreviewPollDelayMs({
            status: preview.status,
            pendingAttempt
          });
          if (delay !== undefined) {
            timeout = setTimeout(() => poll(pendingAttempt + 1), delay);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setState({
              apiError: true,
              pendingAttempt,
              preview: undefined,
              refreshing: false
            });
          }
        });
    };

    setState({
      apiError: false,
      pendingAttempt: 0,
      preview: artifact.preview,
      refreshing: Boolean(artifact.preview)
    });
    poll(0);

    return () => {
      cancelled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [artifact.artifactId, client, conversationId, embeddedPreviewKey]);

  const view = createArtifactPreviewView({
    artifact,
    apiError: state.apiError,
    pendingAttempt: state.pendingAttempt,
    preview: state.preview,
    refreshing: state.refreshing
  });

  if (view.kind === "ready") {
    return (
      <ArtifactPreviewFrame>
        <ImagePagesArtifactPreview
          artifact={{ ...artifact, preview: view.preview }}
          client={client}
          conversationId={conversationId}
          fileType={fileType}
        />
      </ArtifactPreviewFrame>
    );
  }

  if (view.kind === "loading" || view.kind === "pending") {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={t("artifactPreviewLoading")}
        detail={artifactDisplayFilename(artifact)}
      />
    );
  }

  if (view.kind === "failed") {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={t("artifactPreviewFailed")}
        detail={artifactPreviewStatusDetail(artifact, view.errorCode)}
      />
    );
  }

  if (view.kind === "unsupported") {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={t("artifactPreviewUnavailable")}
        detail={artifactPreviewStatusDetail(artifact, view.errorCode)}
      />
    );
  }

  return (
    <ArtifactPreviewMessage
      fileType={fileType}
      title={t("artifactPreviewFailed")}
      detail={artifactDisplayFilename(artifact)}
    />
  );
}

function ImagePagesArtifactPreview({
  artifact,
  client,
  conversationId,
  fileType
}: {
  artifact: ToolArtifactDownloadRef;
  client: ApiClient;
  conversationId: string;
  fileType: ArtifactFileType;
}) {
  const { t } = useTranslation();
  const previewPlan = createImagePagesArtifactPreviewLoadPlan(artifact);
  const previewKey = previewPlan?.key ?? "";
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; pages: Array<ToolArtifactImagePagesPreview["pages"][number] & { url: string }> }
    | { status: "failed"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    if (!previewPlan) {
      setState({ status: "failed", message: t("artifactPreviewUnavailable") });
      return undefined;
    }

    let cancelled = false;
    const objectUrls: string[] = [];
    setState({ status: "loading" });
    void Promise.allSettled(
      previewPlan.pages.map(async (page) => {
        const blob = await client.conversationArtifactContent(conversationId, page.artifactId);
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        if (cancelled) {
          URL.revokeObjectURL(url);
        }
        return { ...page, url };
      })
    )
      .then((results) => {
        if (cancelled) {
          revokeObjectUrls(objectUrls);
          return;
        }
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) {
          revokeObjectUrls(objectUrls);
          setState({
            status: "failed",
            message: previewPageErrorMessage(rejected.reason, t("artifactPreviewFailed"))
          });
          return;
        }
        const pages = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
        setState({ status: "ready", pages });
      });

    return () => {
      cancelled = true;
      revokeObjectUrls(objectUrls);
    };
  }, [client, conversationId, previewKey, t]);

  if (state.status === "loading") {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={t("artifactPreviewLoading")}
        detail={artifactDisplayFilename(artifact)}
      />
    );
  }

  if (state.status === "failed") {
    return (
      <ArtifactPreviewMessage
        fileType={fileType}
        title={previewPlan ? t("artifactPreviewFailed") : t("artifactPreviewUnavailable")}
        detail={state.message}
      />
    );
  }

  return (
    <div className="chat-scrollbar h-full overflow-auto bg-slate-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-6">
        {state.pages.map((page, index) => (
          <img
            key={page.artifactId}
            src={page.url}
            alt={imagePageAltText(artifact, page, index)}
            className="mx-auto block h-auto w-full rounded-sm bg-white object-contain shadow-sm ring-1 ring-border/70"
          />
        ))}
      </div>
    </div>
  );
}

function revokeObjectUrls(urls: readonly string[]): void {
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
}

function previewPageErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function artifactPreviewDescriptorHasExtension(value: string, extensions: string[]): boolean {
  return extensions.some((extension) =>
    new RegExp(`\\.${escapeArtifactPreviewRegExp(extension)}(?:\\s|$)`, "iu").test(value)
  );
}

function escapeArtifactPreviewRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function artifactPreviewStateKey(preview: ArtifactPreviewResponse | undefined): string {
  if (!preview) {
    return "";
  }
  if (preview.status !== "ready") {
    return `${preview.status}:${preview.artifactId}`;
  }
  return `${preview.status}:${preview.artifactId}:${preview.pages.map((page) => page.artifactId).join("|")}`;
}

function artifactPreviewStatusDetail(artifact: ToolArtifactDownloadRef, errorCode: string | undefined): string {
  const filename = artifactDisplayFilename(artifact);
  return errorCode ? `${filename}: ${errorCode}` : filename;
}

function imagePageAltText(
  artifact: ToolArtifactDownloadRef,
  page: ToolArtifactImagePagesPreview["pages"][number],
  index: number
): string {
  const ordinal = page.slideNumber ?? page.pageNumber ?? index + 1;
  return `${artifactDisplayFilename(artifact)} ${ordinal}`;
}
