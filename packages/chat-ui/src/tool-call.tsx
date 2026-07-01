import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Wrench
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { LocaleCode } from "@vivd-catalyst/api-client";
import {
  isToolDisplayPayload,
  readToolDisplayPayloadFromToolResult,
  useToolDisplayWidget
} from "./domain-ui-widgets";
import {
  displayPanelKey,
  displayPanelTitle,
  readDisplayMode,
  renderBuiltInDisplay
} from "./tool-display-rendering";
import { ToolArtifactList } from "./artifact-download-card";
import { useTranslation } from "./i18n";
import { useToolDisplayPanel } from "./tool-display-panel";
import { cn } from "./ui/cn";
import { Spinner } from "./ui/spinner";
import {
  readWorkspacePromotedArtifactsData,
  readSurfacedToolArtifactRefs,
  readToolArtifactRefs,
  type ToolArtifactDownloadRef
} from "./tool-artifacts";
import { ToolSurfaceList } from "./tool-surface-card";
import { readWorkspacePromotedSurfacesData } from "./tool-surfaces";
import { projectWorkspaceToolDisplay, type ToolDetailSection } from "./workspace-tool-display";

interface DataPartProps {
  name: string;
  data: unknown;
  autoPreviewSurfaces?: boolean;
  displayPresentation?: "full" | "summary";
}

export function ToolCallPart({
  toolName,
  toolCallId,
  args,
  argsText,
  result,
  isError,
  status,
  displayPresentation = "full"
}: ToolCallMessagePartProps & {
  displayPresentation?: "full" | "summary";
}) {
  const { locale, t } = useTranslation();
  const displayPanel = useToolDisplayPanel();
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
  const displayMode = readDisplayMode(display);
  const workspaceProjection = projectWorkspaceToolDisplay({ args, result, toolName });
  const toolDisplay = readToolDisplayProjection({ args, result, toolName, locale });
  const detailSections = workspaceProjection?.sections ?? toolDetailSections({
    args,
    argsText,
    toolName,
    result,
    labels: { input: t("toolInput"), output: t("toolOutput") }
  });
  const artifacts = readToolArtifactRefs(result);
  const surfacedArtifacts = readSurfacedToolArtifactRefs(result, toolName);
  const summary = workspaceProjection?.summary ?? getToolSummary(result, t);
  const statusLabel = toolStatusLabel(state, t);
  const actionLabel = workspaceProjection?.actionLabel ?? toolDisplay.actionLabel;

  if (hasDisplay && displayPresentation === "full") {
    if (displayMode === "side_panel" && displayPanel.available) {
      return (
        <SidePanelToolCall
          actionLabel={actionLabel}
          detailSections={detailSections}
          display={display}
          displayNode={renderedDisplay ?? builtInDisplay}
          state={state}
          statusLabel={statusLabel}
          artifacts={surfacedArtifacts}
          toolCallId={toolCallId}
          toolTitle={toolDisplay.title}
        />
      );
    }

    return (
      <DisplayToolCall
        actionLabel={actionLabel}
        detailSections={detailSections}
        displayNode={renderedDisplay ?? builtInDisplay}
        state={state}
        statusLabel={statusLabel}
        artifacts={artifacts}
        surfacedArtifacts={surfacedArtifacts}
        toolCallId={toolCallId}
        toolTitle={toolDisplay.title}
      />
    );
  }

  const hasDisclosureContent = Boolean(summary) || artifacts.length > 0 || detailSections.length > 0;

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
        <span className="truncate font-medium text-foreground">{toolDisplay.title}</span>
        {actionLabel ? <span className="min-w-0 truncate">{actionLabel}</span> : null}
        <span className="shrink-0">{statusLabel}</span>
        <span className="sr-only">{toolCallId}</span>
      </div>
    );
  }

  return (
    <CompactToolCall
      actionLabel={actionLabel}
      detailSections={detailSections}
      state={state}
      statusLabel={statusLabel}
      summary={summary}
      artifacts={artifacts}
      surfacedArtifacts={surfacedArtifacts}
      toolCallId={toolCallId}
      toolTitle={toolDisplay.title}
    />
  );
}

export function DataPart({
  autoPreviewSurfaces = false,
  displayPresentation = "full",
  name,
  data
}: DataPartProps) {
  const { locale, t } = useTranslation();
  const displayPanel = useToolDisplayPanel();
  const displayWidget = useToolDisplayWidget();
  const promotedArtifacts = readWorkspacePromotedArtifactsData(data);
  if (promotedArtifacts) {
    return (
      <div className="chat-tool-part my-3 max-w-3xl">
        <ToolArtifactList artifacts={promotedArtifacts.artifacts} variant="deliverable" autoPreview />
      </div>
    );
  }
  const promotedSurfaces = readWorkspacePromotedSurfacesData(data);
  if (promotedSurfaces) {
    return (
      <div className="chat-tool-part my-3 max-w-5xl">
        <ToolSurfaceList autoPreview={autoPreviewSurfaces} surfaces={promotedSurfaces.surfaces} />
      </div>
    );
  }
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
  const displayMode = isToolDisplayPayload(data) ? readDisplayMode(data) : "inline";
  const details = formatDetails(data);

  if (hasDisplay && displayPresentation === "full") {
    if (displayMode === "side_panel" && displayPanel.available && isToolDisplayPayload(data)) {
      return <SidePanelDataPart display={data} displayNode={renderedDisplay ?? builtInDisplay} name={name} />;
    }

    return <DisplayDataPart displayNode={renderedDisplay ?? builtInDisplay} name={name} />;
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

function SidePanelToolCall({
  actionLabel,
  detailSections,
  display,
  displayNode,
  state,
  statusLabel,
  artifacts,
  toolCallId,
  toolTitle
}: {
  actionLabel?: string;
  detailSections: ToolDetailSection[];
  display: ReturnType<typeof readToolDisplayPayloadFromToolResult>;
  displayNode: ReactNode;
  state: "running" | "completed" | "failed";
  statusLabel: string;
  artifacts: ToolArtifactDownloadRef[];
  toolCallId: string;
  toolTitle: string;
}) {
  const { t } = useTranslation();
  const panel = useToolDisplayPanel();
  const panelKey = displayPanelKey(display, toolCallId);
  const title = displayPanelTitle(display, toolTitle);
  const panelActive = panel.open && panel.entry?.key === panelKey;
  const subtitle = actionLabel ? `${toolTitle}: ${actionLabel}` : toolTitle;

  useEffect(() => {
    panel.showOnce({
      key: panelKey,
      title,
      subtitle,
      node: displayNode
    });
  }, [displayNode, panel, panelKey, subtitle, title]);

  return (
    <div
      className={cn(
        "chat-tool-part my-3 max-w-3xl rounded-md border border-border/60 bg-card/40 text-xs",
        state === "failed" && "border-destructive/40 bg-destructive/5"
      )}
      data-testid="tool-call-card"
    >
      <button
        type="button"
        onClick={() =>
          panel.show({
            key: panelKey,
            title,
            subtitle,
            node: displayNode
          })
        }
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <ToolStatusIcon state={state} />
        <span className="truncate font-medium text-foreground">{toolTitle}</span>
        {actionLabel ? <span className="min-w-0 truncate">{actionLabel}</span> : null}
        <span className="shrink-0">{statusLabel}</span>
        <span className="ml-auto shrink-0 rounded-md bg-muted px-2 py-1">
          {t(panelActive ? "shownInSidePanel" : "openDisplayPanel")}
        </span>
      </button>
      <ToolDetailDisclosure
        sections={detailSections}
        defaultOpen={state === "failed"}
        className="border-t px-2.5 py-1"
      />
      <ToolArtifactList artifacts={artifacts} className="border-t px-2.5 py-2" />
      <span className="sr-only">{toolCallId}</span>
    </div>
  );
}

function SidePanelDataPart({
  display,
  displayNode,
  name
}: {
  display: { kind?: unknown; mode?: unknown; displayId?: unknown; title?: unknown; data?: unknown };
  displayNode: ReactNode;
  name: string;
}) {
  const { t } = useTranslation();
  const panel = useToolDisplayPanel();
  const panelKey = displayPanelKey(display, `data:${name}`);
  const title = displayPanelTitle(display, t("structuredOutput", { name }));
  const panelActive = panel.open && panel.entry?.key === panelKey;
  const subtitle = t("structuredOutput", { name });

  useEffect(() => {
    panel.showOnce({
      key: panelKey,
      title,
      subtitle,
      node: displayNode
    });
  }, [displayNode, panel, panelKey, subtitle, title]);

  return (
    <div className="chat-tool-part my-2 max-w-3xl rounded-md border border-border/60 bg-card/40 text-xs">
      <button
        type="button"
        onClick={() =>
          panel.show({
            key: panelKey,
            title,
            subtitle,
            node: displayNode
          })
        }
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <Wrench size={14} className="shrink-0" aria-hidden="true" />
        <span className="truncate font-medium text-foreground">{title}</span>
        <span className="ml-auto shrink-0 rounded-md bg-muted px-2 py-1">
          {t(panelActive ? "shownInSidePanel" : "openDisplayPanel")}
        </span>
      </button>
    </div>
  );
}

function DisplayToolCall({
  actionLabel,
  detailSections,
  displayNode,
  state,
  statusLabel,
  artifacts,
  surfacedArtifacts,
  toolCallId,
  toolTitle
}: {
  actionLabel?: string;
  detailSections: ToolDetailSection[];
  displayNode: ReactNode;
  state: "running" | "completed" | "failed";
  statusLabel: string;
  artifacts: ToolArtifactDownloadRef[];
  surfacedArtifacts: ToolArtifactDownloadRef[];
  toolCallId: string;
  toolTitle: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  return (
    <div
      className={cn("chat-tool-part my-3 max-w-5xl", state === "failed" && "text-destructive")}
      data-testid="tool-call-card"
    >
      <div
        className={cn(
          "overflow-hidden rounded-md border bg-card shadow-xs",
          state === "failed" && "border-destructive/40 bg-destructive/5"
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? t("collapseDisplay") : t("expandDisplay")}
          onClick={() => setOpen((current) => !current)}
          className="flex w-full min-w-0 items-center gap-2 border-b px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <ToolStatusIcon state={state} />
          <span className="truncate font-medium text-foreground">{toolTitle}</span>
          {actionLabel ? <span className="min-w-0 truncate">{actionLabel}</span> : null}
          <span className="shrink-0">{statusLabel}</span>
          <ChevronRight
            size={14}
            className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
        </button>
        {open ? <div>{displayNode}</div> : null}
      </div>
      <ToolArtifactList artifacts={surfacedArtifacts} className="mt-2" autoPreview />
      <ToolDetailDisclosure
        sections={detailSections}
        defaultOpen={state === "failed"}
        className="mt-2"
      />
      <span className="sr-only">{toolCallId}</span>
    </div>
  );
}

function DisplayDataPart({ displayNode, name }: { displayNode: ReactNode; name: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);

  return (
    <div className="chat-tool-part my-2 max-w-5xl overflow-hidden rounded-md border bg-card shadow-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? t("collapseDisplay") : t("expandDisplay")}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <Wrench size={14} className="shrink-0" aria-hidden="true" />
        <span className="truncate font-medium text-foreground">{t("structuredOutput", { name })}</span>
        <ChevronRight
          size={14}
          className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
      </button>
      {open ? <div className="border-t">{displayNode}</div> : null}
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
  toolName,
  result
}: {
  args: unknown;
  argsText?: string;
  labels: { input: string; output: string };
  toolName: string;
  result: unknown;
}): ToolDetailSection[] {
  if (isWorkspaceToolName(toolName)) {
    return projectWorkspaceToolDisplay({ args, result, toolName })?.sections ?? [];
  }
  const input = formatDetails(argsText && argsText.trim().length > 0 ? argsText : args);
  const output = formatDetails(result);
  const sections: ToolDetailSection[] = [];
  if (input) {
    sections.push({ label: labels.input, value: input });
  }
  if (output) {
    sections.push({ label: labels.output, value: output });
  }
  return sections;
}

export function readToolDetailSections(input: {
  args: unknown;
  argsText?: string;
  labels: { input: string; output: string };
  result: unknown;
  toolName: string;
}): ToolDetailSection[] {
  return toolDetailSections(input);
}

export function readToolActionLabel(input: {
  args: unknown;
  result: unknown;
  toolName: string;
}): string | undefined {
  return projectWorkspaceToolDisplay(input)?.actionLabel ?? readToolSubjectLabel(input);
}

export function readToolDisplayProjection(input: {
  args: unknown;
  result: unknown;
  toolName: string;
  locale: LocaleCode;
}): {
  actionLabel?: string;
  technicalName: string;
  title: string;
} {
  return {
    actionLabel: readToolActionLabel(input),
    technicalName: input.toolName,
    title: readTranslatedToolTitle(input.toolName, input.locale) ?? humanizeToolName(input.toolName)
  };
}

const TOOL_TITLES_BY_LOCALE: Record<LocaleCode, Record<string, string>> = {
  en: {
    read_skill: "Read instructions",
    show_view: "Show view",
    "workspace.exec": "Run command",
    "workspace.list_files": "List files",
    "workspace.import_files": "Import files",
    "workspace.read_file": "Read file",
    "workspace.promote_artifact": "Prepare download"
  },
  de: {
    read_skill: "Anleitung lesen",
    show_view: "Ansicht anzeigen",
    "workspace.exec": "Befehl starten",
    "workspace.list_files": "Dateien auflisten",
    "workspace.import_files": "Dateien importieren",
    "workspace.read_file": "Datei lesen",
    "workspace.promote_artifact": "Download vorbereiten"
  }
};

const TOOL_NAME_ACRONYMS = new Set([
  "api",
  "csv",
  "docx",
  "html",
  "id",
  "json",
  "ocr",
  "pdf",
  "pptx",
  "sql",
  "ui",
  "url",
  "xlsx"
]);

function readTranslatedToolTitle(toolName: string, locale: LocaleCode): string | undefined {
  return TOOL_TITLES_BY_LOCALE[locale][toolName] ?? TOOL_TITLES_BY_LOCALE.en[toolName];
}

function readToolSubjectLabel(input: {
  args: unknown;
  result: unknown;
  toolName: string;
}): string | undefined {
  if (input.toolName === "read_skill") {
    return readSkillSubjectLabel(input.args, input.result);
  }
  if (input.toolName === "show_view") {
    const displayTitle = readDisplayProvidedTitle(readToolDisplayPayloadFromToolResult(input.result));
    return displayTitle ?? readRecordString(input.args, "title");
  }
  return undefined;
}

function readSkillSubjectLabel(args: unknown, result: unknown): string | undefined {
  const output = isRecord(result) && isRecord(result.output) ? result.output : undefined;
  const skillName = readRecordString(args, "name");
  return readRecordString(output, "title") ?? (skillName ? humanizeToolName(skillName) : undefined);
}

function readDisplayProvidedTitle(
  display: { title?: unknown; data?: unknown } | undefined
): string | undefined {
  const title = readTrimmedString(display?.title);
  if (title) {
    return title;
  }
  return isRecord(display?.data) ? readRecordString(display.data, "title") : undefined;
}

function readRecordString(value: unknown, key: string): string | undefined {
  return isRecord(value) ? readTrimmedString(value[key]) : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function humanizeToolName(toolName: string): string {
  const source = toolName.trim();
  if (!source) {
    return "Tool";
  }
  const lastSegment = source.split(".").filter(Boolean).at(-1) ?? source;
  const normalized = lastSegment
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim();
  if (!normalized) {
    return source;
  }
  return normalized
    .split(/\s+/u)
    .map((word) =>
      TOOL_NAME_ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`
    )
    .join(" ");
}

function isWorkspaceToolName(toolName: string): boolean {
  return toolName.startsWith("workspace.");
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
  actionLabel,
  detailSections,
  state,
  statusLabel,
  summary,
  artifacts,
  surfacedArtifacts,
  toolCallId,
  toolTitle
}: {
  actionLabel?: string;
  detailSections: ToolDetailSection[];
  state: "running" | "completed" | "failed";
  statusLabel: string;
  summary: string | undefined;
  artifacts: ToolArtifactDownloadRef[];
  surfacedArtifacts: ToolArtifactDownloadRef[];
  toolCallId: string;
  toolTitle: string;
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
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <ToolStatusIcon state={state} />
        <span className="truncate font-medium text-foreground">{toolTitle}</span>
        {actionLabel ? <span className="min-w-0 truncate">{actionLabel}</span> : null}
        <span className="shrink-0">{statusLabel}</span>
        <ChevronRight
          size={14}
          className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
      </button>
      {surfacedArtifacts.length > 0 ? (
        <div className="border-t bg-muted/20 px-2.5 py-2">
          <ToolArtifactList artifacts={surfacedArtifacts} autoPreview />
        </div>
      ) : null}
      {open ? (
        <div className="grid gap-2 border-t bg-muted/40 px-2.5 py-2">
          {summary ? (
            <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{summary}</p>
          ) : null}
          {surfacedArtifacts.length === 0 ? <ToolArtifactList artifacts={artifacts} /> : null}
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
  sections: ToolDetailSection[];
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

function ToolDetails({ sections }: { sections: ToolDetailSection[] }) {
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

function getToolSummary(
  result: unknown,
  t: ReturnType<typeof useTranslation>["t"]
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const workspaceSummary = getWorkspaceCommandSummary(result, t);
  if (workspaceSummary) {
    return workspaceSummary;
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

function getWorkspaceCommandSummary(
  result: Record<string, unknown>,
  t: ReturnType<typeof useTranslation>["t"]
): string | undefined {
  const output = isRecord(result.output) ? result.output : undefined;
  if (
    typeof output?.commandId !== "string" ||
    typeof output.workspaceId !== "string" ||
    !Array.isArray(output.changedFiles)
  ) {
    return undefined;
  }
  if (output.status === "failed") {
    return output.exitCode === 124 ? t("workspaceCommandTimedOut") : t("workspaceCommandFailed");
  }
  if (output.status === "cancelled") {
    return t("workspaceCommandCancelled");
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRenderedNode(value: ReactNode): boolean {
  return value !== undefined && value !== null && value !== false;
}
