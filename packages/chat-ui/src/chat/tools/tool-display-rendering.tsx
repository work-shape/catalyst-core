import type { ReactNode } from "react";
import { RenderedHtmlDisplay, type ToolDisplayMode } from "../views/rendered-html-display";
import { renderStructuredDataResourceDisplay } from "../files/structured-data-resource-display";
import { APPROVAL_REQUEST_DISPLAY_KIND } from "../approvals/approval-request-model";
import { GenericDataView } from "./generic-data-view";

export type { ToolDisplayMode } from "../views/rendered-html-display";

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
  const mode = readDisplayMode(display);
  if (isHtmlDisplay(display)) {
    const title = typeof display.data.title === "string" ? display.data.title : "Rendered HTML";
    return (
      <RenderedHtmlDisplay html={display.data.html} kind={display.kind} mode={mode} title={title} />
    );
  }
  if (!isGenericDataDisplay(display)) {
    return undefined;
  }
  // Data of a kind without a widget of the release: read from its own shape, never as JSON. In
  // the thread it is bounded and scrolls; the panel has the room.
  return (
    <GenericDataView
      data={display.data}
      className={mode === "inline" ? "max-h-96 overflow-auto p-3" : undefined}
    />
  );
}

/**
 * Whether a display is drawn by the generic data view: it names a kind, carries data, and is
 * none of the kinds the platform draws itself. A record without a kind is data, not a display.
 */
export function isGenericDataDisplay(display: {
  kind?: unknown;
  data?: unknown;
}): display is { kind: string; data: unknown } {
  return (
    typeof display.kind === "string" &&
    display.data !== undefined &&
    display.data !== null &&
    // The approval card is drawn by the tool call itself; elsewhere its ids say nothing.
    display.kind !== APPROVAL_REQUEST_DISPLAY_KIND &&
    !isHtmlDisplay(display) &&
    renderStructuredDataResourceDisplay(display) === undefined
  );
}

function isHtmlDisplay(display: { kind?: unknown; data?: unknown }): display is {
  kind: "html.rendered" | "private_hydrated_view";
  data: { html: string; title?: unknown };
} {
  return (
    (display.kind === "html.rendered" || display.kind === "private_hydrated_view") &&
    isRecord(display.data) &&
    typeof display.data.html === "string"
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
