import { Database, LayoutDashboard, PanelRightOpen } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { STRUCTURED_DATA_RESOURCE_DISPLAY_KIND, type LocaleCode } from "@vivd-catalyst/core";
import { Button, cn } from "@vivd-catalyst/ui";
import {
  isToolDisplayPayload,
  ToolDisplayWidgetNode,
  useToolDisplayWidget
} from "./domain-ui-widgets";
import { useTranslation } from "./i18n";
import {
  displayPanelKey,
  displayPanelTitle,
  readDisplayMode,
  renderBuiltInDisplay
} from "./tool-display-rendering";
import type { Surface } from "./surface/surface";
import { useToolDisplayPanel } from "./tool-display-panel";
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
    // One column that may shrink, so a card in a narrow thread truncates its title.
    <div className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2", className)}>
      {surfaces.map((surface, index) => (
        <ToolSurfaceCard
          key={surface.surfaceId}
          autoPreview={autoPreview && index === surfaces.length - 1}
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
    isToolDisplayPayload(display) && !hasRenderedNode(renderedDisplay)
      ? renderBuiltInDisplay(display)
      : undefined;
  const displayNode = renderedDisplay ?? builtInDisplay;
  const panelDisplayNode = isToolDisplayPayload(display) ? (
    <ToolDisplayWidgetNode
      display={display}
      fallback={builtInDisplay}
      locale={locale}
      source="message-metadata"
      toolCallId={surface.toolCallId}
      toolName={surface.toolName}
    />
  ) : (
    builtInDisplay
  );
  const title =
    surface.title ?? displayPanelTitle(display, surface.toolName ?? t("displayPanelFallbackTitle"));
  const panelEntry = displayNode
    ? surfacePanelEntry({
        display,
        displayNode: panelDisplayNode,
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
  const SurfaceIcon =
    display.kind === STRUCTURED_DATA_RESOURCE_DISPLAY_KIND ? Database : LayoutDashboard;

  return (
    <div
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left text-sm text-foreground transition-colors",
        "hover:bg-state-hover focus-visible:focus-ring"
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
        className="grid size-10 shrink-0 place-items-center rounded-md bg-primary-soft text-primary-soft-foreground"
        aria-hidden="true"
      >
        <SurfaceIcon size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
      </span>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={(event) => {
          event.stopPropagation();
          openPanel();
        }}
      >
        <PanelRightOpen aria-hidden="true" />
        {t(panelActive ? "shownInSidePanel" : "openDisplayPanel")}
      </Button>
    </div>
  );
}

/**
 * Builds the panel entry for a surface without rendering a card.
 *
 * Lets a run-completion effect open the panel directly, instead of depending on
 * a card mounting, its render order, and the auto-show tracker.
 */
export function createToolSurfacePanelEntry({
  fallbackTitle,
  locale,
  surface
}: {
  fallbackTitle: string;
  locale: LocaleCode;
  surface: ToolSurfaceRef;
}): Surface | undefined {
  const display = surface.display;
  if (!isToolDisplayPayload(display) || readDisplayMode(display) === "inline") {
    return undefined;
  }
  return surfacePanelEntry({
    display,
    displayNode: (
      <ToolDisplayWidgetNode
        display={display}
        fallback={renderBuiltInDisplay(display)}
        locale={locale}
        source="message-metadata"
        toolCallId={surface.toolCallId}
        toolName={surface.toolName}
      />
    ),
    surface,
    title: surface.title ?? displayPanelTitle(display, surface.toolName ?? fallbackTitle)
  });
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
}): Surface {
  return {
    kind: "tool_display",
    key: displayPanelKey(display, surface.surfaceId),
    title,
    node: displayNode
  };
}

function hasRenderedNode(value: ReactNode): boolean {
  return value !== undefined && value !== null && value !== false;
}
