// @vitest-environment happy-dom

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useComposerRuntime,
  useExternalStoreRuntime,
  useLocalRuntime,
  useThreadRuntime,
  type AssistantRuntime,
  type ThreadMessage
} from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import JSZip from "jszip";
import { act, createElement, useRef, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_ASSET_KIND, createApiClient, type SafeConfig } from "@work-shape/catalyst-api-client";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import {
  FollowUpQueueProvider,
  type FollowUpQueueModel
} from "@work-shape/catalyst-chat-ui/follow-up-queue";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  AssistantComposer,
  AssistantThread,
  ThreadStartBlock,
  createQueuedSendSettler,
  draftAttachmentsKey,
  managedFileIdFromAttachmentContent,
  resolveSendBlock,
  shouldQueueSend,
  stabilizeThreadListState,
  toAttachmentFilePart,
  useCatalystChatRuntime,
  useComposerFocusRequest,
  useDraftAttachmentController,
  visibleSendRefusal,
  type ConversationStart,
  type QueuedSendState,
  type SendBlock
} from "./support/chat-ui";
import { createTranslationContext } from "./support/chat-ui/shared";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";

class StillResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let root: Root;
let container: HTMLDivElement;
let renderErrors: unknown[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", StillResizeObserver);
  container = document.createElement("div");
  document.body.append(container);
  renderErrors = [];
  root = createRoot(container, {
    onUncaughtError: (error) => renderErrors.push(error),
    onCaughtError: (error) => renderErrors.push(error)
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const noop = () => undefined;
const { t } = createTranslationContext("en");

function enter(input: HTMLElement, keys: KeyboardEventInit = {}) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...keys }));
}

function useIdleRuntime(): AssistantRuntime {
  return useLocalRuntime({
    async run() {
      return { content: [] };
    }
  });
}

/** The props of a thread without anything in it; a test names what it needs. */
function threadProps(
  overrides: Partial<ComponentProps<typeof AssistantThread>> = {}
): ComponentProps<typeof AssistantThread> {
  return {
    config: undefined,
    agents: [],
    selectedAgentName: undefined,
    selectableModels: [],
    selectedModelBindingId: undefined,
    selectedReasoningEffort: undefined,
    showContextIndicator: false,
    contextSnapshot: undefined,
    notice: undefined,
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
    onQueueSend: noop,
    ...overrides
  };
}

// chat.catalyst, 22 Oct 2026: one letter in the composer threw "Maximum update depth exceeded.
// The result of getSnapshot should be cached". The deployment's install gave assistant-ui
// tap 0.9.23, which re-reads every snapshot after each commit, and the thread list of core 0.2
// answers a new state object on each read. Core's lock runs tap 0.9.3, which forgives that, so
// the typing passes here either way; the identity of the thread list state is what fails
// without the fix.
describe("composer typing and the thread list state", () => {
  const transport: NonNullable<
    NonNullable<Parameters<typeof useCatalystChatRuntime>[0]>["transport"]
  > = {
    sendMessages: () => Promise.reject(new Error("This test sends nothing.")),
    reconnectToStream: () => Promise.resolve(null)
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("keeps the thread list state between reads and takes a letter without a render loop", async () => {
    let runtime: AssistantRuntime | undefined;
    function Harness() {
      runtime = useCatalystChatRuntime({ transport });
      return createElement(
        AssistantRuntimeProvider,
        { runtime },
        createElement(
          ComposerPrimitive.Root,
          null,
          createElement(ComposerPrimitive.Input, { "aria-label": "Message" })
        )
      );
    }
    await act(async () => {
      root.render(createElement(Harness));
      await settle();
    });
    const threads = required(runtime).threads;
    expect(threads.getState()).toBe(threads.getState());

    const input = required(container.querySelector("textarea"));
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      required(setValue).call(input, "a");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    expect(renderErrors).toEqual([]);
    expect(required(runtime).thread.composer.getState().text).toBe("a");
  });

  it("answers a new state object once a field of the thread list changed", () => {
    const list = { mainThreadId: "first", threadIds: ["first"] as readonly string[] };
    const threads = { getState: () => ({ ...list }) };
    stabilizeThreadListState({ threads });
    const before = threads.getState();
    expect(threads.getState()).toBe(before);
    list.threadIds = ["first", "second"];
    const after = threads.getState();
    expect(after).not.toBe(before);
    expect(after.threadIds).toEqual(["first", "second"]);
    expect(threads.getState()).toBe(after);
  });
});

describe("composer focus", () => {
  const STARTER = "Build a new agent that ";
  const COMMAND = "/tool platform.assets.put {}";
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(noop);
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

  it("focuses for a new request only", () => {
    const input = render(0);
    finishRecovery();
    expect(document.activeElement).not.toBe(input);
    render(1);
    expect(document.activeElement).toBe(input);
    required(container.querySelector("button")).focus();
    render(2);
    expect(document.activeElement).toBe(input);
  });

  it("keeps a selection made before the starter's focus frame, so replacing the starter replaces it", async () => {
    function EmptyThread() {
      const runtime = useIdleRuntime();
      return createElement(
        AssistantRuntimeProvider,
        { runtime },
        createElement(
          AssistantThread,
          threadProps({ start: { about: "asset", kind: APP_ASSET_KIND, title: undefined } })
        )
      );
    }
    const settleRuntime = () =>
      act(async () => {
        await vi.runAllTimersAsync();
      });
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

    input.focus();
    input.setSelectionRange(0, input.value.length);
    nextFrame();
    input.setRangeText(COMMAND, input.selectionStart, input.selectionEnd, "end");

    expect(input.value).toBe(COMMAND);
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

describe("composer submission before its next render", () => {
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
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { children: null, locale: "en" },
            createElement(Harness)
          )
        )
      )
    );
    return {
      composer: required(composer),
      thread: required(thread),
      input: required(container.querySelector("textarea")),
      form: required(container.querySelector("form")),
      submitted,
      queued
    };
  }

  /** A thread whose run goes on, as the thread runtime reports one. */
  function useRunningRuntime(): AssistantRuntime {
    return useExternalStoreRuntime<ThreadMessage>({
      messages: [],
      isRunning: true,
      async onNew() {}
    });
  }

  it("sends the current text on Enter and through the form", () => {
    const { composer, input, form, submitted } = mountComposer();
    act(() => {
      composer.setText("Typed just now");
      enter(input);
    });
    act(() => {
      composer.setText("Submitted without another render");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submitted).toEqual(["Typed just now", "Submitted without another render"]);
  });

  it.each(["Enter", "submit"])(
    "sends an open conversation's draft on %s when readiness advances before the next render",
    async (via) => {
      const { composer, thread, input, form } = mountComposer({ onSubmitMessage: undefined });
      // The form rendered with an empty composer, so its captured send callback is disabled.
      // The thread becomes sendable before React takes up the new state, as a load can do.
      await act(async () => {
        composer.setText("Send as soon as the conversation is ready");
        if (via === "Enter") enter(input);
        else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(
        thread
          .getState()
          .messages.filter((message) => message.role === "user")
          .map((message) => message.content)
      ).toEqual([[{ type: "text", text: "Send as soon as the conversation is ready" }]]);
    }
  );

  it("queues the current text while the switched conversation loads", () => {
    const { composer, input, queued } = mountComposer({
      sendBlock: { reason: "Loading", loading: true },
      onSubmitMessage: undefined
    });
    act(() => {
      composer.setText("Sent right after the switch");
      enter(input);
    });
    expect(queued).toEqual(["Sent right after the switch"]);
  });

  it("queues Enter when live readiness falls behind what the last render saw", () => {
    const { composer, input, queued } = mountComposer({ onSubmitMessage: undefined });
    act(() => composer.setText("Keep this send"));
    const readState = composer.getState.bind(composer);
    // The runtime takes up a changed block after the component rendered. The live getter
    // reports that it would ignore Send, while the previous render still said it could send.
    vi.spyOn(composer, "getState").mockImplementation(() => ({ ...readState(), canSend: false }));
    act(() => enter(input));
    expect(queued).toEqual(["Keep this send"]);
  });

  it("queues Enter when the run ended after the last render and the runtime still ignores sends", () => {
    const { composer, thread, input, queued } = mountComposer(
      { onSubmitMessage: undefined },
      undefined,
      useRunningRuntime
    );
    act(() => composer.setText("Keep this send"));
    const readComposer = composer.getState.bind(composer);
    const readThread = thread.getState.bind(thread);
    // The last render saw the run going, which would let the runtime take the Enter. The run
    // has ended since, and the runtime has not taken up the lifted block: it would ignore it.
    vi.spyOn(composer, "getState").mockImplementation(() => ({
      ...readComposer(),
      canSend: false
    }));
    vi.spyOn(thread, "getState").mockImplementation(() => ({ ...readThread(), isRunning: false }));
    act(() => enter(input));
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
    const { composer, input } = mountComposer(
      { conversationRunning: true },
      followUpModel({
        queue(text, onQueued) {
          messages.push(text);
          accepted = onQueued;
        }
      })
    );
    act(() => {
      composer.setText("The current follow-up");
      enter(input);
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
      const { composer, input } = mountComposer(
        { conversationRunning: true },
        followUpModel({ mode, queue: (text, _onQueued, sentAs) => sent.push([text, sentAs]) })
      );
      const other = mode === "queue" ? "steer" : "queue";
      act(() => {
        composer.setText("Plain");
        enter(input);
        composer.setText("With Cmd");
        enter(input, { metaKey: true });
        composer.setText("With Ctrl");
        enter(input, { ctrlKey: true });
      });
      expect(sent).toEqual([
        ["Plain", mode],
        ["With Cmd", other],
        ["With Ctrl", other]
      ]);
    }
  });

  it("just sends with Cmd and Enter while no run goes", () => {
    const { composer, input, submitted } = mountComposer();
    act(() => {
      composer.setText("No run");
      enter(input, { metaKey: true });
    });
    expect(submitted).toEqual(["No run"]);
  });

  it("offers no steer into someone else's run", () => {
    const { composer } = mountComposer(
      { conversationRunning: true },
      followUpModel({ mode: "steer", ownRun: false })
    );
    act(() => composer.setText("From a colleague"));
    expect(container.querySelector('[aria-label="Send after this answer"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Steer the running answer"]')).toBeNull();
  });
});

describe("send block", () => {
  const unblocked: Parameters<typeof resolveSendBlock>[0] = {
    sending: false,
    workspaceBlock: undefined,
    snapshotStatus: "ready",
    noAgentsMessage: undefined,
    t
  };
  const block = (input: Partial<typeof unblocked>) => resolveSendBlock({ ...unblocked, ...input });

  it("blocks while something loads or refuses, waiting to send only where loading may end", () => {
    expect(block({})).toBeUndefined();
    const workspaceBlock = { reason: "Workspaces could not be loaded.", loading: false };
    expect(block({ workspaceBlock })).toEqual(workspaceBlock);
    expect(block({ noAgentsMessage: "No agents here." })).toEqual({
      reason: "No agents here.",
      loading: false
    });
    expect(block({ snapshotStatus: "loading" })).toMatchObject({ loading: true });
    // The dock's conversation still loads, without waiting to send.
    expect(block({ snapshotStatus: "loading", queueWhileLoading: false })).toMatchObject({
      loading: false
    });
    expect(block({ snapshotStatus: "not_found" })).toMatchObject({ loading: false });
    // The first message is already on its way.
    expect(
      block({ sending: true, workspaceBlock: { reason: "Loading workspaces…", loading: true } })
    ).toMatchObject({ loading: false });
    // Loading is reported before the missing agents, which only show once loading ends.
    expect(block({ snapshotStatus: "loading", noAgentsMessage: "No agents here." })).toMatchObject({
      loading: true
    });
  });
});

describe("composer send during a block", () => {
  const loading: SendBlock = { reason: "Loading workspaces…", loading: true };
  const refusals: SendBlock[] = [
    { reason: "Workspaces could not be loaded.", loading: false },
    { reason: "The conversation is still running.", loading: false }
  ];
  const ask = { sendQueued: false, text: "Hello", runtimeReady: true };

  function waiting(overrides: Partial<QueuedSendState> = {}): QueuedSendState {
    return {
      queued: { text: "Hello", collaborationWorkspaceId: undefined, attachmentsKey: "" },
      block: loading,
      composerText: "Hello",
      attachmentsKey: "",
      collaborationWorkspaceId: undefined,
      runtimeReady: true,
      ...overrides
    };
  }

  // A conversation switched to is "loading" until its thread arrives, then "ready" or "error".
  function threadBlock(snapshotStatus: "loading" | "ready" | "error"): SendBlock | undefined {
    return resolveSendBlock({
      sending: false,
      workspaceBlock: undefined,
      snapshotStatus,
      noAgentsMessage: undefined,
      t
    });
  }

  it("remembers a send with text while loading, or before the runtime takes up a lifted block", () => {
    expect(shouldQueueSend({ ...ask, sendBlock: loading })).toBe(true);
    const inBetween = { ...ask, sendBlock: undefined, runtimeReady: false };
    expect(shouldQueueSend(inBetween)).toBe(true);
    expect(shouldQueueSend({ ...inBetween, text: " " })).toBe(false);
    expect(shouldQueueSend({ ...inBetween, sendQueued: true })).toBe(false);
    expect(shouldQueueSend({ ...ask, sendBlock: loading, text: "  \n" })).toBe(false);
    expect(shouldQueueSend({ ...ask, sendBlock: undefined })).toBe(false);
    expect(shouldQueueSend({ ...ask, sendBlock: loading, sendQueued: true })).toBe(false);
  });

  it.each(refusals)("does not remember, and drops, a send refused with: $reason", (refusal) => {
    expect(shouldQueueSend({ ...ask, sendBlock: refusal })).toBe(false);
    expect(shouldQueueSend({ ...ask, sendBlock: refusal, runtimeReady: false })).toBe(false);
    const settle = createQueuedSendSettler();
    const state = waiting();
    expect(settle(state)).toBe("wait");
    expect(settle({ ...state, block: refusal })).toBe("drop");
    expect(settle({ ...state, block: undefined })).toBe("wait");
  });

  it("sends a queued message exactly once, after loading and the runtime taking it up", () => {
    const settle = createQueuedSendSettler();
    const state = waiting();
    const loaded = { ...state, block: undefined, collaborationWorkspaceId: "workspace_personal" };

    expect([
      settle(state),
      settle({ ...loaded, runtimeReady: false }),
      settle(loaded),
      settle(loaded)
    ]).toEqual(["wait", "wait", "send", "wait"]);
  });

  it("sends a message written while the conversation's thread loads once, when it arrives", () => {
    const settle = createQueuedSendSettler();
    const loadingThread = waiting({ block: threadBlock("loading") });
    const arrived = { ...loadingThread, block: threadBlock("ready") };

    expect(shouldQueueSend({ ...ask, sendBlock: loadingThread.block })).toBe(true);
    expect([
      settle(loadingThread),
      settle({ ...arrived, runtimeReady: false }),
      settle(arrived),
      settle(arrived),
      settle(loadingThread),
      settle(arrived)
    ]).toEqual(["wait", "wait", "send", "wait", "wait", "wait"]);
  });

  it("does not send a waiting message when the thread fails to load, nor on a later reload", () => {
    const settle = createQueuedSendSettler();
    const loadingThread = waiting({ block: threadBlock("loading") });
    const failed = { ...loadingThread, block: threadBlock("error") };

    // The send is forgotten, the text stays in the composer under the reason shown.
    expect([settle(loadingThread), settle(failed)]).toEqual(["wait", "drop"]);
    expect(settle({ ...loadingThread, block: threadBlock("ready") })).toBe("wait");
    expect(shouldQueueSend({ ...ask, sendBlock: failed.block })).toBe(false);
  });

  it("drops the queued message when the user edits the text, or the workspace changes", () => {
    const edited = createQueuedSendSettler();
    const written = waiting();
    expect(edited({ ...written, composerText: "Hello!" })).toBe("drop");
    // Also when the text is back to what was queued.
    expect(edited({ ...written, block: undefined })).toBe("wait");

    const moved = createQueuedSendSettler();
    const state = waiting({
      queued: { text: "Hello", collaborationWorkspaceId: "workspace_a", attachmentsKey: "" },
      collaborationWorkspaceId: "workspace_a"
    });
    expect(moved(state)).toBe("wait");
    expect(moved({ ...state, block: undefined, collaborationWorkspaceId: "workspace_b" })).toBe(
      "drop"
    );
  });

  it("drops the queued message, not the text, when an attachment is added or removed", () => {
    const withFile = draftAttachmentsKey([{ id: "attachment_a" }]);
    const added = createQueuedSendSettler();
    expect(added(waiting())).toBe("wait");
    expect(added(waiting({ attachmentsKey: withFile }))).toBe("drop");

    const removed = createQueuedSendSettler();
    const queuedWithFile = waiting({
      queued: { text: "Hello", collaborationWorkspaceId: undefined, attachmentsKey: withFile },
      attachmentsKey: withFile
    });
    expect(removed(queuedWithFile)).toBe("wait");
    expect(removed({ ...queuedWithFile, block: undefined, attachmentsKey: "" })).toBe("drop");

    const kept = createQueuedSendSettler();
    expect(
      kept({
        ...queuedWithFile,
        block: undefined,
        attachmentsKey: draftAttachmentsKey([{ id: "attachment_a" }])
      })
    ).toBe("send");
  });

  it("sends a second queued message after the first was settled", () => {
    const settle = createQueuedSendSettler();
    const edited = () => ({
      text: "Edited",
      collaborationWorkspaceId: undefined,
      attachmentsKey: ""
    });

    expect(settle(waiting({ composerText: "Edited" }))).toBe("drop");
    expect(settle(waiting({ queued: edited() }))).toBe("drop");
    expect(settle(waiting({ queued: edited(), composerText: "Edited", block: undefined }))).toBe(
      "send"
    );
  });

  it("ends a refusal once the refused file is removed and good files are attached", () => {
    const refusedDraft = draftAttachmentsKey([{ id: "kaputt.docx" }]);
    const refusal = { message: "kaputt.docx is not readable.", attachmentsKey: refusedDraft };

    expect(visibleSendRefusal(refusal, refusedDraft)).toBe(refusal.message);
    expect(visibleSendRefusal(refusal, "")).toBeUndefined();
    expect(
      visibleSendRefusal(
        refusal,
        draftAttachmentsKey([{ id: "vertrag.pdf" }, { id: "rechnung.json" }])
      )
    ).toBeUndefined();
    expect(visibleSendRefusal(undefined, refusedDraft)).toBeUndefined();
  });
});

describe("the retention line above the composer", () => {
  const day = 24 * 60 * 60 * 1000;
  type Retention = SafeConfig["retention"];
  const testConfig = createTestConfig();
  const safeConfig: SafeConfig = safeConfigSchema.parse(
    createSafeConfigView(
      testConfig,
      { version: 0, agents: [], skills: [] },
      resolveInstanceModules(testConfig, []).snapshot
    )
  );
  const retention: Retention = {
    ...safeConfig.retention,
    conversationDays: 30,
    expireConversations: true,
    extendOnActivity: true
  };
  // What an API from before the setting answers.
  const { extendOnActivity: _since, ...olderApiRetention } = retention;

  /** A thread with one message, as an open conversation has. */
  function OpenConversation({ children }: { children: ReactNode }) {
    const runtime = useLocalRuntime(
      {
        async run() {
          return { content: [] };
        }
      },
      { initialMessages: [{ role: "user", content: [{ type: "text", text: "First message" }] }] }
    );
    return createElement(AssistantRuntimeProvider, { runtime }, children);
  }

  /** The text of the line, or nothing when the thread shows none. */
  function lineOf(input: { retention: Retention; daysLeft: number }): string | undefined {
    const page = document.createElement("div");
    page.innerHTML = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" as const },
        createElement(
          OpenConversation,
          null,
          createElement(
            AssistantThread,
            threadProps({
              config: { ...safeConfig, retention: input.retention },
              retainedUntil: new Date(Date.now() + input.daysLeft * day).toISOString()
            })
          )
        )
      )
    );
    return (
      page.querySelector('[data-testid="conversation-retention-notice"]')?.textContent ?? undefined
    );
  }

  const promise = "A new message keeps this conversation.";

  it("promises a message keeps the conversation only where a message moves the date", () => {
    expect(lineOf({ retention, daysLeft: 3 })).toContain(promise);
    for (const dateOnly of [{ ...retention, extendOnActivity: false }, olderApiRetention]) {
      const line = lineOf({ retention: dateOnly, daysLeft: 3 });
      expect(line).toBeDefined();
      expect(line).not.toContain(promise);
    }
  });

  it("shows nothing where nothing is deleted for age, or outside the warning window", () => {
    expect(
      lineOf({ retention: { ...retention, expireConversations: false }, daysLeft: 3 })
    ).toBeUndefined();
    expect(lineOf({ retention, daysLeft: 7.5 })).toBeUndefined();
    expect(lineOf({ retention, daysLeft: 6.5 })).toBeDefined();
  });

  it("is gone after a message on an instance with a short period", () => {
    for (const conversationDays of [1, 7]) {
      const short = { ...retention, conversationDays };
      // A message has just moved the date a whole period ahead.
      expect(lineOf({ retention: short, daysLeft: conversationDays })).toBeUndefined();
      expect(
        lineOf({ retention: short, daysLeft: Math.min(7, conversationDays / 2) - 0.01 })
      ).toBeDefined();
    }
  });
});

/** A thread without a message: the screen for a new conversation. */
function EmptyConversation({ children }: { children: ReactNode }) {
  const runtime = useIdleRuntime();
  return createElement(AssistantRuntimeProvider, { runtime }, children);
}

describe("starters of a conversation about an asset", () => {
  const agentStarters = [{ skillName: "sheets", title: "Build a sheet", prompt: "Build a sheet." }];
  const agentPrompts = [{ title: "Check weather", prompt: "Check." }];

  /** The titles the start page offers, or nothing where it shows no starters. */
  function startersOf(kind: string): string[] | undefined {
    const start: ConversationStart = { about: "asset", kind, title: undefined };
    const page = document.createElement("div");
    page.innerHTML = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(
          EmptyConversation,
          null,
          createElement(ThreadStartBlock, {
            initialPrompts: agentPrompts,
            starters: agentStarters,
            start,
            onStarterChosen: noop
          })
        )
      )
    );
    const group = page.querySelector('[role="group"]');
    return group
      ? [...group.querySelectorAll("button")].map((button) => button.textContent ?? "")
      : undefined;
  }

  it("offers what a person changes on an App, in place of the agent's starters and prompts", () => {
    const offered = required(startersOf("app"));
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.join(" ")).not.toMatch(/Build a sheet|Check weather/u);
  });

  // ACCEPT-1c C6: the agent's own starters are written for a chat of its own, never for an asset.
  it("offers no agent starters for a kind without its own", () => {
    expect(startersOf("agent")).toBeUndefined();
  });
});

describe("chat attachment previews", () => {
  it("opens only a managed file, by the id it was attached with", () => {
    const part = toAttachmentFilePart({
      fileId: "file/with spaces",
      filename: "Input.pdf",
      mimeType: "application/pdf"
    });
    expect(part).toMatchObject({ type: "file", url: "vivd-file://file%2Fwith%20spaces" });
    expect(
      managedFileIdFromAttachmentContent([
        { type: "file", data: "vivd-file://file%2Fwith%20spaces", mimeType: "application/pdf" }
      ])
    ).toBe("file/with spaces");
    expect(
      managedFileIdFromAttachmentContent([
        { type: "file", data: "https://example.test/input.pdf", mimeType: "application/pdf" }
      ])
    ).toBeUndefined();
  });
});

// A .zip handed to the composer of a project's chat is unpacked into a folder of the project
// (projects spec, section 5); in a chat without a project it stays one attached file.
describe("a .zip in the composer", () => {
  const createdAt = "2026-10-28T09:00:00.000Z";
  const attachment = {
    id: "attachment_1",
    conversationId: "conv_1",
    fileId: "file_1",
    filename: "Angebote.zip",
    mimeType: "application/zip",
    byteSize: 7,
    status: "ready",
    artifactRefs: {},
    processingMetadata: {},
    warnings: [],
    createdAt,
    updatedAt: createdAt
  };
  const view = (maxFileBytes: number, taken: string[] = []) => ({
    items: taken.map((path) => ({
      path,
      version: 2,
      byteSize: 1,
      mimeType: "text/plain",
      origin: "upload",
      updatedAt: createdAt
    })),
    usage: { files: taken.length, bytes: taken.length },
    limits: { maxFiles: 50, maxFileBytes, maxProjectBytes: 1_000_000, versionsPerFile: 20 }
  });

  async function startChat(
    chat: { projectId?: string; maxFileBytes?: number; taken?: string[]; confirm?: boolean } = {}
  ) {
    const confirm = vi.fn(() => chat.confirm ?? true);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("window", Object.assign(globalThis.window ?? {}, { confirm }));
    const calls: string[] = [];
    const client = createApiClient({
      baseUrl: "https://chat.example.com",
      fetchImpl: async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(request instanceof Request ? request.url : String(request));
        const method = (request instanceof Request ? request.method : init?.method) ?? "GET";
        if (url.pathname.includes("/project-files/")) {
          if (method === "GET") {
            calls.push("list project files");
            return Response.json(view(chat.maxFileBytes ?? 1_000_000, chat.taken));
          }
          const path = url.searchParams.get("path") ?? "";
          const replaces = url.searchParams.get("replaces");
          calls.push(`project file ${path}${replaces ? ` replaces v${replaces}` : ""}`);
          return Response.json({ path, version: 1, change: "created" });
        }
        if (method === "POST") {
          const sent = init?.body instanceof FormData ? init.body.get("file") : null;
          const filename = sent instanceof File ? sent.name : "";
          calls.push(`attach ${filename}`);
          const taken = { ...attachment, filename };
          return Response.json({ attachment: taken, attachments: [taken], outcome: "created" });
        }
        return Response.json({ items: [] });
      }
    });
    const errors: string[] = [];
    let controller: ReturnType<typeof useDraftAttachmentController> | undefined;
    function Probe() {
      controller = useDraftAttachmentController({
        enabled: true,
        apiBaseUrl: "https://chat.example.com",
        authScope: "composer-zip-test",
        client,
        selectedConversationId: "conv_1",
        ...(chat.projectId ? { projectId: chat.projectId } : {}),
        collaborationWorkspaceId: "cw_1",
        isAuthenticated: true,
        createConversationForFiles: () => Promise.reject(new Error("no conversation is made")),
        showConversationForFiles: () => undefined,
        onError: (message) => errors.push(message)
      });
      return null;
    }
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          createElement(TranslationProvider, { locale: "de", children: createElement(Probe) })
        )
      );
    });
    const uploading = () =>
      (controller?.visibleUploadingAttachments ?? []).filter(
        (attachment) => attachment.status !== "unpacked"
      );
    return {
      calls,
      errors,
      confirm,
      /** Picks the files and waits until the composer has nothing left to upload. */
      choose: async (files: File[]) => {
        await act(async () => controller?.onFilesSelected(files));
        await vi.waitFor(() => expect(uploading()).toEqual([]));
      },
      /** The lines an unpacked .zip leaves where its upload chip was. */
      notes: () =>
        (controller?.visibleUploadingAttachments ?? []).flatMap((attachment) =>
          attachment.status === "unpacked" ? [attachment.note] : []
        )
    };
  }

  async function archive(
    name: string,
    entries: Record<string, string>,
    options: { declared?: number } = {}
  ): Promise<File> {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(entries)) {
      zip.file(path, content, { compression: "DEFLATE" });
    }
    const bytes = await zip.generateAsync({ type: "uint8array" });
    if (options.declared !== undefined) {
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let at = 0; at < bytes.length - 4; at += 1) {
        if (data.getUint32(at, true) === 0x04034b50)
          data.setUint32(at + 22, options.declared, true);
        if (data.getUint32(at, true) === 0x02014b50)
          data.setUint32(at + 24, options.declared, true);
      }
    }
    const copy = new ArrayBuffer(bytes.length);
    new Uint8Array(copy).set(bytes);
    return new File([copy], name, { type: "application/zip" });
  }

  it("lands as a folder of a project, beside the other files of the drop as attachments", async () => {
    const chat = await startChat({ projectId: "prj_1" });
    await chat.choose([
      await archive("Angebote.zip", { "a.md": "hello", "sub/b.csv": "1,2", ".DS_Store": "x" }),
      new File(["pdf"], "Perso.pdf", { type: "application/pdf" })
    ]);
    expect(chat.calls.sort()).toEqual([
      "attach Perso.pdf",
      "list project files",
      "project file Angebote/a.md",
      "project file Angebote/sub/b.csv"
    ]);
    expect(chat.errors).toEqual([]);
    // The upload chip gives way to a line that says where the files went, and holds no file.
    expect(chat.notes()).toHaveLength(1);
  });

  it("asks before it replaces files of the project, and keeps them when declined", async () => {
    const declined = await startChat({
      projectId: "prj_1",
      taken: ["Angebote/a.md"],
      confirm: false
    });
    await declined.choose([await archive("Angebote.zip", { "a.md": "hello" })]);
    expect(declined.confirm).toHaveBeenCalledOnce();
    expect(declined.calls).toEqual(["list project files"]);

    const agreed = await startChat({ projectId: "prj_1", taken: ["Angebote/a.md"] });
    await agreed.choose([await archive("Angebote.zip", { "a.md": "hello" })]);
    expect(agreed.calls).toEqual(["list project files", "project file Angebote/a.md replaces v2"]);
  });

  it("is stopped at the cap when its entries are larger than they declare, sending nothing", async () => {
    const chat = await startChat({ projectId: "prj_1", maxFileBytes: 100 });
    await chat.choose([
      await archive("Bombe.zip", { "a.txt": "x".repeat(50_000) }, { declared: 3 })
    ]);
    expect(chat.calls).toEqual(["list project files"]);
    expect(chat.errors).toHaveLength(1);
    expect(chat.errors[0]).toContain("a.txt");
  });

  it("is refused whole when an entry climbs out of its folder", async () => {
    const chat = await startChat({ projectId: "prj_1" });
    await chat.choose([await archive("Boese.zip", { "ok.txt": "ok", "../evil.txt": "bad" })]);
    expect(chat.calls).toEqual(["list project files"]);
    expect(chat.errors).toHaveLength(1);
    expect(chat.errors[0]).toContain("Boese.zip");
    expect(chat.notes()).toEqual([]);
  });

  it("is attached as one file, unopened, in a chat without a project", async () => {
    const chat = await startChat();
    await chat.choose([await archive("Angebote.zip", { "a.md": "hello" })]);
    expect(chat.calls).toEqual(["attach Angebote.zip"]);
  });
});
