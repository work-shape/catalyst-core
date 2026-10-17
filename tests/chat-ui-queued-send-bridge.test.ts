// @vitest-environment happy-dom

import { AssistantRuntimeProvider, useComposerRuntime, useLocalRuntime } from "@assistant-ui/react";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueuedSendBridge } from "./support/chat-ui";
import { required } from "./support/assertions";

const QUEUED = { text: "Keep this send", collaborationWorkspaceId: "ws_1", attachmentsKey: "" };

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

/**
 * Mounts the bridge with the queued draft in the composer and nothing queued yet. `queue`
 * then queues the send. `meanwhile` changes the composer after that render and before its
 * effects run, which is when a keystroke or the runtime can overtake React.
 */
function mountBridge(onSubmitMessage?: (text: string) => boolean) {
  let composer: ReturnType<typeof useComposerRuntime> | undefined;
  let settled = 0;
  function Bridge({ queued }: { queued: boolean }) {
    composer = useComposerRuntime();
    return createElement(QueuedSendBridge, {
      queuedSend: queued ? QUEUED : undefined,
      sendBlock: undefined,
      attachmentsKey: QUEUED.attachmentsKey,
      collaborationWorkspaceId: QUEUED.collaborationWorkspaceId,
      onSettled: () => {
        settled += 1;
      },
      onSubmitMessage
    });
  }
  function Harness({ queued, meanwhile }: { queued: boolean; meanwhile?: () => void }) {
    useLayoutEffect(() => {
      if (queued) meanwhile?.();
    }, [meanwhile, queued]);
    const runtime = useLocalRuntime({
      async run() {
        return { content: [] };
      }
    });
    return createElement(AssistantRuntimeProvider, { runtime }, createElement(Bridge, { queued }));
  }
  act(() => root?.render(createElement(Harness, { queued: false })));
  const live = required(composer);
  act(() => live.setText(QUEUED.text));
  return {
    composer: live,
    settled: () => settled,
    queue: (meanwhile: () => void) =>
      act(() => root?.render(createElement(Harness, { queued: true, meanwhile })))
  };
}

describe("a queued send decided before the composer's next render", () => {
  it("drops the queued message when the text was edited since the last render", () => {
    const submitted: string[] = [];
    const { composer, settled, queue } = mountBridge((text) => {
      submitted.push(text);
      return true;
    });
    // A keystroke changes the draft before React renders it.
    queue(() => composer.setText(`${QUEUED.text}, and more`));
    expect(submitted).toEqual([]);
    expect(settled()).toBe(1);
  });

  it("keeps waiting while the runtime would still ignore the send", () => {
    const { composer, settled, queue } = mountBridge();
    const readState = composer.getState.bind(composer);
    const send = vi.spyOn(composer, "send");
    // The runtime takes up a block after the render, which still said it could send.
    queue(() => {
      vi.spyOn(composer, "getState").mockImplementation(() => ({ ...readState(), canSend: false }));
    });
    expect(send).not.toHaveBeenCalled();
    expect(settled()).toBe(0);
  });
});
