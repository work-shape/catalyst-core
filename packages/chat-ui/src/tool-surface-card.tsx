import { LayoutDashboard, PanelRightOpen } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import {
  isToolDisplayPayload,
  useToolDisplayWidget
} from "./domain-ui-widgets";
import { useTranslation } from "./i18n";
import {
  displayPanelKey,
  displayPanelTitle,
  readDisplayMode,
  renderBuiltInDisplay
} from "./tool-display-rendering";
import { useToolDisplayPanel, type ToolDisplayPanelEntry } from "./tool-display-panel";
import { cn } from "./ui/cn";
import type { ToolSurfaceRef } from "./tool-surfaces";

export function ToolSurfaceList({
  autoPreview = false,
  className,
  surfaces
}: {
  autoPreview?: boolean;
  className?: string;
  surfaces: ToolSurfaceRef[];
}) {
  if (surfaces.length === 0) {
    return null;
  }

  return (
    <div className={cn("grid gap-2", className)}>
      {surfaces.map((surface) => (
        <ToolSurfaceCard
          key={surface.surfaceId}
          autoPreview={autoPreview}
          surface={surface}
        />
      ))}
    </div>
  );
}

function ToolSurfaceCard({
  autoPreview,
  surface
}: {
  autoPreview: boolean;
  surface: ToolSurfaceRef;
}) {
  const { locale, t } = useTranslation();
  const panel = useToolDisplayPanel();
  const displayWidget = useToolDisplayWidget();
  const display = surface.display;
  const displayMode = readDisplayMode(display);
  const renderedDisplay =
    isToolDisplayPayload(display) && displayWidget
      ? displayWidget({
          display,
          locale,
          source: "message-metadata",
          toolName: surface.toolName,
          toolCallId: surface.toolCallId
        })
      : undefined;
  const builtInDisplay =
    isToolDisplayPayload(display) && !hasRenderedNode(renderedDisplay) ? renderBuiltInDisplay(display) : undefined;
  const displayNode = renderedDisplay ?? builtInDisplay;
  const title = surface.title ?? displayPanelTitle(display, surface.toolName ?? t("displayPanelFallbackTitle"));
  const panelEntry = displayNode
    ? surfacePanelEntry({
        display,
        displayNode,
        surface,
        title
      })
    : undefined;

  useEffect(() => {
    if (!autoPreview || displayMode === "inline" || !panelEntry) {
      return;
    }
    panel.showOnce(panelEntry);
  }, [autoPreview, displayMode, panel, panelEntry]);

  if (!displayNode || !panelEntry) {
    return null;
  }

  if (displayMode === "inline" && displayNode) {
    return <div className="chat-tool-surface-inline max-w-5xl">{displayNode}</div>;
  }

  const panelActive = panel.open && panel.entry?.key === panelEntry.key;
  const openPanel = () => panel.show(panelEntry);

  return (
    <div
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-md border bg-background px-3 py-2.5 text-left text-sm text-foreground shadow-xs transition-colors",
        "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      )}
      role="button"
      tabIndex={0}
      title={t("openDisplayPanel")}
      aria-label={t("openDisplayPanel")}
      onClick={openPanel}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          openPanel();
        }
      }}
    >
      <span
        className="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"
        aria-hidden="true"
      >
        <LayoutDashboard size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {surface.toolName ?? t("displayPanelFallbackTitle")}
        </span>
      </span>
      <button
        type="button"
        className={cn(
          "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border bg-background px-3 text-xs font-medium text-foreground transition-colors",
          "hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        )}
        onClick={(event) => {
          event.stopPropagation();
          openPanel();
        }}
      >
        <PanelRightOpen size={14} aria-hidden="true" />
        <span>{t(panelActive ? "shownInSidePanel" : "openDisplayPanel")}</span>
      </button>
    </div>
  );
}

function surfacePanelEntry({
  display,
  displayNode,
  surface,
  title
}: {
  display: ToolSurfaceRef["display"];
  displayNode: ReactNode;
  surface: ToolSurfaceRef;
  title: string;
}): ToolDisplayPanelEntry {
  return {
    key: displayPanelKey(display, surface.surfaceId),
    title,
    ...(surface.toolName ? { subtitle: surface.toolName } : {}),
    node: displayNode
  };
}

function hasRenderedNode(value: ReactNode): boolean {
  return value !== undefined && value !== null && value !== false;
}
