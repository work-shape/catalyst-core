// @vitest-environment happy-dom

import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { AssistantThread } from "./support/chat-ui";
import { TranslationProvider } from "./chat-ui-render-harness";

// LU-2 (limits spec 3.1): the sentence of a reached spend limit stands above the composer, where
// a person on a phone reads it too. Before, it was only the tooltip of the closed send button.

class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", NoResizeObserver);
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Thread({ usageLimit }: { usageLimit: string | undefined }) {
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
      ...(usageLimit === undefined ? {} : { usageLimit }),
      draftAttachments: [],
      localUploadingAttachments: [],
      sendQueued: false,
      attachmentsEnabled: false,
      attachmentAccept: "",
      messagesEnabled: true,
      messagesLoaded: true,
      loadedMessageCount: 0,
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

async function show(usageLimit: string | undefined): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { children: null, locale: "de" },
          createElement(Thread, { usageLimit })
        )
      )
    );
    await Promise.resolve();
  });
}

describe("a reached spend limit above the composer", () => {
  it("shows the sentence as a status above the composer, and nothing without one", async () => {
    const sentence =
      "Dieser Arbeitsbereich hat sein tägliches Ausgabenlimit erreicht. Es wird um Mitternacht UTC zurückgesetzt. Ein Administrator kann es erhöhen; andere Arbeitsbereiche funktionieren weiter.";
    await show(sentence);
    const block = container.querySelector("[data-testid=usage-limit-block]");
    expect(block?.textContent).toBe(sentence);
    expect(block?.getAttribute("role")).toBe("status");
    expect(container.querySelector("[data-testid=thread-footer]")?.contains(block ?? null)).toBe(
      true
    );

    await show(undefined);
    expect(container.querySelector("[data-testid=usage-limit-block]")).toBeNull();
  });
});
