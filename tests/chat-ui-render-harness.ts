import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { UiRoot, uiLabelsEn } from "@vivd-catalyst/ui";

/** The chat UI keeps its translation provider internal; tests take it from here. */
export { TranslationProvider } from "../packages/chat-ui/src/i18n";

/**
 * Renders chat UI the way the product does: inside a `UiRoot`. Library components that open an
 * overlay or show a label of their own refuse to render without one. The root's own element and
 * its empty overlay container are cut from the result, so a test reads the markup of what it
 * rendered.
 */
export function renderToStaticMarkup(node: ReactNode): string {
  const markup = renderMarkup(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, node));
  const start = '<div class="">';
  const end = '<div data-catalyst-overlays="" class="contents"></div></div>';
  // React puts resource hints, such as an image preload, in front of the root.
  const startIndex = markup.indexOf(start);
  if (startIndex === -1 || !markup.endsWith(end)) {
    throw new Error("UiRoot rendered an unexpected frame.");
  }
  return (
    markup.slice(0, startIndex) +
    markup.slice(startIndex + start.length, markup.length - end.length)
  );
}
