import { CheckCircle2, ChevronRight, CircleAlert, Wrench } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { LocaleCode } from "@vivd-catalyst/api-client";
import { cn, ConnectionIcon, Spinner } from "@vivd-catalyst/ui";
import { useConnectionToolSubject, type ConnectionToolSubject } from "./assistant/tool-subjects";
import { ApprovalRequestCard } from "./approvals/approval-request-card";
import { readApprovalRequestDisplay } from "./approvals/approval-request-model";
import {
  isToolDisplayPayload,
  readToolDisplayPayloadFromToolResult,
  ToolDisplayWidgetNode,
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
import { PageSaveCard } from "./pages/page-card";
import { PAGE_SAVE_TOOL_NAME } from "./pages/page-save";
import { CONNECTION_DRAFT_TOOL_NAME, readConnectionDraft } from "./build-area/connection-draft";
import { ConnectionDraftCard } from "./build-area/connection-draft-card";
import { useToolDisplayPanel } from "./tool-display-panel";
import {
  readWorkspacePromotedArtifactsData,
  readSurfacedToolArtifactRefs,
  readToolArtifactRefs,
  type ToolArtifactDownloadRef
} from "./tool-artifacts";
import { ToolSurfaceList } from "./tool-surface-card";
import { readWorkspacePromotedSurfacesData } from "./tool-surfaces";
import {
  isFailedWorkspaceExecResult,
  projectWorkspaceToolDisplay,
  type ToolDetailSection
} from "./workspace-tool-display";
import { assetToolSentence, type AssetToolCall } from "./conversation/asset-tool-lines";
import { AssetOpenedLine } from "./conversation/conversation-subject";
import { standingAssetOpen } from "./conversation/subject-run";

// Whoever renders tool calls outside the thread gives them their subjects with this.
export { ToolSubjectsProvider } from "./assistant/tool-subjects";

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
  const state = toolUiState({ isError, result, status, toolName });
  const display = readToolDisplayPayloadFromToolResult(result);
  // Platform-owned and resolved before the client widget registry: the card
  // decides a change to the instance, so a client assembly must not replace it.
  const approvalRequest = readApprovalRequestDisplay(display);
  const renderedDisplay =
    display && displayWidget && !approvalRequest
      ? displayWidget({
          display,
          locale,
          source: "tool-result",
          toolName,
          toolCallId,
          result
        })
      : undefined;
  const builtInDisplay =
    display && !hasRenderedNode(renderedDisplay) ? renderBuiltInDisplay(display) : undefined;
  const panelDisplayNode = display ? (
    <ToolDisplayWidgetNode
      display={display}
      fallback={builtInDisplay}
      locale={locale}
      result={result}
      source="tool-result"
      toolCallId={toolCallId}
      toolName={toolName}
    />
  ) : (
    builtInDisplay
  );
  const hasDisplay = hasRenderedNode(renderedDisplay) || hasRenderedNode(builtInDisplay);
  const displayMode = readDisplayMode(display);
  const workspaceProjection = projectWorkspaceToolDisplay({ args, result, toolName });
  const toolDisplay = readToolDisplayProjection({ args, result, toolName, locale });
  const subject = useConnectionToolSubject(toolName);
  const detailSections = [
    // The line of the call says what was touched in words. The name the agent called stays
    // here for whoever builds the agent.
    ...(subject ? [{ label: t("toolTechnicalName"), value: toolName, kind: "name" as const }] : []),
    ...(workspaceProjection?.sections ??
      toolDetailSections({
        args,
        argsText,
        toolName,
        result,
        labels: { input: t("toolInput"), output: t("toolOutput") }
      }))
  ];
  const artifacts = readToolArtifactRefs(result);
  const surfacedArtifacts = readSurfacedToolArtifactRefs(result, toolName);
  const summary = workspaceProjection?.summary ?? getToolSummary(result, t);
  const statusLabel = toolStatusLabel(state, t);
  const actionLabel = workspaceProjection?.actionLabel ?? toolDisplay.actionLabel;

  if (toolName === PAGE_SAVE_TOOL_NAME) {
    return <PageSaveCard args={args} result={result} failed={state === "failed"} />;
  }

  const opened = standingAssetOpen({ toolName, toolCallId, result, isError });
  if (opened) {
    return <AssetOpenedLine open={opened} />;
  }

  // The agent's draft of REST API tools: a card whose button opens the approval list.
  const connectionDraft =
    toolName === CONNECTION_DRAFT_TOOL_NAME && state === "completed"
      ? readConnectionDraft(result)
      : undefined;
  if (connectionDraft) {
    return <ConnectionDraftCard draft={connectionDraft} />;
  }

  if (approvalRequest) {
    return (
      <div className="chat-tool-part my-3 max-w-3xl" data-testid="tool-call-card">
        <ApprovalRequestCard requestId={approvalRequest.requestId} />
      </div>
    );
  }

  if (hasDisplay && displayPresentation === "full") {
    if (displayMode === "side_panel" && displayPanel.available) {
      return (
        <SidePanelToolCall
          actionLabel={actionLabel}
          detailSections={detailSections}
          display={display}
          displayNode={panelDisplayNode}
          state={state}
          statusLabel={statusLabel}
          artifacts={surfacedArtifacts}
          toolCallId={toolCallId}
          toolTitle={toolDisplay.title}
          subject={subject}
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
        toolTitle={toolDisplay.title}
        subject={subject}
      />
    );
  }

  const hasDisclosureContent =
    Boolean(summary) || surfacedArtifacts.length > 0 || detailSections.length > 0;

  if (!hasDisclosureContent) {
    return (
      <div
        className={cn(
          "chat-tool-part my-1 flex max-w-3xl items-center gap-2 rounded-md border border-border/60 bg-card/40 px-2.5 py-2 text-xs text-muted-foreground",
          state === "failed" && "border-destructive/40 bg-destructive/5 text-destructive"
        )}
        data-testid="tool-call-card"
      >
        <ToolCallHead
          state={state}
          toolTitle={toolDisplay.title}
          actionLabel={actionLabel}
          statusLabel={statusLabel}
          subject={subject}
        />
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
      surfacedArtifacts={surfacedArtifacts}
      toolTitle={toolDisplay.title}
      subject={subject}
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
        <ToolArtifactList
          artifacts={promotedArtifacts.artifacts}
          variant="deliverable"
          autoPreview={autoPreviewSurfaces}
        />
      </div>
    );
  }
  const promotedSurfaces = readWorkspacePromotedSurfacesData(data);
  if (promotedSurfaces) {
    return (
      // Surfaces shown elsewhere render nothing here; an empty wrapper would
      // still add its margin below the message.
      // An inline view has no frame of its own, so it keeps the distance to the text before
      // it that the text after a block keeps (styles.css).
      <div className="chat-tool-part my-6 max-w-5xl has-[>div:empty]:hidden">
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
    isToolDisplayPayload(data) && !hasRenderedNode(renderedDisplay)
      ? renderBuiltInDisplay(data)
      : undefined;
  const panelDisplayNode = isToolDisplayPayload(data) ? (
    <ToolDisplayWidgetNode
      display={data}
      fallback={builtInDisplay}
      locale={locale}
      source="message-metadata"
    />
  ) : (
    builtInDisplay
  );
  const hasDisplay = hasRenderedNode(renderedDisplay) || hasRenderedNode(builtInDisplay);
  const displayMode = isToolDisplayPayload(data) ? readDisplayMode(data) : "inline";
  const details = formatDetails(data);

  if (hasDisplay && displayPresentation === "full") {
    if (displayMode === "side_panel" && displayPanel.available && isToolDisplayPayload(data)) {
      return (
        <SidePanelDataPart
          autoPreview={autoPreviewSurfaces}
          display={data}
          displayNode={panelDisplayNode}
          name={name}
        />
      );
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
  toolTitle,
  subject
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
  subject?: ConnectionToolSubject;
}) {
  const { t } = useTranslation();
  const panel = useToolDisplayPanel();
  const panelKey = displayPanelKey(display, toolCallId);
  const title = displayPanelTitle(display, toolTitle);
  const panelActive = panel.open && panel.entry?.key === panelKey;
  const subtitle = actionLabel ? `${toolTitle}: ${actionLabel}` : toolTitle;

  // No auto-open here. A tool card renders mid-run and on every history load,
  // and it shares its panel key with the promoted result card for the same
  // display — auto-showing from here consumed the key before the run finished,
  // which is why the result never opened at the end.

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
            kind: "tool_display",
            key: panelKey,
            title,
            subtitle,
            node: displayNode
          })
        }
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <ToolCallHead
          state={state}
          toolTitle={toolTitle}
          actionLabel={actionLabel}
          statusLabel={statusLabel}
          subject={subject}
        />
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
    </div>
  );
}

function SidePanelDataPart({
  autoPreview,
  display,
  displayNode,
  name
}: {
  autoPreview: boolean;
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
    if (!autoPreview) {
      return;
    }
    panel.showOnce({
      kind: "tool_display",
      key: panelKey,
      title,
      subtitle,
      node: displayNode
    });
  }, [autoPreview, displayNode, panel, panelKey, subtitle, title]);

  return (
    <div className="chat-tool-part my-2 max-w-3xl rounded-md border border-border/60 bg-card/40 text-xs">
      <button
        type="button"
        onClick={() =>
          panel.show({
            kind: "tool_display",
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
  toolTitle,
  subject
}: {
  actionLabel?: string;
  detailSections: ToolDetailSection[];
  displayNode: ReactNode;
  state: "running" | "completed" | "failed";
  statusLabel: string;
  artifacts: ToolArtifactDownloadRef[];
  surfacedArtifacts: ToolArtifactDownloadRef[];
  toolTitle: string;
  subject?: ConnectionToolSubject;
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
          <ToolCallHead
            state={state}
            toolTitle={toolTitle}
            actionLabel={actionLabel}
            statusLabel={statusLabel}
            subject={subject}
          />
          <ChevronRight
            size={14}
            className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
        </button>
        {open ? <div>{displayNode}</div> : null}
      </div>
      {/* Tool cards never open the panel themselves; only the promoted result
          cards do, once the run has finished. */}
      <ToolArtifactList artifacts={surfacedArtifacts} className="mt-2" />
      <ToolDetailDisclosure
        sections={detailSections}
        defaultOpen={state === "failed"}
        className="mt-2"
      />
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
        <span className="truncate font-medium text-foreground">
          {t("structuredOutput", { name })}
        </span>
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
  status,
  toolName
}: {
  isError?: boolean;
  result: unknown;
  status?: ToolCallMessagePartProps["status"];
  toolName: string;
}): "running" | "completed" | "failed" {
  if (isError || status?.type === "incomplete") {
    return "failed";
  }
  if (status?.type === "running" || status?.type === "requires-action" || result === undefined) {
    return "running";
  }
  if (isFailedWorkspaceExecResult({ result, toolName })) {
    return "failed";
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
  const sentence = readErrorSentence(result);
  const output = sentence ?? formatDetails(result);
  const sections: ToolDetailSection[] = [];
  if (input) {
    sections.push({ label: labels.input, value: input });
  }
  if (output) {
    sections.push({
      label: labels.output,
      value: output,
      ...(sentence === undefined ? {} : { kind: "text" as const })
    });
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
    "platform.context": "Check what this platform offers",
    "platform.assets.list": "Search the platform",
    "platform.assets.open": "Open the asset",
    "platform.assets.get": "Read the asset",
    "platform.assets.validate": "Check the draft",
    "platform.assets.put": "Save the draft",
    "platform.assets.operations": "Look up operations",
    "platform.connections.draft_tools": "Draft REST API tools",
    read_skill: "Read instructions",
    show_view: "Widget",
    "structured_data.publish": "Update the fact sheet",
    "structured_data.read": "Read the fact sheet",
    "structured_result.read": "Reopen an earlier result",
    "workspace.exec": "Run command",
    "workspace.list_files": "List files",
    "workspace.import_files": "Import files",
    "workspace.read_file": "Read file",
    "workspace.write_file": "Write file",
    "workspace.edit_file": "Edit file",
    "workspace.promote_artifact": "Prepare download",
    "workspace.preview_images": "Preview images"
  },
  de: {
    "platform.context": "Angebot der Plattform prüfen",
    "platform.assets.list": "Plattform durchsuchen",
    "platform.assets.open": "Asset öffnen",
    "platform.assets.get": "Asset lesen",
    "platform.assets.validate": "Entwurf prüfen",
    "platform.assets.put": "Entwurf speichern",
    "platform.assets.operations": "Operationen nachschlagen",
    "platform.connections.draft_tools": "REST-API-Tools entwerfen",
    read_skill: "Anleitung lesen",
    show_view: "Widget",
    "structured_data.publish": "Faktenblatt aktualisieren",
    "structured_data.read": "Faktenblatt lesen",
    "structured_result.read": "Früheres Ergebnis öffnen",
    "workspace.exec": "Befehl starten",
    "workspace.list_files": "Dateien auflisten",
    "workspace.import_files": "Dateien importieren",
    "workspace.read_file": "Datei lesen",
    "workspace.write_file": "Datei schreiben",
    "workspace.edit_file": "Datei bearbeiten",
    "workspace.promote_artifact": "Download vorbereiten",
    "workspace.preview_images": "Vorschau laden"
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
    const displayTitle = readDisplayProvidedTitle(
      readToolDisplayPayloadFromToolResult(input.result)
    );
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

/**
 * The sentence of an output that is an error and nothing else: `{ "error": "…" }`. Such an
 * output is read by a person, so it is shown as text and not as the JSON it arrived in.
 */
function readErrorSentence(result: unknown): string | undefined {
  if (!isRecord(result) || Object.keys(result).length !== 1) {
    return undefined;
  }
  return readTrimmedString(result.error);
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

type ToolUiState = "running" | "completed" | "failed";

/** Stands where the name goes while a sentence is translated. No text holds it. */
const NAME_MARK = "\u0000";

/** The sentence of a call of a Connection, by what the call does and how it stands. */
const CONNECTION_SENTENCES = {
  reading: {
    running: "toolConnectionReading",
    completed: "toolConnectionRead",
    failed: "toolConnectionReadFailed"
  },
  changing: {
    running: "toolConnectionChanging",
    completed: "toolConnectionChanged",
    failed: "toolConnectionChangeFailed"
  },
  unknown: {
    running: "toolConnectionUsing",
    completed: "toolConnectionUsed",
    failed: "toolConnectionUseFailed"
  }
} as const;

/**
 * The first line of a tool call. A call of a Connection says what was touched in words, beside
 * the Connection's icon: "Read Bookings". Every other call says its tool and how it stands.
 */
function ToolCallHead({
  state,
  toolTitle,
  actionLabel,
  statusLabel,
  subject
}: {
  state: ToolUiState;
  toolTitle: string;
  actionLabel?: string;
  statusLabel: string;
  subject?: ConnectionToolSubject;
}) {
  if (!subject) {
    return (
      <>
        <ToolStatusIcon state={state} />
        <span className="truncate font-medium text-foreground">{toolTitle}</span>
        {actionLabel ? <span className="min-w-0 truncate">{actionLabel}</span> : null}
        <span className="shrink-0">{statusLabel}</span>
      </>
    );
  }
  return <ConnectionCallLine subject={subject} state={state} />;
}

/**
 * What a call of a Connection did, in words beside the Connection's icon. The line of the
 * call shows it, and so does the fold of a group that holds this one call.
 */
function ConnectionCallLine({
  subject,
  state
}: {
  subject: ConnectionToolSubject;
  state: ToolUiState;
}) {
  const { t } = useTranslation();
  const { connection, effect } = subject;
  // The name is set apart in the sentence, wherever the language puts it.
  const [before, after = ""] = t(CONNECTION_SENTENCES[effect ?? "unknown"][state], {
    name: NAME_MARK
  }).split(NAME_MARK);
  return (
    <>
      <ConnectionIcon size="sm" service={connection.service} category={connection.category} />
      <span className="min-w-0 truncate" data-testid="tool-call-sentence">
        {before}
        <span className="font-medium text-foreground">{connection.title}</span>
        {after}
      </span>
      {state === "completed" ? null : <ToolStatusIcon state={state} />}
    </>
  );
}

/**
 * What the fold of a group of tool calls says. A fold that holds one call of a Connection
 * says what the call did, as the call's own line does. Several calls, and a call that has no
 * sentence, are counted.
 */
export function ToolCallFoldLabel({
  only,
  last,
  count
}: {
  /** The group's one tool call, where it holds a single call. */
  only?: {
    toolName: string;
    result?: unknown;
    isError?: boolean;
    status?: ToolCallMessagePartProps["status"];
  };
  /** The group's last tool call. A call on an asset says what it did, with the others counted. */
  last?: AssetToolCall;
  count: number;
}) {
  const { t } = useTranslation();
  const subject = useConnectionToolSubject(only?.toolName ?? "");
  const assetSentence = last === undefined ? undefined : assetToolSentence(last, t);
  if (assetSentence !== undefined) {
    return (
      <span className="min-w-0 truncate" data-testid="tool-call-fold-sentence">
        {count > 1
          ? t("assetToolFoldMore", { sentence: assetSentence, count: count - 1 })
          : assetSentence}
      </span>
    );
  }
  if (!only || !subject) {
    return <>{t(count === 1 ? "toolCallCountSingular" : "toolCallCount", { count })}</>;
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-2" data-testid="tool-call-fold-line">
      <ConnectionCallLine
        subject={subject}
        state={toolUiState({
          isError: only.isError,
          result: only.result,
          status: only.status,
          toolName: only.toolName
        })}
      />
    </span>
  );
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
  surfacedArtifacts,
  toolTitle,
  subject
}: {
  actionLabel?: string;
  detailSections: ToolDetailSection[];
  state: "running" | "completed" | "failed";
  statusLabel: string;
  summary: string | undefined;
  surfacedArtifacts: ToolArtifactDownloadRef[];
  toolTitle: string;
  subject?: ConnectionToolSubject;
}) {
  const { t } = useTranslation();
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
        <ToolCallHead
          state={state}
          toolTitle={toolTitle}
          actionLabel={actionLabel}
          statusLabel={statusLabel}
          subject={subject}
        />
        <ChevronRight
          size={14}
          className={cn("ml-auto shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden="true"
        />
      </button>
      {surfacedArtifacts.length > 0 ? (
        <div className="border-t bg-muted/20 px-2.5 py-2">
          <ToolArtifactList artifacts={surfacedArtifacts} />
        </div>
      ) : null}
      {open ? (
        <div className="grid gap-2 border-t bg-muted/40 px-2.5 py-2">
          {summary ? (
            <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
              {summary}
            </p>
          ) : null}
          {subject && detailSections.length > 0 ? (
            <p className="text-muted-foreground">{t("toolDetails")}</p>
          ) : null}
          <ToolDetails sections={detailSections} />
        </div>
      ) : null}
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
          {section.kind === "name" ? (
            <code
              className="font-mono text-code text-foreground [overflow-wrap:anywhere]"
              data-testid="tool-technical-name"
            >
              {section.value}
            </code>
          ) : section.kind === "text" ? (
            <p
              className="text-body text-foreground [overflow-wrap:anywhere]"
              data-testid="tool-detail-text"
            >
              {section.value}
            </p>
          ) : (
            <pre className="max-h-56 overflow-auto rounded-md bg-background/70 px-3 py-2 font-mono text-[0.75rem] leading-5 [overflow-wrap:anywhere]">
              {section.value}
            </pre>
          )}
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
