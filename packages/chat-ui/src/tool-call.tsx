import {
  CheckCircle2,
  CircleAlert,
  Loader2,
  Wrench
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  isToolDisplayPayload,
  readToolDisplayPayloadFromToolResult,
  useToolDisplayWidget
} from "./domain-ui-widgets";
import { useTranslation } from "./i18n";
import { cn } from "./ui/cn";

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

interface ToolCallPartProps {
  toolName: string;
  toolCallId: string;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
}

interface DataPartProps {
  name: string;
  data: unknown;
}

export function ToolCallPart({ toolName, toolCallId, argsText, result, isError }: ToolCallPartProps) {
  const { locale, t } = useTranslation();
  const displayWidget = useToolDisplayWidget();
  const state = isError ? "failed" : result === undefined ? "running" : "completed";
  const Icon = state === "running" ? Loader2 : state === "failed" ? CircleAlert : CheckCircle2;
  const display = readToolDisplayPayloadFromToolResult(result);
  const renderedDisplay =
    display && displayWidget
      ? displayWidget({
          display,
          locale,
          source: "tool-result",
          toolName,
          toolCallId,
          result
        })
      : undefined;
  const builtInDisplay = display && !hasRenderedNode(renderedDisplay) ? renderBuiltInDisplay(display) : undefined;
  const hasDisplay = hasRenderedNode(renderedDisplay) || hasRenderedNode(builtInDisplay);
  const details = formatDetails(result ?? argsText);

  return (
    <div
      className={cn(
        "chat-tool-part my-2 rounded-md border bg-card shadow-xs",
        hasDisplay ? "max-w-5xl" : "max-w-3xl",
        state === "failed" && "border-destructive/40 bg-destructive/5"
      )}
      data-testid="tool-call-card"
    >
      <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          {state === "running" ? (
            <Icon className="animate-spin" size={15} aria-hidden="true" />
          ) : (
            <Icon size={15} aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{toolName}</p>
          <p className="truncate text-xs text-muted-foreground">{toolStatusLabel(state, t)}</p>
        </div>
        <Wrench size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
      {hasDisplay ? (
        <div className="border-b">{renderedDisplay ?? builtInDisplay}</div>
      ) : (
        <ToolSummary result={result} />
      )}
      {details ? (
        <details className="group/tool text-xs" open={state === "failed"}>
          <summary className="cursor-pointer px-3 py-2 text-muted-foreground outline-none transition-colors hover:text-foreground">
            {t("toolDetails")}
          </summary>
          <pre className="max-h-56 overflow-auto border-t bg-muted/50 px-3 py-2 font-mono text-[0.75rem] leading-5 [overflow-wrap:anywhere]">
            {details}
          </pre>
        </details>
      ) : null}
      <span className="sr-only">{toolCallId}</span>
    </div>
  );
}

export function DataPart({ name, data }: DataPartProps) {
  const { locale, t } = useTranslation();
  const displayWidget = useToolDisplayWidget();
  const renderedDisplay =
    isToolDisplayPayload(data) && displayWidget
      ? displayWidget({
          display: data,
          locale,
          source: "message-metadata"
        })
      : undefined;
  const builtInDisplay =
    isToolDisplayPayload(data) && !hasRenderedNode(renderedDisplay) ? renderBuiltInDisplay(data) : undefined;
  const hasDisplay = hasRenderedNode(renderedDisplay) || hasRenderedNode(builtInDisplay);
  const details = formatDetails(data);

  if (hasDisplay) {
    return (
      <div className="chat-tool-part my-2 max-w-5xl rounded-md border bg-card shadow-xs">
        {renderedDisplay ?? builtInDisplay}
      </div>
    );
  }

  return (
    <div className="chat-tool-part my-2 max-w-3xl rounded-md border bg-card px-3 py-2 text-sm shadow-xs">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Wrench size={14} aria-hidden="true" />
        <span>{t("structuredOutput", { name })}</span>
      </div>
      {details ? (
        <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-5 [overflow-wrap:anywhere]">
          {details}
        </pre>
      ) : null}
    </div>
  );
}

function toolStatusLabel(
  state: "running" | "completed" | "failed",
  t: ReturnType<typeof useTranslation>["t"]
): string {
  if (state === "running") {
    return t("toolRunning");
  }
  if (state === "failed") {
    return t("toolFailed");
  }
  return t("toolCompleted");
}

function formatDetails(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolSummary({ result }: { result: unknown }) {
  const summary = getToolSummary(result);
  if (!summary) {
    return null;
  }
  return (
    <div className="border-b px-3 py-2 text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
      {summary}
    </div>
  );
}

function getToolSummary(result: unknown): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const notice = isRecord(result.projectionNotice) ? result.projectionNotice : undefined;
  if (notice?.type === "tool_output_bounded") {
    return "This tool output was partially loaded into the agent context. The full output is stored with the conversation.";
  }
  if (typeof result.output === "string") {
    return result.output;
  }
  return undefined;
}

function renderBuiltInDisplay(display: { kind?: unknown; mode?: unknown; data?: unknown }): ReactNode {
  if (
    (display.kind !== "html.rendered" && display.kind !== "private_hydrated_view") ||
    !isRecord(display.data) ||
    typeof display.data.html !== "string"
  ) {
    return undefined;
  }
  const title = typeof display.data.title === "string" ? display.data.title : "Rendered HTML";
  const mode = display.mode === "side_panel" || display.mode === "fullscreen" ? display.mode : "inline";
  return <RenderedHtmlDisplay html={display.data.html} mode={mode} title={title} />;
}

function RenderedHtmlDisplay({
  html,
  mode,
  title
}: {
  html: string;
  mode: "inline" | "side_panel" | "fullscreen";
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

function hasRenderedNode(value: ReactNode): boolean {
  return value !== undefined && value !== null && value !== false;
}
