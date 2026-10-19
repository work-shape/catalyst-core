// @vitest-environment happy-dom

import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { AssistantThread } from "./support/chat-ui";
import { TranslationProvider } from "./chat-ui-render-harness";
import { required } from "./support/assertions";

// ACCEPT-2d, cosmetic: "Opened <name> · Go to it" appeared over the composer and covered the
// lower edge of the publish card that waited for the person. The footer is pinned over the
// thread, so a footer that grows moves the thread up by as much, where it can scroll that far.

/** What each observed element hears when the browser says it changed its size. */
const observed = new Map<Element, () => void>();

class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(target: Element) {
    observed.set(target, this.callback);
  }
  unobserve(target: Element) {
    observed.delete(target);
  }
  disconnect() {
    for (const [target, callback] of observed) {
      if (callback === this.callback) observed.delete(target);
    }
  }
}

/** What the browser would lay out, per element. Elements not named measure 0. */
const sizes = new WeakMap<
  Element,
  Partial<Record<"offsetHeight" | "scrollTop" | "scrollHeight" | "clientHeight", number>>
>();
const MEASURED = ["offsetHeight", "scrollTop", "scrollHeight", "clientHeight"] as const;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
/** Every scroll the page asked of an element, by where to. */
const scrolls: { element: Element; top: number }[] = [];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.useFakeTimers();
  observed.clear();
  scrolls.length = 0;
  for (const name of MEASURED) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return sizes.get(this)?.[name] ?? 0;
      }
    });
  }
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function scrollTo(
    this: HTMLElement,
    options?: ScrollToOptions | number
  ) {
    const top = typeof options === "object" ? (options.top ?? 0) : 0;
    scrolls.push({ element: this, top });
    sizes.set(this, { ...sizes.get(this), scrollTop: top });
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Thread({ subjectLine }: { subjectLine: ReactNode }) {
  const runtime = useLocalRuntime({
    async run() {
      return { content: [] };
    }
  });
  const noop = () => undefined;
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(AssistantThread, {
      config: undefined,
      agents: [],
      selectedAgentName: undefined,
      selectableModels: [],
      selectedModelBindingId: undefined,
      selectedReasoningEffort: undefined,
      showContextIndicator: false,
      contextSnapshot: undefined,
      notice: undefined,
      subjectLine,
      draftAttachments: [],
      localUploadingAttachments: [],
      sendQueued: false,
      attachmentsEnabled: false,
      attachmentAccept: "",
      messagesEnabled: true,
      messagesLoaded: true,
      loadedMessageCount: 1,
      messageTimes: {},
      composerFocusRequestId: 0,
      onCancelRun: noop,
      onSelectAgent: noop,
      onSelectModelBinding: noop,
      onSelectReasoningEffort: noop,
      onFilesSelected: noop,
      onRemoveDraftAttachment: noop,
      onRetryDraftAttachment: noop,
      onQueueSend: noop
    })
  );
}

async function show(subjectLine: ReactNode): Promise<void> {
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { children: null, locale: "en" },
          createElement(Thread, { subjectLine })
        )
      )
    )
  );
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

/** The thread's scroll container and the part of its footer that holds the notices. */
function parts(): { viewport: HTMLElement; footer: HTMLElement } {
  const opened = required(container.querySelector<HTMLElement>("[data-testid=opened-notice]"));
  // The innermost observed element around the notice: the footer, not the column around it.
  const around = [...observed.keys()].filter(
    (element): element is HTMLElement => element instanceof HTMLElement && element.contains(opened)
  );
  const footer = required(
    around.find((element) => around.every((other) => other === element || other.contains(element)))
  );
  const viewport = required(container.querySelector<HTMLElement>(".chat-thread-inset"));
  return { viewport, footer };
}

const notice = createElement("p", { "data-testid": "opened-notice" }, "Opened Weekly summary");

describe("a notice that appears over the composer", () => {
  it("moves the thread up by as much as the footer grew, instead of covering its last lines", async () => {
    await show(notice);
    const { viewport, footer } = parts();
    sizes.set(viewport, { scrollTop: 400, scrollHeight: 2000, clientHeight: 800 });
    scrolls.length = 0;

    sizes.set(footer, { offsetHeight: 48 });
    act(() => observed.get(footer)?.());

    expect(scrolls).toEqual([{ element: viewport, top: 448 }]);
  });

  it("moves nothing when the footer shrinks, and no further than the thread scrolls", async () => {
    await show(notice);
    const { viewport, footer } = parts();
    sizes.set(footer, { offsetHeight: 96 });
    act(() => observed.get(footer)?.());
    sizes.set(viewport, { scrollTop: 1180, scrollHeight: 2000, clientHeight: 800 });
    scrolls.length = 0;

    sizes.set(footer, { offsetHeight: 48 });
    act(() => observed.get(footer)?.());
    expect(scrolls).toEqual([]);

    // 20 px are left to scroll: the thread moves those, not the 48 the footer grew.
    sizes.set(footer, { offsetHeight: 96 });
    act(() => observed.get(footer)?.());
    expect(scrolls).toEqual([{ element: viewport, top: 1200 }]);
  });
});
