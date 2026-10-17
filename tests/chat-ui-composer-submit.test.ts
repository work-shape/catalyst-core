// @vitest-environment happy-dom

import { AssistantRuntimeProvider, useComposerRuntime, useLocalRuntime } from "@assistant-ui/react";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  FollowUpQueueProvider,
  type FollowUpQueueModel
} from "@work-shape/catalyst-chat-ui/follow-up-queue";
import { AssistantComposer } from "./support/chat-ui";
import { TranslationProvider } from "./chat-ui-render-harness";
import { required } from "./support/assertions";

class StillResizeObserver {
  observe() {}
  disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", StillResizeObserver);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountComposer(
  options: Partial<ComponentProps<typeof AssistantComposer>> = {},
  followUps?: FollowUpQueueModel
) {
  let composer: ReturnType<typeof useComposerRuntime> | undefined;
  const submitted: string[] = [];
  const queued: string[] = [];
  function Composer() {
    composer = useComposerRuntime();
    return createElement(AssistantComposer, {
      attachments: [],
      localUploadingAttachments: [],
      sendQueued: false,
      attachmentsEnabled: false,
      attachmentAccept: "",
      selectableModels: [],
      selectedModelBindingId: undefined,
      selectedReasoningEffort: undefined,
      showContextIndicator: false,
      contextSnapshot: undefined,
      focusRequestId: 0,
      onCancelRun() {},
      onSelectModelBinding() {},
      onSelectReasoningEffort() {},
      onFilesSelected() {},
      onRemoveAttachment() {},
      onRetryAttachment() {},
      onQueueSend: (text) => queued.push(text),
      onSubmitMessage: (text) => {
        submitted.push(text);
        return true;
      },
      ...options
    });
  }
  function Harness() {
    const runtime = useLocalRuntime({
      async run() {
        return { content: [] };
      }
    });
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(
        FollowUpQueueProvider,
        { value: followUps, children: null },
        createElement(Composer)
      )
    );
  }
  act(() =>
    root?.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(TranslationProvider, { children: null, locale: "en" }, createElement(Harness))
      )
    )
  );
  return { composer: required(composer), submitted, queued };
}

describe("composer submission before its next render", () => {
  it("sends the current text on Enter", () => {
    const { composer, submitted } = mountComposer();
    const input = required(container.querySelector("textarea"));
    act(() => {
      composer.setText("The message just typed");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(submitted).toEqual(["The message just typed"]);
  });

  it("submits the current text through the form", () => {
    const { composer, submitted } = mountComposer();
    const form = required(container.querySelector("form"));
    act(() => {
      composer.setText("Submitted without another render");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submitted).toEqual(["Submitted without another render"]);
  });

  it("queues the current text while the switched conversation loads", () => {
    const { composer, queued } = mountComposer({
      sendBlock: { reason: "Loading", loading: true },
      onSubmitMessage: undefined
    });
    const input = required(container.querySelector("textarea"));
    act(() => {
      composer.setText("Sent right after the switch");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(queued).toEqual(["Sent right after the switch"]);
  });

  it("queues Enter when live readiness falls behind what the last render saw", () => {
    const { composer, queued } = mountComposer({ onSubmitMessage: undefined });
    act(() => composer.setText("Keep this send"));
    const input = required(container.querySelector("textarea"));
    const readState = composer.getState.bind(composer);
    // The runtime takes up a changed block after the component rendered. The live getter
    // reports that it would ignore Send, while the previous render still said it could send.
    vi.spyOn(composer, "getState").mockImplementation(() => ({
      ...readState(),
      canSend: false
    }));
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(queued).toEqual(["Keep this send"]);
  });

  it("clicking Send uses the edited text instead of the starter", () => {
    const { composer, submitted } = mountComposer();
    act(() => composer.setText("Build a new agent that "));
    const send = required(
      container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')
    );
    act(() => {
      composer.setText("/tool platform.assets.put {}");
      send.click();
    });
    expect(submitted).toEqual(["/tool platform.assets.put {}"]);
  });

  it("queues the current follow-up and preserves text edited while it is accepted", () => {
    const messages: string[] = [];
    let accepted: (() => void) | undefined;
    const { composer } = mountComposer(
      { conversationRunning: true },
      {
        items: [],
        phase: "waiting",
        withdrawingIds: new Set(),
        queueing: false,
        dispatching: false,
        error: undefined,
        queue(text, onQueued) {
          messages.push(text);
          accepted = onQueued;
        },
        withdraw() {},
        discardOwn() {},
        sendNow() {}
      }
    );
    const input = required(container.querySelector("textarea"));
    act(() => {
      composer.setText("The current follow-up");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(messages).toEqual(["The current follow-up"]);
    act(() => {
      composer.setText("Still writing");
      required(accepted)();
    });
    expect(composer.getState().text).toBe("Still writing");
  });
});
