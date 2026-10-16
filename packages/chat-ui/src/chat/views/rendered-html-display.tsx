import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Banner, Spinner, useUiMode } from "@work-shape/catalyst-ui";
import { THEME_TOKEN_NAMES } from "@work-shape/catalyst-ui/theme";
import { VIEW_SHELL_MESSAGES } from "@work-shape/catalyst-api-client";
import { useTranslation } from "../../shared/i18n";
import { composeViewDocument, viewRunsScripts, type ViewDisplayKind } from "./view-document";
import { useViewPolicy } from "./view-policy";

const RUNTIME_THEME_STYLE_ID = "vivd-catalyst-runtime-theme";

/**
 * The frame grows to its reported content height so the view never scrolls
 * inside itself; only the chat scrolls. The ceiling is a runaway guard, not a
 * layout constraint.
 */
const MAX_FRAME_HEIGHT = 20_000;

const FRAME_HEIGHT_LIMITS = {
  inline: { fallback: 512, min: 220 },
  side_panel: { fallback: 640, min: 320 },
  fullscreen: { fallback: 720, min: 420 }
} as const;

export type ToolDisplayMode = "inline" | "side_panel" | "fullscreen";

/**
 * The one component every generated view passes through. It composes the view document from
 * the stored HTML and the instance's policy of today, then adds the theme found on its host.
 *
 * The frame here is not the view. It holds the shell document the instance serves, and the
 * shell holds the view: the shell's policy is what keeps a view from moving its own frame to
 * another host. The shell says when it is ready, takes the document, and passes on the height
 * and the refused scripts the view reports. The shell has no origin, so its messages carry the
 * origin `null` and the document can be addressed to its window only, not to an origin. That
 * window holds the shell for as long as it lives: only the shell could move it, and does not.
 */
export function RenderedHtmlDisplay({
  html: storedHtml,
  kind,
  mode,
  title
}: {
  html: string;
  kind: ViewDisplayKind;
  mode: ToolDisplayMode;
  title: string;
}) {
  const { t } = useTranslation();
  const { shellUrl, runtime, allowedScriptSrc } = useViewPolicy();
  const runsScripts = viewRunsScripts(kind);
  const html = useMemo(
    () => composeViewDocument({ html: storedHtml, kind, runtime, allowedScriptSrc }),
    [storedHtml, kind, runtime, allowedScriptSrc]
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const htmlRef = useRef<string | undefined>(undefined);
  const frameSourceRef = useRef<string | undefined>(undefined);
  // Each view document gets a shell of its own: the key counts them, and zero is none yet.
  const [shellKey, setShellKey] = useState(0);
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [scriptBlocked, setScriptBlocked] = useState(false);
  const heightLimit = FRAME_HEIGHT_LIMITS[mode];
  const frameHeight = clampNumber(
    contentHeight ?? heightLimit.fallback,
    heightLimit.min,
    MAX_FRAME_HEIGHT
  );
  const frameStyle: CSSProperties = { height: `${frameHeight}px` };

  const refreshFrameDocument = useCallback(() => {
    const host = hostRef.current;
    const nextSrcDoc = host ? injectRuntimeThemeStyle(html, readThemeDeclarations(host)) : html;
    if (frameSourceRef.current === nextSrcDoc) {
      return;
    }
    const htmlChanged = htmlRef.current !== html;
    htmlRef.current = html;
    frameSourceRef.current = nextSrcDoc;
    if (htmlChanged) {
      setContentHeight(undefined);
      setScriptBlocked(false);
    }
    setLoading(true);
    setShellKey((key) => key + 1);
  }, [html]);

  // The frame carries the theme it finds on its host after each render. Reading the mode
  // subscribes this component to the root's mode, so a switch renders it again.
  useUiMode();
  useEffect(refreshFrameDocument);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const shell = iframeRef.current?.contentWindow;
      if (!shell || event.source !== shell || event.origin !== "null" || !isRecord(event.data)) {
        return;
      }
      switch (event.data.type) {
        case VIEW_SHELL_MESSAGES.ready:
          if (frameSourceRef.current !== undefined) {
            shell.postMessage(
              {
                type: VIEW_SHELL_MESSAGES.document,
                document: frameSourceRef.current,
                scripts: runsScripts,
                title
              },
              "*"
            );
          }
          return;
        case VIEW_SHELL_MESSAGES.loaded:
          setLoading(false);
          return;
        case VIEW_SHELL_MESSAGES.blocked:
          setScriptBlocked(true);
          return;
        case VIEW_SHELL_MESSAGES.height:
          if (
            typeof event.data.height === "number" &&
            Number.isFinite(event.data.height) &&
            event.data.height > 0
          ) {
            setContentHeight(Math.ceil(event.data.height));
          }
          return;
        default:
          return;
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [runsScripts, title]);

  return (
    <div ref={hostRef} className="relative bg-background">
      {scriptBlocked ? <Banner tone="warning">{t("displayScriptBlocked")}</Banner> : null}
      {loading ? (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-[color-mix(in_srgb,var(--muted)_30%,var(--background))] text-sm text-muted-foreground"
          style={frameStyle}
          role="status"
        >
          <span className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 shadow-xs">
            <Spinner size="sm" />
            <span>{t("displayLoading")}</span>
          </span>
        </div>
      ) : null}
      {shellKey > 0 ? (
        <iframe
          key={shellKey}
          ref={iframeRef}
          title={title}
          scrolling="no"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={shellUrl}
          className="w-full overflow-hidden border-0 bg-background"
          style={frameStyle}
        />
      ) : (
        <div className="w-full bg-background" style={frameStyle} aria-hidden="true" />
      )}
    </div>
  );
}

function readThemeDeclarations(element: HTMLElement): string {
  const style = window.getComputedStyle(element);
  return THEME_TOKEN_NAMES.flatMap((name) => {
    const value = toSafeCssCustomPropertyValue(style.getPropertyValue(name));
    return value ? [`  ${name}: ${value};`] : [];
  }).join("\n");
}

function injectRuntimeThemeStyle(html: string, declarations: string): string {
  if (!declarations) {
    return html;
  }

  const themeStyle = `<style id="${RUNTIME_THEME_STYLE_ID}">\n:root {\n${declarations}\n}\n</style>`;
  if (/<\/head>/iu.test(html)) {
    return html.replace(/<\/head>/iu, `${themeStyle}\n</head>`);
  }
  return `${themeStyle}\n${html}`;
}

function toSafeCssCustomPropertyValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /[<>{}]/u.test(trimmed)) {
    return undefined;
  }
  return trimmed.replaceAll(";", "");
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
