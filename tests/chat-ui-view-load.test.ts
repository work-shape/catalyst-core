// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslationContext, TranslationProvider } from "./support/chat-ui/shared";
import {
  RenderedHtmlDisplay,
  VIEW_LOAD_TIMEOUT_MS,
  VIEW_SHELL_READY_GRACE_MS,
  ViewPolicyProvider
} from "@work-shape/catalyst-chat-ui/views";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

// ACCEPT-FIX-2 C13: a view in a conversation that cannot load stops spinning "Loading view…".
// A shell frame that loads without the shell saying ready, as a blocked or failed address does,
// says the view could not be loaded; a view that has not loaded after VIEW_LOAD_TIMEOUT_MS says so with the limit.
// Both offer Try again, which starts a new shell.

const en = createTranslationContext("en").t;
const de = createTranslationContext("de").t;

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Keeps happy-dom's own error for the frame page it does not load from the frame: a browser
 * reports no error event on a frame, whatever its page.
 */
function framesNeverFail(): void {
  const dispatch = HTMLIFrameElement.prototype.dispatchEvent;
  vi.spyOn(HTMLIFrameElement.prototype, "dispatchEvent").mockImplementation(function (
    this: HTMLIFrameElement,
    event: Event
  ) {
    return event.type === "error" ? true : dispatch.call(this, event);
  });
}

async function mount(locale: "en" | "de" = "en"): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        WorkspaceApiClientProvider,
        { apiBaseUrl: "https://chat.example.com", children: null },
        createElement(
          ViewPolicyProvider,
          { allowedScriptSrc: [], children: null },
          createElement(
            TranslationProvider,
            { locale, children: null },
            createElement(
              UiRoot,
              { mode: "light", labels: uiLabelsEn },
              createElement(RenderedHtmlDisplay, {
                html: "<p>Quarterly revenue</p>",
                kind: "html.rendered",
                mode: "inline",
                title: "Quarterly revenue"
              })
            )
          )
        )
      )
    );
  });
  unmounts.push(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  return container;
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const loadError = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-load-error]");

async function tryAgain(container: HTMLElement): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === uiLabelsEn.tryAgain
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

describe("a view in a conversation that cannot load", () => {
  it("says it could not be loaded once the frame loaded and the shell never said ready", async () => {
    vi.useFakeTimers();
    framesNeverFail();
    const view = await mount();
    const frame = view.querySelector("iframe");
    expect(frame).not.toBeNull();
    await act(async () => frame?.dispatchEvent(new Event("load")));
    await advance(VIEW_SHELL_READY_GRACE_MS - 1);
    expect(loadError(view)).toBeNull();
    expect(view.textContent).toContain(en("displayLoading"));
    await advance(1);
    expect(loadError(view)?.textContent).toContain(en("displayLoadFailed"));
    expect(view.textContent).not.toContain(en("displayLoading"));
    // The browser's own page for the failed frame is not shown under the error.
    expect(view.querySelector("iframe")).toBeNull();

    // The load limit of the failed shell no longer runs: the failure stays as it is.
    await advance(VIEW_LOAD_TIMEOUT_MS);
    expect(loadError(view)?.textContent).toContain(en("displayLoadFailed"));
    expect(view.textContent).not.toContain(
      en("displayLoadTimedOut", { seconds: VIEW_LOAD_TIMEOUT_MS / 1000 })
    );
    expect(view.textContent).not.toContain(en("displayLoading"));

    await tryAgain(view);
    expect(loadError(view)).toBeNull();
    expect(view.textContent).toContain(en("displayLoading"));
    expect(view.querySelector("iframe")).not.toBeNull();
  });

  it("names the limit when the view has not loaded in time, and starts again on Try again", async () => {
    vi.useFakeTimers();
    framesNeverFail();
    const view = await mount();
    const first = view.querySelector("iframe");
    await advance(VIEW_LOAD_TIMEOUT_MS - 1);
    expect(loadError(view)).toBeNull();
    expect(view.textContent).toContain(en("displayLoading"));
    await advance(1);
    expect(loadError(view)?.textContent).toContain(
      en("displayLoadTimedOut", { seconds: VIEW_LOAD_TIMEOUT_MS / 1000 })
    );
    expect(view.textContent).not.toContain(en("displayLoading"));

    await tryAgain(view);
    expect(loadError(view)).toBeNull();
    expect(view.textContent).toContain(en("displayLoading"));
    const second = view.querySelector("iframe");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    // The new shell has the whole limit again.
    await advance(VIEW_LOAD_TIMEOUT_MS - 1);
    expect(loadError(view)).toBeNull();
    await advance(1);
    expect(loadError(view)).not.toBeNull();
  });

  it("says so in German", async () => {
    vi.useFakeTimers();
    framesNeverFail();
    const view = await mount("de");
    await advance(VIEW_LOAD_TIMEOUT_MS);
    expect(loadError(view)?.textContent).toContain(
      "Diese Ansicht wurde nicht innerhalb von 30 Sekunden geladen."
    );
    expect(de("displayLoadFailed")).toBe("Diese Ansicht konnte nicht geladen werden.");
  });
});
