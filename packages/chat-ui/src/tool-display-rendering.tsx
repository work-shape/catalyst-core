import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const DISPLAY_HEIGHT_MESSAGE_TYPE = "vivd-catalyst:display-height";
const RUNTIME_THEME_STYLE_ID = "vivd-catalyst-runtime-theme";
const THEME_CSS_VARIABLE_NAMES = [
  "--radius",
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--success",
  "--warning",
  "--info",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--border",
  "--input",
  "--ring",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring"
] as const;

const FRAME_HEIGHT_LIMITS = {
  inline: { fallback: 512, min: 220, max: 1400 },
  side_panel: { fallback: 640, min: 320, max: 1800 },
  fullscreen: { fallback: 720, min: 420, max: 2400 }
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
  const dataTitle = isRecord(display?.data) && typeof display.data.title === "string" ? display.data.title : undefined;
  if (dataTitle?.trim()) {
    return dataTitle;
  }
  if (typeof display?.kind === "string" && display.kind.trim()) {
    return display.kind;
  }
  return fallback;
}

export function renderBuiltInDisplay(display: { kind?: unknown; mode?: unknown; data?: unknown }): ReactNode {
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
  const hostRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameDocument, setFrameDocument] = useState<{ key: number; srcDoc?: string }>({ key: 0 });
  const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
  const heightLimit = FRAME_HEIGHT_LIMITS[mode];
  const frameHeight = clampNumber(contentHeight ?? heightLimit.fallback, heightLimit.min, heightLimit.max);
  const frameStyle: CSSProperties = { height: `${frameHeight}px` };

  useEffect(() => {
    setContentHeight(undefined);
  }, [html]);

  useEffect(() => {
    const host = hostRef.current;
    const nextSrcDoc = host ? injectRuntimeThemeStyle(html, readThemeDeclarations(host)) : html;
    setFrameDocument((currentDocument) =>
      currentDocument.srcDoc === nextSrcDoc
        ? currentDocument
        : { key: currentDocument.key + 1, srcDoc: nextSrcDoc }
    );
  });

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow || !isRecord(event.data)) {
        return;
      }
      if (event.data.type !== DISPLAY_HEIGHT_MESSAGE_TYPE || typeof event.data.height !== "number") {
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
    <div ref={hostRef} className="bg-background">
      <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">{title}</div>
      {frameDocument.srcDoc ? (
        <iframe
          key={frameDocument.key}
          ref={iframeRef}
          title={title}
          sandbox="allow-scripts"
          srcDoc={frameDocument.srcDoc}
          className="w-full border-0 bg-background"
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
  return THEME_CSS_VARIABLE_NAMES.flatMap((name) => {
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
