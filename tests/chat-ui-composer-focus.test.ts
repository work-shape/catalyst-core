// @vitest-environment happy-dom

import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ASSET_KIND } from "@work-shape/catalyst-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { AssistantThread, useComposerFocusRequest } from "./support/chat-ui";
import { TranslationProvider } from "./chat-ui-render-harness";
import { required } from "./support/assertions";

const STARTER = "Build a new agent that ";
const COMMAND = "/tool platform.assets.put {}";
let root: Root;
let container: HTMLDivElement;
let frames: FrameRequestCallback[];

class StillResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", StillResizeObserver);
  vi.useFakeTimers();
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function FocusTarget({ requestId, disabled }: { requestId: number; disabled: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useComposerFocusRequest(input, requestId);
  return createElement(
    "div",
    null,
    createElement("textarea", { ref: input, defaultValue: STARTER, disabled }),
    createElement("button", { type: "button" }, "Other control")
  );
}

function render(requestId = 1, disabled = false): HTMLTextAreaElement {
  act(() => root.render(createElement(FocusTarget, { requestId, disabled })));
  return required(container.querySelector("textarea"));
}

function nextFrame(): void {
  act(() => frames.splice(0).forEach((callback) => callback(0)));
}

function finishRecovery(): void {
  nextFrame();
  act(() => {
    vi.runAllTimers();
  });
}

describe("composer focus recovery", () => {
  it("keeps select-all intact when a delayed attempt lands between selection and paste", () => {
    const input = render();
    expect(document.activeElement).toBe(input);

    // Playwright fill, like an external editor, selects before inserting. A later focus
    // recovery must not collapse that selection and turn replacement into appending.
    input.setSelectionRange(0, input.value.length);
    finishRecovery();
    input.setRangeText(COMMAND, input.selectionStart, input.selectionEnd, "end");

    expect(input.value).toBe(COMMAND);
  });

  it("keeps the selection after a disabled input becomes focusable on the next frame", () => {
    const input = render(1, true);
    expect(document.activeElement).not.toBe(input);
    input.disabled = false;
    nextFrame();
    expect(document.activeElement).toBe(input);
    input.setSelectionRange(0, input.value.length);

    act(() => {
      vi.runAllTimers();
    });

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(STARTER.length);
  });

  it.each(["pointerdown", "keydown"])("gives up after a person's %s", (eventName) => {
    const input = render(1, true);
    const other = required(container.querySelector("button"));
    other.focus();
    other.dispatchEvent(new Event(eventName, { bubbles: true }));
    input.disabled = false;

    finishRecovery();

    expect(document.activeElement).toBe(other);
  });

  it("leaves focus alone when none was requested", () => {
    const input = render(0);
    finishRecovery();
    expect(document.activeElement).not.toBe(input);
  });

  it("focuses again for a new request", () => {
    const input = render();
    required(container.querySelector("button")).focus();
    render(2);
    expect(document.activeElement).toBe(input);
  });
});

async function settleRuntime(): Promise<void> {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

function EmptyThread() {
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
      subjectKind: APP_ASSET_KIND,
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

describe("composer focus after a starter", () => {
  it("keeps a selection made before the next frame, so replacing the starter replaces it", async () => {
    act(() =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { children: null, locale: "en" },
            createElement(EmptyThread)
          )
        )
      )
    );
    // The runtime reports its state to the page after a timer: the thread as loaded, and so
    // empty, then the starter's text in the composer.
    await settleRuntime();
    const starter = required(container.querySelector<HTMLButtonElement>('[role="group"] button'));
    act(() => starter.click());
    await settleRuntime();
    const input = required(container.querySelector("textarea"));
    expect(input.value).not.toBe("");

    // A fill selects the starter in the composer before the starter's focus frame comes.
    input.focus();
    input.setSelectionRange(0, input.value.length);
    nextFrame();
    input.setRangeText(COMMAND, input.selectionStart, input.selectionEnd, "end");

    expect(input.value).toBe(COMMAND);
  });
});
