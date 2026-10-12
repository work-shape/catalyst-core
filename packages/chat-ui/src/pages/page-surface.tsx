import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import type { AppBridgeContext, PagePreviewResponse } from "@vivd-catalyst/api-client";
import {
  Button,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  SegmentedControl,
  SegmentedControlItem
} from "@vivd-catalyst/ui";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { SaveAsAppAction } from "../apps/save-as-app-dialog";
import { useTranslation } from "../i18n";
import type { PageBuildError, SurfaceOf } from "../surface/surface";
import { createPageBridge, type PageBridge } from "./bridge-host";
import { useFrameCallTexts } from "./frame-call-texts";
import { createFrameCalls, type FrameAddress } from "./frame-calls";
import {
  keepPageAddress,
  pageIsGone,
  retryUnlessGone,
  type PageAddressState
} from "./page-address";
import { PageFiles } from "./page-files";
import { usePageHost } from "./page-host";
import { buildErrorCountLabel, buildErrorPlace } from "./page-save";
import { PreviewPane, type PreviewState } from "./preview-pane";

/** The two views of a Page: what it looks like, and the files it is made of. */
export type PageView = "preview" | "files";

/**
 * How often the surface asks whether its Page is still there for the viewer. The address of a
 * Page stops serving within the same time after a viewer lost the conversation.
 */
const PAGE_ACCESS_CHECK_MS = 30_000;

/**
 * What the reader chose per Page, kept while the window lives: the view, and the route the Page
 * last reported. The header's switch and the content stand in different slots of the frame, so
 * the choice lives beside both. A new revision of the Page opens in the same view and on the
 * same route.
 */
const pageViews = new Map<string, PageView>();
const pageRoutes = new Map<string, string>();
const viewListeners = new Set<() => void>();

function subscribeToViews(listener: () => void): () => void {
  viewListeners.add(listener);
  return () => {
    viewListeners.delete(listener);
  };
}

function usePageView(pageId: string): [PageView, (view: PageView) => void] {
  const view = useSyncExternalStore<PageView>(
    subscribeToViews,
    () => pageViews.get(pageId) ?? "preview",
    () => "preview"
  );
  return [
    view,
    (next) => {
      pageViews.set(pageId, next);
      for (const listener of viewListeners) {
        listener();
      }
    }
  ];
}

/** The switch between the views of a Page, in the header of its surface. */
function PageSurfaceActions({ pageId }: { pageId: string }) {
  const { t } = useTranslation();
  const [view, setView] = usePageView(pageId);
  return (
    <SegmentedControl
      size="sm"
      label={t("pages.view")}
      value={view}
      onValueChange={(next) => setView(next === "files" ? "files" : "preview")}
    >
      <SegmentedControlItem value="preview">{t("pages.preview")}</SegmentedControlItem>
      <SegmentedControlItem value="files">{t("pages.files")}</SegmentedControlItem>
    </SegmentedControl>
  );
}

/**
 * What the surface frame shows for a Page: the switch in its header and the revision as its
 * content, which reaches the frame's edges.
 */
export function pageSurfaceRendering(surface: SurfaceOf<"page">): {
  actions: ReactNode;
  content: ReactNode;
  flush: true;
} {
  return {
    actions: (
      <>
        <SaveAsAppAction
          conversationId={surface.conversationId}
          pageId={surface.pageId}
          pageName={surface.title}
        />
        <PageSurfaceActions pageId={surface.pageId} />
      </>
    ),
    content: (
      <PageSurface
        // Another revision is another frame and another list of files.
        key={surface.key}
        name={surface.title}
        conversationId={surface.conversationId}
        pageId={surface.pageId}
        fileSetId={surface.fileSetId}
        buildErrors={surface.buildErrors}
      />
    ),
    flush: true
  };
}

/** An address of the instance as the frame needs it: absolute, on the API's origin. */
export function pageFrameAddress(path: string, apiBaseUrl: string, pageAddress: string): string {
  return new URL(path, new URL(apiBaseUrl, pageAddress)).toString();
}

/**
 * One revision of a Page in the surface slot. It asks the instance for the address of the
 * revision, shows it in a sandboxed frame and answers the Page's bridge. While it is shown it
 * keeps asking whether the Page is still there for the viewer.
 */
function PageSurface({
  name,
  conversationId,
  pageId,
  fileSetId,
  buildErrors
}: {
  name: string;
  conversationId: string;
  pageId: string;
  fileSetId: string;
  buildErrors?: readonly PageBuildError[];
}) {
  const { t } = useTranslation();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const [view] = usePageView(pageId);
  const params = { conversationId, pageId };
  const detail = useQuery({
    queryKey: ["pages", apiBaseUrl, conversationId, pageId, "detail"],
    queryFn: () => client.pages.get({ params }),
    refetchInterval: PAGE_ACCESS_CHECK_MS,
    retry: retryUnlessGone
  });
  const preview = usePageAddress(conversationId, pageId, fileSetId);
  const address = preview.shown;

  const gone = pageIsGone(detail.error) || preview.gone;
  const state: PreviewState = gone
    ? "stopped"
    : address
      ? "ready"
      : preview.failed
        ? "failed"
        : "starting";
  const fileSets = detail.data?.fileSets ?? [];
  const number = address?.number;
  const previousFileSetId =
    number === undefined ? undefined : fileSets.find((set) => set.number === number - 1)?.id;

  return (
    <PageSurfaceView
      view={view}
      buildErrors={gone ? undefined : buildErrors}
      revision={number}
      preview={
        state === "ready" && address ? (
          <LivePagePreview
            title={t("pages.previewOf", { name })}
            pageId={pageId}
            number={address.number}
            session={address.pageSessionId}
            url={pageFrameAddress(address.url, apiBaseUrl, window.location.href)}
            address={address}
          />
        ) : (
          <PreviewPane
            source={undefined}
            state={state}
            title={t("pages.previewOf", { name })}
            message={t(
              state === "stopped"
                ? "pages.gone"
                : state === "failed"
                  ? "pages.loadFailed"
                  : "pages.loading"
            )}
            action={
              // A Page that is gone for the viewer stays gone: asking again changes nothing.
              state !== "failed" ? undefined : (
                <Button variant="outline" size="sm" onClick={preview.again}>
                  {t("pages.retry")}
                </Button>
              )
            }
          />
        )
      }
      files={
        gone ? (
          <PreviewPane
            source={undefined}
            state="stopped"
            title={t("pages.filesList")}
            message={t("pages.gone")}
          />
        ) : (
          <PageFiles
            conversationId={conversationId}
            pageId={pageId}
            fileSetId={fileSetId}
            // Until the history is known, nothing says which files the revision changed.
            previousFileSetId={detail.data && number !== undefined ? previousFileSetId : undefined}
            historyKnown={detail.data !== undefined && number !== undefined}
          />
        )
      }
    />
  );
}

/**
 * The address of one revision for the frame, kept while the surface is mounted: renewed before
 * its token expires, and gone when the instance says the viewer lost the Page.
 */
function usePageAddress(conversationId: string, pageId: string, fileSetId: string) {
  const { client } = useWorkspaceApiClient();
  const [state, setState] = useState<PageAddressState<PagePreviewResponse>>({
    gone: false,
    failed: false
  });
  const keeper = useRef<{ again: () => void }>(undefined);
  useEffect(() => {
    const kept = keepPageAddress(
      () => client.pages.preview({ params: { conversationId, pageId }, body: { fileSetId } }),
      setState
    );
    keeper.current = kept;
    return kept.stop;
  }, [client, conversationId, pageId, fileSetId]);
  const again = useCallback(() => keeper.current?.again(), []);
  return { ...state, again };
}

/**
 * The content of a Page surface: the preview with the build errors as one line under it, or
 * the files. The preview stays mounted under the files, so the Page keeps its state while the
 * reader looks at its source.
 */
export function PageSurfaceView({
  view,
  preview,
  files,
  buildErrors,
  revision
}: {
  view: PageView;
  preview: ReactNode;
  files: ReactNode;
  buildErrors?: readonly PageBuildError[];
  /** The number of the revision the preview shows, once it is known. */
  revision?: number;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-page-view={view}>
      <div className="min-h-0 flex-1" hidden={view !== "preview"}>
        {preview}
      </div>
      {view === "files" ? <div className="min-h-0 flex-1">{files}</div> : null}
      {view === "preview" && buildErrors && buildErrors.length > 0 ? (
        <PageBuildErrors errors={buildErrors} revision={revision} />
      ) : null}
    </div>
  );
}

/**
 * The findings of the build that refused the newest save, folded into one line, and under it
 * what the preview above still shows and what to do about it.
 */
export function PageBuildErrors({
  errors,
  revision
}: {
  errors: readonly PageBuildError[];
  /** The number of the revision the preview shows, once it is known. */
  revision?: number;
}) {
  const { t } = useTranslation();
  return (
    <Disclosure className="shrink-0 border-t bg-card px-4 py-1" data-testid="page-build-errors">
      <DisclosureTrigger>
        <span className="flex items-center gap-2">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
          {buildErrorCountLabel(errors.length, t)}
        </span>
      </DisclosureTrigger>
      {revision === undefined ? null : (
        <p className="pb-1 pl-6 text-caption text-muted-foreground">
          {t(errors.length === 1 ? "pages.errorsKeepRevisionOne" : "pages.errorsKeepRevision", {
            number: revision
          })}
        </p>
      )}
      <DisclosureContent>
        <BuildErrorList errors={errors} className="max-h-40 overflow-y-auto pb-2" />
      </DisclosureContent>
    </Disclosure>
  );
}

/** Each finding with where it lies. */
export function BuildErrorList({
  errors,
  className
}: {
  errors: readonly PageBuildError[];
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <ul className={className}>
      {errors.map((error, index) => (
        <li key={index} className="grid min-w-0 gap-0.5 py-1">
          <span className="font-mono text-caption text-muted-foreground">
            {buildErrorPlace(error, t)}
          </span>
          <span className="text-body break-words text-foreground">{error.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Where a mounted frame starts and where it tells its moves, when that is not the Page's own memory. */
export interface PreviewRoute {
  /** The route the frame opens on, asked each time its document loads. */
  current(): string;
  /** The document moved to this route. */
  changed(path: string): void;
}

/**
 * One built revision in its frame, with the interface's end of the bridge: the frame is told
 * who looks at it and how the interface looks, and it tells where it moved. A Page keeps its
 * route while the window lives; an App hands `route` and keeps it in the address.
 */
export function LivePagePreview({
  title,
  pageId,
  number,
  session,
  url,
  route,
  address
}: {
  /** Names the frame for someone who does not see it. */
  title: string;
  /** What the document is told it is: the id of the Page or of the App. */
  pageId: string;
  number: number;
  session: string;
  url: string;
  route?: PreviewRoute;
  /**
   * The address the instance answered, for the calls the document makes through the bridge.
   * They are made with the viewer's session and name this address. Without it none is made.
   */
  address?: FrameAddress;
}) {
  const { locale } = useTranslation();
  const { client } = useWorkspaceApiClient();
  const host = usePageHost();
  const texts = useFrameCallTexts();
  const calls = useMemo(
    () => (address ? createFrameCalls(client, address, texts) : undefined),
    [client, address, texts]
  );
  const callsRef = useRef(calls);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<PageBridge | undefined>(undefined);
  const routeRef = useRef(route);
  const context: AppBridgeContext | undefined = host
    ? {
        ...host,
        locale,
        pageId,
        fileSetNumber: number,
        initialRoute: route?.current() ?? pageRoutes.get(pageId) ?? "/"
      }
    : undefined;
  // The Page asks when it has loaded, which is later than this render: it gets what holds then.
  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = context;
    routeRef.current = route;
    callsRef.current = calls;
  });
  const hosted = host !== undefined;

  useEffect(() => {
    if (!hosted) {
      return undefined;
    }
    const bridge = createPageBridge({
      frame: () => frameRef.current?.contentWindow,
      session,
      context: () => {
        const current = contextRef.current;
        if (!current) {
          throw new Error("A Page is shown inside a workspace");
        }
        return {
          ...current,
          initialRoute: routeRef.current?.current() ?? pageRoutes.get(pageId) ?? "/"
        };
      },
      onNavigate: (path) => {
        if (routeRef.current) {
          routeRef.current.changed(path);
        } else {
          pageRoutes.set(pageId, path);
        }
      },
      // The frame fills the surface, whatever height the Page's content has.
      onResize: () => undefined,
      calls: () => callsRef.current
    });
    bridgeRef.current = bridge;
    const onMessage = (event: MessageEvent) => bridge.receive(event);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      bridgeRef.current = undefined;
    };
  }, [hosted, pageId, session]);

  const theme = host?.theme;
  const mode = host?.mode;
  useEffect(() => {
    if (theme && mode) {
      bridgeRef.current?.sendLook({ theme, mode });
    }
  }, [mode, theme]);

  return (
    <PreviewPane frameRef={frameRef} source={{ kind: "bundle", url }} state="ready" title={title} />
  );
}
