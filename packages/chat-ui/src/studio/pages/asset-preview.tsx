import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AssetPreviewResponse } from "@work-shape/catalyst-api-client";
import { Banner, Button, Card } from "@work-shape/catalyst-ui";
import { Eye } from "lucide-react";
import type { SurfaceOf } from "../../chat/surface/surface";
import { useToolDisplayPanel } from "../../chat/tools/tool-display-panel";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation } from "../../shared/i18n";
import { keepPageAddress, type PageAddressState } from "./page-address";
import { usePageConversationId } from "./page-host";
import { LivePagePreview, pageFrameAddress } from "./page-surface";
import { PreviewPane, type PreviewState } from "./preview-pane";

// The draft of an asset whose kind brings a preview, such as a form page, beside the chat: the
// agent saves it with `platform.assets.put`, whose answer says `preview`, and the person sees
// the draft as the kind shows it, with sample content, in the frame a Page is shown in. The
// document is the kind's own: it makes no call and stands in for whatever it shows.

/** The tool whose answer says that a saved draft has a preview. */
const ASSET_PUT_TOOL_NAME = "platform.assets.put";

/** A saved draft with a preview, as the answer of its save says it. */
export interface PreviewedDraft {
  kind: string;
  name: string;
  /** The name people read: the draft's title where the answer says one. */
  title: string;
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The draft a call saved, where the call is a save whose answer says the draft has a preview. */
export function previewedDraftOfCall(call: {
  toolName: string | undefined;
  result: unknown;
  isError?: boolean;
}): PreviewedDraft | undefined {
  if (call.isError === true || call.toolName !== ASSET_PUT_TOOL_NAME || !isRecord(call.result)) {
    return undefined;
  }
  const answer = isRecord(call.result.output) ? call.result.output : call.result;
  const { saved, preview, kind, name, title, revision } = answer;
  if (
    saved !== true ||
    preview !== true ||
    typeof kind !== "string" ||
    typeof name !== "string" ||
    typeof revision !== "number"
  ) {
    return undefined;
  }
  return {
    kind,
    name,
    title: typeof title === "string" && title.trim() !== "" ? title.trim() : name,
    revision
  };
}

/** The surface of one saved draft. Its key names the revision, so each save opens once. */
function assetPreviewSurface(
  conversationId: string,
  draft: PreviewedDraft
): SurfaceOf<"asset_preview"> {
  return {
    kind: "asset_preview",
    key: `asset-preview:${draft.kind}:${draft.name}:${draft.revision}`,
    title: draft.title,
    conversationId,
    assetKind: draft.kind,
    name: draft.name,
    revision: draft.revision
  };
}

/**
 * The surface a run's saves ask for: the newest save with a preview, unless it is shown. Each
 * call counts once: `handled` keeps the ones that did.
 */
export function assetPreviewSurfaceAfterRunCalls(input: {
  conversationId: string;
  parts: readonly {
    type: string;
    toolCallId?: string;
    toolName?: string;
    output?: unknown;
    state?: string;
  }[];
  handled: Set<string>;
}): SurfaceOf<"asset_preview"> | undefined {
  let next: SurfaceOf<"asset_preview"> | undefined;
  for (const part of input.parts) {
    const callId = part.toolCallId;
    if (
      part.type !== "tool_call" ||
      part.state !== "output_available" ||
      callId === undefined ||
      input.handled.has(callId)
    ) {
      continue;
    }
    const draft = previewedDraftOfCall({ toolName: part.toolName, result: part.output });
    if (!draft) continue;
    input.handled.add(callId);
    next = assetPreviewSurface(input.conversationId, draft);
  }
  return next;
}

/** The card of a save with a preview in the thread: it opens the draft beside the chat. */
export function AssetPreviewCard({ draft }: { draft: PreviewedDraft }) {
  const panel = useToolDisplayPanel();
  const conversationId = usePageConversationId();
  const surface =
    conversationId !== undefined && panel.available
      ? assetPreviewSurface(conversationId, draft)
      : undefined;
  return (
    <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
      <AssetPreviewCardView
        draft={draft}
        shown={surface !== undefined && panel.open && panel.entry?.key === surface.key}
        onOpen={surface ? () => panel.show(surface) : undefined}
      />
    </div>
  );
}

export function AssetPreviewCardView({
  draft,
  shown,
  onOpen
}: {
  draft: PreviewedDraft;
  /** This revision is the one the surface slot holds. */
  shown: boolean;
  /** Opens the draft beside the conversation. Absent where there is no slot to open it in. */
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card
      className="flex min-w-0 items-center gap-3 px-4 py-3 text-body"
      data-testid="asset-preview-card"
      data-kind={draft.kind}
      data-revision={draft.revision}
      role="group"
      aria-label={draft.title}
    >
      <Eye aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="truncate font-medium text-foreground">{draft.title}</p>
        <p className="text-caption text-muted-foreground">{t("pages.draftSaved")}</p>
      </div>
      {shown ? (
        <span className="shrink-0 text-caption text-muted-foreground">{t("pages.shown")}</span>
      ) : onOpen ? (
        <Button type="button" size="sm" variant="outline" onClick={onOpen}>
          {t("pages.preview")}
        </Button>
      ) : null}
    </Card>
  );
}

/** What the surface frame shows for a draft with a preview: the frame, to its edges. */
export function assetPreviewSurfaceRendering(surface: SurfaceOf<"asset_preview">): {
  content: ReactNode;
  flush: true;
} {
  return {
    content: (
      <AssetPreviewSurface
        // Another revision is another file set and another frame.
        key={surface.key}
        kind={surface.assetKind}
        name={surface.name}
        title={surface.title}
      />
    ),
    flush: true
  };
}

function AssetPreviewSurface({ kind, name, title }: { kind: string; name: string; title: string }) {
  const { t } = useTranslation();
  const { apiBaseUrl } = useWorkspaceApiClient();
  const preview = useAssetPreviewAddress(kind, name);
  const address = preview.shown;
  const state: PreviewState = preview.gone
    ? "stopped"
    : address
      ? "ready"
      : preview.failed
        ? "failed"
        : "starting";
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="asset-preview-surface">
      <Banner
        layout="line"
        className="shrink-0 border-b bg-card px-4 py-2"
        data-testid="asset-preview-state"
      >
        {t("pages.stateDraftPreview")}
      </Banner>
      <div className="min-h-0 flex-1">
        {state === "ready" && address ? (
          <LivePagePreview
            title={t("pages.previewOf", { name: title })}
            pageId={name}
            number={address.number}
            session={address.pageSessionId}
            url={pageFrameAddress(address.url, apiBaseUrl, window.location.href)}
            address={address}
            makesCalls={false}
          />
        ) : (
          <PreviewPane
            source={undefined}
            state={state}
            title={t("pages.previewOf", { name: title })}
            message={t(
              state === "stopped"
                ? "pages.gone"
                : state === "failed"
                  ? "pages.loadFailed"
                  : "pages.loading"
            )}
            action={
              state !== "failed" ? undefined : (
                <Button variant="outline" size="sm" onClick={preview.again}>
                  {t("pages.retry")}
                </Button>
              )
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * The address of the draft's preview, kept while the surface is mounted: renewed before its
 * token expires, and gone when the instance says the viewer may no longer write the asset.
 */
function useAssetPreviewAddress(kind: string, name: string) {
  const { client } = useWorkspaceApiClient();
  const [state, setState] = useState<PageAddressState<AssetPreviewResponse>>({
    gone: false,
    failed: false
  });
  const keeper = useRef<{ again: () => void }>(undefined);
  useEffect(() => {
    const kept = keepPageAddress(
      () => client.assets.preview({ params: { kind, name }, body: {} }),
      setState
    );
    keeper.current = kept;
    return kept.stop;
  }, [client, kind, name]);
  const again = useCallback(() => keeper.current?.again(), []);
  return { ...state, again };
}
