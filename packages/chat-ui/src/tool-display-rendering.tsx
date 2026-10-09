import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { Spinner, useUiMode } from "@vivd-catalyst/ui";
import { THEME_TOKEN_NAMES } from "@vivd-catalyst/ui/theme";
import { useTranslation } from "./i18n";
import { renderStructuredDataResourceDisplay } from "./structured-data-resource-display";

const DISPLAY_HEIGHT_MESSAGE_TYPE = "vivd-catalyst:display-height";
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

export function readDisplayMode(display: { mode?: unknown } | undefined): ToolDisplayMode {
  if (display?.mode === "side_panel" || display?.mode === "fullscreen") {
    return display.mode;
  }
  return "inline";
}

export function displayPanelKey(
  display: { displayId?: unknown; kind?: unknown } | undefined,
  fallback: string
): string {
  if (typeof display?.displayId === "string" && display.displayId.trim()) {
    return display.displayId;
  }
  if (typeof display?.kind === "string" && display.kind.trim()) {
    return `${display.kind}:${fallback}`;
  }
  return fallback;
}

export function displayPanelTitle(
  display: { kind?: unknown; title?: unknown; data?: unknown } | undefined,
  fallback: string
): string {
  if (typeof display?.title === "string" && display.title.trim()) {
    return display.title;
  }
  const dataTitle =
    isRecord(display?.data) && typeof display.data.title === "string"
      ? display.data.title
      : undefined;
  if (dataTitle?.trim()) {
    return dataTitle;
  }
  if (typeof display?.kind === "string" && display.kind.trim()) {
    return display.kind;
  }
  return fallback;
}

export function renderBuiltInDisplay(display: {
  kind?: unknown;
  mode?: unknown;
  data?: unknown;
}): ReactNode {
  const structuredDataDisplay = renderStructuredDataResourceDisplay(display);
  if (structuredDataDisplay) {
    return structuredDataDisplay;
  }
  if (
    (display.kind !== "html.rendered" && display.kind !== "private_hydrated_view") ||
    !isRecord(display.data) ||
    typeof display.data.html !== "string"
  ) {
    return undefined;
  }
  const title = typeof display.data.title === "string" ? display.data.title : "Rendered HTML";
  const mode = readDisplayMode(display);
  return <RenderedHtmlDisplay html={display.data.html} mode={mode} title={title} />;
}

function RenderedHtmlDisplay({
  html,
  mode,
  title
}: {
  html: string;
  mode: ToolDisplayMode;
  title: string;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const htmlRef = useRef<string | undefined>(undefined);
  const frameSourceRef = useRef<string | undefined>(undefined);
  const [frameDocument, setFrameDocument] = useState<{ key: number; srcDoc?: string }>({ key: 0 });
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
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
    }
    setLoading(true);
    setFrameDocument((currentDocument) => ({
      key: currentDocument.key + 1,
      srcDoc: nextSrcDoc
    }));
  }, [html]);

  // The frame carries the theme it finds on its host after each render. Reading the mode
  // subscribes this component to the root's mode, so a switch renders it again.
  useUiMode();
  useEffect(refreshFrameDocument);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow || !isRecord(event.data)) {
        return;
      }
      if (
        event.data.type !== DISPLAY_HEIGHT_MESSAGE_TYPE ||
        typeof event.data.height !== "number"
      ) {
        return;
      }
      if (!Number.isFinite(event.data.height) || event.data.height <= 0) {
        return;
      }
      setContentHeight(Math.ceil(event.data.height));
    }

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, []);

  return (
    <div ref={hostRef} className="relative bg-background">
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
      {frameDocument.srcDoc ? (
        <iframe
          key={frameDocument.key}
          ref={iframeRef}
          title={title}
          scrolling="no"
          sandbox="allow-scripts"
          srcDoc={frameDocument.srcDoc}
          className="w-full overflow-hidden border-0 bg-background"
          style={frameStyle}
          onLoad={() => setLoading(false)}
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
