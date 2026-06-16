import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Wrench
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import {
  isToolDisplayPayload,
  readToolDisplayPayloadFromToolResult,
  useToolDisplayWidget
} from "./domain-ui-widgets";
import { useTranslation } from "./i18n";
import { cn } from "./ui/cn";
import { Spinner } from "./ui/spinner";

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

interface DataPartProps {
  name: string;
  data: unknown;
}

export function ToolCallPart({ toolName, toolCallId, args, argsText, result, isError, status }: ToolCallMessagePartProps) {
  const { locale, t } = useTranslation();
  const displayWidget = useToolDisplayWidget();
  const state = toolUiState({ isError, result, status });
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
  const detailSections = toolDetailSections({
    args,
    argsText,
    result,
    labels: { input: t("toolInput"), output: t("toolOutput") }
  });
  const summary = getToolSummary(result);
  const statusLabel = toolStatusLabel(state, t);

  if (hasDisplay) {
    return (
      <div
        className={cn("chat-tool-part my-3 max-w-5xl", state === "failed" && "text-destructive")}
        data-testid="tool-call-card"
      >
        <div className="mb-2 flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground">
          <ToolStatusIcon state={state} />
          <span className="truncate font-medium text-foreground">{toolName}</span>
          <span className="shrink-0">{statusLabel}</span>
        </div>
        <div
          className={cn(
            "overflow-hidden rounded-md border bg-card shadow-xs",
            state === "failed" && "border-destructive/40 bg-destructive/5"
          )}
        >
          {renderedDisplay ?? builtInDisplay}
        </div>
        <ToolDetailDisclosure
          sections={detailSections}
          defaultOpen={state === "failed"}
          className="mt-2"
        />
        <span className="sr-only">{toolCallId}</span>
      </div>
    );
  }

  const hasDisclosureContent = Boolean(summary) || detailSections.length > 0;

  if (!hasDisclosureContent) {
    return (
      <div
        className={cn(
          "chat-tool-part my-1 flex max-w-3xl items-center gap-2 rounded-md border border-border/60 bg-card/40 px-2.5 py-2 text-xs text-muted-foreground",
          state === "failed" && "border-destructive/40 bg-destructive/5 text-destructive"
        )}
        data-testid="tool-call-card"
      >
        <ToolStatusIcon state={state} />
        <span className="truncate font-medium text-foreground">{toolName}</span>
        <span className="shrink-0">{statusLabel}</span>
        <span className="sr-only">{toolCallId}</span>
      </div>
    );
  }

  return (
    <CompactToolCall
      detailSections={detailSections}
      state={state}
      statusLabel={statusLabel}
      summary={summary}
      toolCallId={toolCallId}
      toolName={toolName}
    />
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

function toolUiState({
  isError,
  result,
  status
}: {
  isError?: boolean;
  result: unknown;
  status?: ToolCallMessagePartProps["status"];
}): "running" | "completed" | "failed" {
  if (isError || status?.type === "incomplete") {
    return "failed";
  }
  if (status?.type === "running" || status?.type === "requires-action" || result === undefined) {
    return "running";
  }
  return "completed";
}

function toolDetailSections({
  args,
  argsText,
  labels,
  result
}: {
  args: unknown;
  argsText?: string;
  labels: { input: string; output: string };
  result: unknown;
}): Array<{ label: string; value: string }> {
  const input = formatDetails(argsText && argsText.trim().length > 0 ? argsText : args);
  const output = formatDetails(result);
  const sections: Array<{ label: string; value: string }> = [];
  if (input) {
    sections.push({ label: labels.input, value: input });
  }
  if (output) {
    sections.push({ label: labels.output, value: output });
  }
  return sections;
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

function ToolStatusIcon({ state }: { state: "running" | "completed" | "failed" }) {
  if (state === "running") {
    return <Spinner size="sm" className="text-muted-foreground" />;
  }

  const Icon = state === "failed" ? CircleAlert : CheckCircle2;

  return (
    <Icon
      size={14}
      className={cn("shrink-0 text-muted-foreground", state === "failed" && "text-destructive")}
      aria-hidden="true"
    />
  );
}

function CompactToolCall({
  detailSections,
  state,
  statusLabel,
  summary,
  toolCallId,
  toolName
}: {
  detailSections: Array<{ label: string; value: string }>;
  state: "running" | "completed" | "failed";
  statusLabel: string;
  summary: string | undefined;
  toolCallId: string;
  toolName: string;
}) {
  const [open, setOpen] = useState(state === "failed");

  return (
    <div
      className={cn(
        "chat-tool-part my-1 max-w-3xl rounded-md border border-border/60 bg-card/40 text-xs",
        state === "failed" && "border-destructive/40 bg-destructive/5"
      )}
      data-testid="tool-call-card"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <ToolStatusIcon state={state} />
        <span className="truncate font-medium text-foreground">{toolName}</span>
        <span className="shrink-0">{statusLabel}</span>
        <ChevronRight
          size={14}
          className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="grid gap-2 border-t bg-muted/40 px-2.5 py-2">
          {summary ? (
            <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{summary}</p>
          ) : null}
          <ToolDetails sections={detailSections} />
        </div>
      ) : null}
      <span className="sr-only">{toolCallId}</span>
    </div>
  );
}

function ToolDetailDisclosure({
  className,
  defaultOpen,
  sections
}: {
  className?: string;
  defaultOpen?: boolean;
  sections: Array<{ label: string; value: string }>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(Boolean(defaultOpen));

  if (sections.length === 0) {
    return null;
  }

  return (
    <div className={cn("text-xs", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-fit items-center gap-1 px-1 py-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <span>{t("toolDetails")}</span>
        <ChevronRight
          size={13}
          className={cn("transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="mt-1 rounded-md border bg-muted/40 p-2">
          <ToolDetails sections={sections} />
        </div>
      ) : null}
    </div>
  );
}

function ToolDetails({ sections }: { sections: Array<{ label: string; value: string }> }) {
  if (sections.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2">
      {sections.map((section) => (
        <div key={section.label} className="grid gap-1">
          <p className="font-medium text-muted-foreground">{section.label}</p>
          <pre className="max-h-56 overflow-auto rounded-md bg-background/70 px-3 py-2 font-mono text-[0.75rem] leading-5 [overflow-wrap:anywhere]">
            {section.value}
          </pre>
        </div>
      ))}
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
