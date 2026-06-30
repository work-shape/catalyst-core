import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Download,
  FileText,
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
import { useToolDisplayPanel } from "./tool-display-panel";
import { useAttachmentContentContext } from "./attachment-content";
import { cn } from "./ui/cn";
import { Spinner } from "./ui/spinner";
import { projectWorkspaceToolDisplay, type ToolDetailSection } from "./workspace-tool-display";

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

export interface ToolArtifactDownloadRef {
  artifactId: string;
  kind?: string;
  filename?: string;
  mimeType?: string;
}

export function ToolCallPart({ toolName, toolCallId, args, argsText, result, isError, status }: ToolCallMessagePartProps) {
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
  const actionLabel = workspaceProjection?.actionLabel;

  if (hasDisplay) {
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
          toolName={toolName}
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
        toolName={toolName}
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
        <span className="truncate font-medium text-foreground">{toolName}</span>
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
      toolName={toolName}
    />
  );
}

export function DataPart({ name, data }: DataPartProps) {
  const { locale, t } = useTranslation();
  const displayPanel = useToolDisplayPanel();
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
  const displayMode = isToolDisplayPayload(data) ? readDisplayMode(data) : "inline";
  const details = formatDetails(data);

  if (hasDisplay) {
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
  toolName
}: {
  actionLabel?: string;
  detailSections: ToolDetailSection[];
  display: ReturnType<typeof readToolDisplayPayloadFromToolResult>;
  displayNode: ReactNode;
  state: "running" | "completed" | "failed";
  statusLabel: string;
  artifacts: ToolArtifactDownloadRef[];
  toolCallId: string;
  toolName: string;
}) {
  const { t } = useTranslation();
  const panel = useToolDisplayPanel();
  const panelKey = displayPanelKey(display, toolCallId);
  const title = displayPanelTitle(display, toolName);
  const panelActive = panel.open && panel.entry?.key === panelKey;

  useEffect(() => {
    panel.showOnce({
      key: panelKey,
      title,
      subtitle: toolName,
      node: displayNode
    });
  }, [displayNode, panel, panelKey, title, toolName]);

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
            subtitle: toolName,
            node: displayNode
          })
        }
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <ToolStatusIcon state={state} />
        <span className="truncate font-medium text-foreground">{toolName}</span>
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
  toolName
}: {
  actionLabel?: string;
  detailSections: ToolDetailSection[];
  displayNode: ReactNode;
  state: "running" | "completed" | "failed";
  statusLabel: string;
  artifacts: ToolArtifactDownloadRef[];
  surfacedArtifacts: ToolArtifactDownloadRef[];
  toolCallId: string;
  toolName: string;
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
          <span className="truncate font-medium text-foreground">{toolName}</span>
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
      <ToolArtifactList artifacts={surfacedArtifacts} className="mt-2" />
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
  return projectWorkspaceToolDisplay(input)?.actionLabel;
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
  toolName
}: {
  actionLabel?: string;
  detailSections: ToolDetailSection[];
  state: "running" | "completed" | "failed";
  statusLabel: string;
  summary: string | undefined;
  artifacts: ToolArtifactDownloadRef[];
  surfacedArtifacts: ToolArtifactDownloadRef[];
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
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <ToolStatusIcon state={state} />
        <span className="truncate font-medium text-foreground">{toolName}</span>
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
          <ToolArtifactList artifacts={surfacedArtifacts} />
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

function ToolArtifactList({
  artifacts,
  className
}: {
  artifacts: ToolArtifactDownloadRef[];
  className?: string;
}) {
  const { t } = useTranslation();
  const attachmentContent = useAttachmentContentContext();
  const [downloadingArtifactId, setDownloadingArtifactId] = useState<string | undefined>();

  if (artifacts.length === 0) {
    return null;
  }

  const downloadAvailable = Boolean(attachmentContent?.client && attachmentContent.selectedConversationId);

  async function downloadArtifact(artifact: ToolArtifactDownloadRef) {
    if (!attachmentContent?.client || !attachmentContent.selectedConversationId) {
      return;
    }
    setDownloadingArtifactId(artifact.artifactId);
    try {
      const blob = await attachmentContent.client.conversationArtifactContent(
        attachmentContent.selectedConversationId,
        artifact.artifactId
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename ?? artifact.artifactId;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setDownloadingArtifactId(undefined);
    }
  }

  return (
    <div className={cn("grid gap-1.5", className)}>
      {artifacts.map((artifact) => {
        const filename = artifact.filename ?? artifact.artifactId;
        const downloading = downloadingArtifactId === artifact.artifactId;
        return (
          <button
            key={artifact.artifactId}
            type="button"
            disabled={!downloadAvailable || downloading}
            title={downloadAvailable ? t("downloadArtifact", { filename }) : t("downloadUnavailable")}
            aria-label={downloadAvailable ? t("downloadArtifact", { filename }) : t("downloadUnavailable")}
            onClick={() => void downloadArtifact(artifact)}
            className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md border bg-background px-3 py-2 text-left text-sm text-foreground shadow-xs transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <FileText size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">
              <span className="block truncate font-medium">{filename}</span>
              {artifact.mimeType || artifact.kind ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {artifact.mimeType ?? artifact.kind}
                </span>
              ) : null}
            </span>
            {downloading ? (
              <Spinner size="sm" className="shrink-0 text-muted-foreground" />
            ) : (
              <Download size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}

export function readToolArtifactRefs(result: unknown): ToolArtifactDownloadRef[] {
  const container = isRecord(result) ? result : undefined;
  const rawArtifacts = Array.isArray(container?.artifacts) ? container.artifacts : [];
  return rawArtifacts.flatMap((artifact): ToolArtifactDownloadRef[] => {
    if (!isRecord(artifact) || typeof artifact.artifactId !== "string") {
      return [];
    }
    const ref: ToolArtifactDownloadRef = {
      artifactId: artifact.artifactId
    };
    if (typeof artifact.kind === "string") {
      ref.kind = artifact.kind;
    }
    if (typeof artifact.filename === "string") {
      ref.filename = artifact.filename;
    }
    if (typeof artifact.mimeType === "string") {
      ref.mimeType = artifact.mimeType;
    }
    return [ref];
  });
}

export function readSurfacedToolArtifactRefs(result: unknown, toolName: string): ToolArtifactDownloadRef[] {
  if (toolName === "workspace.promote_artifact" || toolName === "workspace.exec") {
    return readToolArtifactRefs(result);
  }
  return [];
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

function readDisplayMode(display: { mode?: unknown } | undefined): "inline" | "side_panel" | "fullscreen" {
  if (display?.mode === "side_panel" || display?.mode === "fullscreen") {
    return display.mode;
  }
  return "inline";
}

function displayPanelKey(display: { displayId?: unknown; kind?: unknown } | undefined, fallback: string): string {
  if (typeof display?.displayId === "string" && display.displayId.trim()) {
    return display.displayId;
  }
  if (typeof display?.kind === "string" && display.kind.trim()) {
    return `${display.kind}:${fallback}`;
  }
  return fallback;
}

function displayPanelTitle(
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
