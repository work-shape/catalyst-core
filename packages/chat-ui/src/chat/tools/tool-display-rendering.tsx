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
  if (
    (display.kind === "html.rendered" || display.kind === "private_hydrated_view") &&
    isRecord(display.data) &&
    typeof display.data.html === "string"
  ) {
    const title = typeof display.data.title === "string" ? display.data.title : "Rendered HTML";
    return (
      <RenderedHtmlDisplay html={display.data.html} kind={display.kind} mode={mode} title={title} />
    );
  }
  // The approval card is drawn by the tool call itself; elsewhere its ids say nothing.
  if (display.kind === APPROVAL_REQUEST_DISPLAY_KIND || display.data === undefined) {
    return undefined;
  }
  // Data of a kind without a widget of the release: read from its own shape, never as JSON.
  return <GenericDataView data={display.data} className={mode === "inline" ? "p-3" : undefined} />;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
