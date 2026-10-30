import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS } from "./assertions";
import { TranslationProvider } from "./chat-ui/shared";

/**
 * The items of a page head's "…" menu: the page mounted in English, the menu opened from the
 * keyboard, each item's text. None where the head has no menu. Needs a DOM environment.
 */
export async function headMenuItems(page: ReactElement): Promise<string[]> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(TranslationProvider, { children: null, locale: "en" }, page)
      )
    );
  });
  const trigger = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${uiLabelsEn.moreActions}"]`
  );
  let items: string[] = [];
  if (trigger !== null) {
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await vi.waitFor(
      () => {
        // The menu stands outside the page, under the id its button names.
        const menu = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
        items = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].map(
          (item) => item.textContent?.trim() ?? ""
        );
        expect(items.length).toBeGreaterThan(0);
      },
      { timeout: CONDITION_WAIT_MS }
    );
  }
  await act(async () => root.unmount());
  host.remove();
  return items;
}
