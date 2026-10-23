// @vitest-environment happy-dom

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type AssistantRuntime
} from "@assistant-ui/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { required } from "./support/assertions";
import { stabilizeThreadListState, useCatalystChatRuntime } from "./support/chat-ui";

// chat.catalyst, 22 Oct 2026: one letter in the composer threw "Maximum update depth exceeded.
// The result of getSnapshot should be cached". The deployment's install gave assistant-ui
// tap 0.9.23, which re-reads every snapshot after each commit, and the thread list of core 0.2
// answers a new state object on each read. Core's lock runs tap 0.9.3, which forgives that, so
// the typing case passes here either way; the identity of the thread list state is what fails
// without the fix.

class StillResizeObserver {
  observe() {}
  disconnect() {}
}

type ChatTransport = NonNullable<
  NonNullable<Parameters<typeof useCatalystChatRuntime>[0]>["transport"]
>;

const transport: ChatTransport = {
  sendMessages: () => Promise.reject(new Error("This test sends nothing.")),
  reconnectToStream: () => Promise.resolve(null)
};

let root: Root | undefined;
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
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

async function mountComposer(): Promise<AssistantRuntime> {
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
    root?.render(createElement(Harness));
    await settle();
  });
  return required(runtime);
}

/** Lets the thread list's own initialisation finish. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function typeInto(input: HTMLTextAreaElement, text: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    required(setValue).call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  });
}

describe("chat runtime thread list state", () => {
  it("is the same object between reads while nothing in it changed", async () => {
    const runtime = await mountComposer();
    expect(runtime.threads.getState()).toBe(runtime.threads.getState());
  });

  it("is a new object once a field of the thread list changed", () => {
    const list = { mainThreadId: "first", threadIds: ["first"] as readonly string[] };
    const threads = { getState: () => ({ ...list }) };
    stabilizeThreadListState({ threads } as unknown as AssistantRuntime);
    const before = threads.getState();
    expect(threads.getState()).toBe(before);
    list.threadIds = ["first", "second"];
    const after = threads.getState();
    expect(after).not.toBe(before);
    expect(after.threadIds).toEqual(["first", "second"]);
    expect(threads.getState()).toBe(after);
  });
});

describe("composer typing", () => {
  it("takes one letter without a render loop", async () => {
    const runtime = await mountComposer();
    const input = required(container.querySelector("textarea"));
    await typeInto(input, "a");
    expect(renderErrors).toEqual([]);
    expect(runtime.thread.composer.getState().text).toBe("a");
    expect(input.value).toBe("a");
  });
});
