import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { cn, ConnectionIcon, Spinner } from "@work-shape/catalyst-ui";
import { CheckCircle2, ChevronRight, CircleAlert, Wrench } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { readToolDisplayPayloadFromToolResult } from "../../shared/domain-ui-widgets";
import { useTranslation } from "../../shared/i18n";
import { useConnectionToolSubject, type ConnectionToolSubject } from "../assistant/tool-subjects";
import { assetToolSentence, type AssetToolCall } from "../conversation/asset-tool-lines";
import { ToolArtifactList } from "../files/artifact-download-card";
import { type ToolArtifactDownloadRef } from "./tool-artifacts";
import { toolUiState } from "./tool-call-projection";
import { useToolDisplayPanel } from "./tool-display-panel";
import { displayPanelKey, displayPanelTitle } from "./tool-display-rendering";
import { type ToolDetailSection } from "./workspace-tool-display";

export function SidePanelToolCall({
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

export function SidePanelDataPart({
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

export function DisplayToolCall({
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

export function DisplayDataPart({ displayNode, name }: { displayNode: ReactNode; name: string }) {
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
export function ToolCallHead({
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

export function CompactToolCall({
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
