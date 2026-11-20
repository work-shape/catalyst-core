// @vitest-environment happy-dom

import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { AssistantThread, newConversationPrivacy } from "./support/chat-ui";
import { TranslationProvider } from "./chat-ui-render-harness";

// ACCEPT-FIX-11 E3: "Continue privately" after a build refused in a conversation others read
// opens the workspace's start page with the request in the composer, and the first send makes
// the conversation private. That start page looked like any new chat of the shared workspace:
// nothing said the conversation would be private, so the press read as "nothing happened".

const sharedWorkspace = { kind: "shared", defaultConversationVisibility: "workspace" };
const startPage = {
  conversationOpen: false,
  projectStart: false,
  docked: false,
  workspace: sharedWorkspace
};

describe("the start page after Continue privately", () => {
  it("says the conversation is private where the person went on privately", () => {
    expect(newConversationPrivacy({ ...startPage, startsPrivate: true })).toBe("continued");
    // A new chat of the shared workspace says nothing: its conversations are read by members.
    expect(newConversationPrivacy({ ...startPage, startsPrivate: false })).toBeUndefined();
    // A workspace that starts conversations private says so without the press as well.
    expect(
      newConversationPrivacy({
        ...startPage,
        startsPrivate: false,
        workspace: { kind: "shared", defaultConversationVisibility: "private" }
      })
    ).toBe("workspace");
  });

  it("says nothing where the first send would not make it private", () => {
    // An open conversation, a project's chat start and the dock keep their own audience.
    for (const place of [{ conversationOpen: true }, { projectStart: true }, { docked: true }]) {
      expect(
        newConversationPrivacy({ ...startPage, ...place, startsPrivate: true })
      ).toBeUndefined();
    }
  });
});

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

function Thread({ privacy }: { privacy: "continued" | "workspace" | undefined }) {
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
      newConversationPrivate: privacy,
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

async function show(
  locale: "en" | "de",
  privacy: "continued" | "workspace" | undefined
): Promise<string | undefined> {
  await act(async () => {
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { children: null, locale },
          createElement(Thread, { privacy })
        )
      )
    );
    await Promise.resolve();
  });
  return (
    container.querySelector("[data-testid=new-conversation-private-hint]")?.textContent ?? undefined
  );
}

describe("the private line above the composer", () => {
  it("tells the person who went on privately that only they see the conversation", async () => {
    expect(await show("de", "continued")).toBe(
      "Privat: Nur du siehst diese Unterhaltung, deshalb kann der Agent hier bauen."
    );
    expect(await show("en", "continued")).toBe(
      "Private: only you see this conversation, so the agent can build here."
    );
    expect(await show("en", "workspace")).toBe(
      "New conversations in this workspace are private to you."
    );
    expect(await show("en", undefined)).toBeUndefined();
  });
});
