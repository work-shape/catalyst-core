// @vitest-environment happy-dom

import {
  AssistantRuntimeProvider,
  useComposerRuntime,
  useExternalStoreRuntime,
  useLocalRuntime,
  useThreadRuntime,
  type AssistantRuntime,
  type ThreadMessage
} from "@assistant-ui/react";
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
  followUps?: FollowUpQueueModel,
  useRuntime: () => AssistantRuntime = useIdleRuntime
) {
  let composer: ReturnType<typeof useComposerRuntime> | undefined;
  let thread: ReturnType<typeof useThreadRuntime> | undefined;
  const submitted: string[] = [];
  const queued: string[] = [];
  function Composer() {
    composer = useComposerRuntime();
    thread = useThreadRuntime();
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
    const runtime = useRuntime();
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
  return { composer: required(composer), thread: required(thread), submitted, queued };
}

function useIdleRuntime(): AssistantRuntime {
  return useLocalRuntime({
    async run() {
      return { content: [] };
    }
  });
}

/** A thread whose run goes on, as the thread runtime reports one. */
function useRunningRuntime(): AssistantRuntime {
  return useExternalStoreRuntime<ThreadMessage>({
    messages: [],
    isRunning: true,
    async onNew() {}
  });
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

  it("queues Enter when the run ended after the last render and the runtime still ignores sends", () => {
    const { composer, thread, queued } = mountComposer(
      { onSubmitMessage: undefined },
      undefined,
      useRunningRuntime
    );
    act(() => composer.setText("Keep this send"));
    const input = required(container.querySelector("textarea"));
    const readComposer = composer.getState.bind(composer);
    const readThread = thread.getState.bind(thread);
    // The last render saw the run going, which would let the runtime take the Enter. The run
    // has ended since, and the runtime has not taken up the lifted block: it would ignore it.
    vi.spyOn(composer, "getState").mockImplementation(() => ({
      ...readComposer(),
      canSend: false
    }));
    vi.spyOn(thread, "getState").mockImplementation(() => ({ ...readThread(), isRunning: false }));
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
      followUpModel({
        queue(text, onQueued) {
          messages.push(text);
          accepted = onQueued;
        }
      })
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

  it("sends during the person's own run in their mode, and in the other with Cmd or Ctrl", () => {
    for (const mode of ["queue", "steer"] as const) {
      const sent: Array<[string, string | undefined]> = [];
      const { composer } = mountComposer(
        { conversationRunning: true },
        followUpModel({ mode, queue: (text, _onQueued, sentAs) => sent.push([text, sentAs]) })
      );
      const input = required(container.querySelector("textarea"));
      const other = mode === "queue" ? "steer" : "queue";
      act(() => {
        composer.setText("Plain");
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        composer.setText("With Cmd");
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })
        );
        composer.setText("With Ctrl");
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })
        );
      });
      expect(sent).toEqual([
        ["Plain", mode],
        ["With Cmd", other],
        ["With Ctrl", other]
      ]);
      // The button names the mode and the keys that send in the other one.
      const send = required(
        container.querySelector<HTMLButtonElement>(
          '[aria-label="Send after this answer"], [aria-label="Steer the running answer"]'
        )
      );
      expect(send.title).toMatch(
        mode === "steer"
          ? /^Steer: the agent reads it after its current step\. (⌘|Ctrl)\+Enter sends it after the whole answer instead\.$/u
          : /^Queue: sent once the agent has finished this whole answer\. (⌘|Ctrl)\+Enter steers instead\.$/u
      );
    }
  });

  it("just sends with Cmd or Ctrl and Enter while no run goes", () => {
    const { composer, submitted } = mountComposer();
    const input = required(container.querySelector("textarea"));
    act(() => {
      composer.setText("No run");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })
      );
    });
    expect(submitted).toEqual(["No run"]);
  });

  it("says a steer into someone else's run waits for its answer", () => {
    const { composer } = mountComposer(
      { conversationRunning: true },
      followUpModel({ mode: "steer", ownRun: false })
    );
    act(() => composer.setText("From a colleague"));
    const send = required(
      container.querySelector<HTMLButtonElement>('[aria-label="Send after this answer"]')
    );
    expect(send.title).toBe(
      "Sent once the agent has finished this answer. Only the person who started it can steer it."
    );
  });
});

function followUpModel(overrides: Partial<FollowUpQueueModel> = {}): FollowUpQueueModel {
  return {
    items: [],
    mode: "queue",
    ownRun: true,
    phase: "waiting",
    withdrawingIds: new Set(),
    queueing: false,
    dispatching: false,
    error: undefined,
    queue() {},
    steer() {},
    withdraw() {},
    discardOwn() {},
    sendNow() {},
    ...overrides
  };
}
