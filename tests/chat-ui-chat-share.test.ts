// @vitest-environment happy-dom

import {
  AssistantRuntimeProvider,
  useComposerRuntime,
  useLocalRuntime,
  type AssistantRuntime
} from "@assistant-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient, type Conversation } from "@work-shape/catalyst-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  AssistantComposer,
  ChatPeopleHead,
  ChatShareProvider,
  createTranslationContext,
  findMentionTrigger,
  insertMention,
  listNames,
  mentionsName,
  shareRefusal,
  turnSenders,
  withoutMentions
} from "./support/chat-ui";
import { TranslationProvider } from "./chat-ui-render-harness";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import { recordedApiClient } from "./support/recorded-api-client";

// CHAT-SHARE-2: the creator of a private chat picks people with @ in the composer, and Send
// shares the chat with them before the message goes. The head shows who reads the chat and
// opens the panel where the creator removes someone and a named person leaves.

describe("the @ of the composer", () => {
  it("opens at the start of the text and after a space or a line break", () => {
    expect(findMentionTrigger("@", 1)).toEqual({ at: 0, query: "" });
    expect(findMentionTrigger("Ask @an", 7)).toEqual({ at: 4, query: "an" });
    expect(findMentionTrigger("Line\n@b", 7)).toEqual({ at: 5, query: "b" });
  });

  it("never opens in an address, after a space following it, or in a code fence", () => {
    expect(findMentionTrigger("ada@example.com", 15)).toBeUndefined();
    expect(findMentionTrigger("@ ", 2)).toBeUndefined();
    expect(findMentionTrigger("@ada lovelace", 13)).toBeUndefined();
    expect(findMentionTrigger("```\n@ada", 8)).toBeUndefined();
    expect(findMentionTrigger("```\ncode\n```\n@ada", 17)).toEqual({ at: 13, query: "ada" });
  });

  it("puts the picked person in place of the search, with one space after", () => {
    expect(insertMention("Ask @ad please", { at: 4, query: "ad" }, 7, "Ada Lovelace")).toEqual({
      text: "Ask @Ada Lovelace please",
      caret: 18
    });
    expect(insertMention("@", { at: 0, query: "" }, 1, "Ada")).toEqual({
      text: "@Ada ",
      caret: 5
    });
  });

  it("reads what is left to send without the picked people", () => {
    expect(mentionsName("Hi @Ada Lovelace", "Ada Lovelace")).toBe(true);
    expect(withoutMentions(" @Ada  @Ben ", ["Ada", "Ben"])).toBe("");
    expect(withoutMentions("@Ada look at this", ["Ada"])).toBe("look at this");
  });
});

describe("the words of a share", () => {
  const { t } = createTranslationContext("en");

  it("lists names as a sentence does", () => {
    expect(listNames([], t)).toBe("");
    expect(listNames(["Ada"], t)).toBe("Ada");
    expect(listNames(["Ada", "Ben", "Cy"], t)).toBe("Ada, Ben and Cy");
  });

  it("words a refusal by its reason and keeps the instance's message for any other", () => {
    const refused = new ApiError(409, "Refused", {
      error: {
        code: "CONFLICT",
        message: "Refused",
        details: { reason: "conversation_in_project" }
      }
    });
    expect(shareRefusal(refused, t, "Ada")).toEqual({
      reason: "conversation_in_project",
      message: "This chat is in a project. Share the project instead."
    });
    expect(shareRefusal(new Error("Offline"), t)).toEqual({
      reason: undefined,
      message: "Offline"
    });
  });
});

describe("who sent each message", () => {
  it("names the person of each turn, and the one under way", () => {
    const senders = turnSenders(
      [{ inputMessageId: "msg_1", ownerUserId: "user-ada" }, { inputMessageId: "msg_2" }],
      "msg_3",
      "user-ben"
    );
    expect([...senders]).toEqual([
      ["msg_1", "user-ada"],
      ["msg_3", "user-ben"]
    ]);
  });
});

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

const creator = { id: "user-ada", label: "Ada Lovelace" };

function chat(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_1",
    title: "Quarter plan",
    clientInstanceId: "client",
    collaborationWorkspaceId: "cws_team",
    createdByUserId: creator.id,
    createdByExternalUserId: "external",
    visibility: "private",
    status: "active",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    retainedUntil: "2027-10-17T00:00:00.000Z",
    people: [],
    ...overrides
  };
}

/** The person a share names, as its body sends them. */
function personOf(body: string): string {
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === "object" && parsed !== null && "userId" in parsed
    ? String(parsed.userId)
    : "";
}

/** The instance as the share reads it: who it offers, and what it answers to a share or a removal. */
function shareClient(refuse?: string) {
  const recorded = recordedApiClient((call) => {
    switch (call.operation) {
      case "conversations.share_candidates":
        return {
          candidates: [
            {
              userId: "user-ben",
              displayLabel: "Ben Ito",
              email: "ben@example.com",
              hasAccess: false
            },
            { userId: "user-cy", displayLabel: "Cy Ota", hasAccess: true }
          ]
        };
      case "conversations.add_person":
        return refuse
          ? Response.json(
              { error: { code: "CONFLICT", message: "Refused", details: { reason: refuse } } },
              { status: 409 }
            )
          : chat({
              people: [
                { userId: "user-ben", displayLabel: "Ben Ito", addedAt: "2026-10-17T00:00:00.000Z" }
              ]
            });
      case "conversations.remove_person":
        return { conversationId: "conv_1", userId: call.params.userId, removed: true };
      case "me.chat_skills.list":
        return { items: [] };
      case "connections.mine":
        return { connections: [] };
      default:
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 }
        );
    }
  });
  /** What the share asked of the instance, without the reads of who it offers. */
  const changes = () =>
    recorded.calls.flatMap((call) =>
      call.operation === "conversations.add_person"
        ? [`share ${personOf(call.body)}`]
        : call.operation === "conversations.remove_person"
          ? [`remove ${call.params.userId}`]
          : []
    );
  return { client: recorded.client, calls: recorded.calls, changes };
}

function useIdleRuntime(sent: string[]): AssistantRuntime {
  return useLocalRuntime({
    async run({ messages }) {
      const last = messages.at(-1);
      const part = last?.content[0];
      sent.push(part && part.type === "text" ? part.text.trim() : "");
      return { content: [] };
    }
  });
}

function mount(input: {
  client: ApiClient;
  conversation: Conversation;
  viewer?: { id: string; label: string };
  onLeft?: () => void;
  children: ReactNode;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root?.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { children: null, locale: "en" },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(ChatShareProvider, {
              client: input.client,
              apiBaseUrl: "http://api.test",
              authScope: "workspace",
              viewer: input.viewer ?? creator,
              workspaceName: "Team",
              conversation: input.conversation,
              onLeft: input.onLeft ?? (() => undefined),
              children: input.children
            })
          )
        )
      )
    )
  );
}

type ComposerHandle = ReturnType<typeof useComposerRuntime>;

function Composer({
  sent,
  onComposer
}: {
  sent: string[];
  onComposer(composer: ComposerHandle): void;
}) {
  const runtime = useIdleRuntime(sent);
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(function Inner() {
      onComposer(useComposerRuntime());
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
        onQueueSend() {}
      });
    })
  );
}

async function until(check: () => boolean) {
  const deadline = Date.now() + CONDITION_WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("The condition did not come true in time");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/** Types into the composer as a person does: the text, then the caret at its end. */
async function type(composer: { setText(text: string): void }, text: string) {
  const input = required(container.querySelector("textarea"));
  act(() => input.focus());
  await act(async () => {
    composer.setText(text);
  });
  await act(async () => {
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "End", bubbles: true }));
  });
}

function key(name: string) {
  const input = required(container.querySelector("textarea"));
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })
    );
  });
}

describe("the composer of a private chat's creator", () => {
  it("offers people on @, picks one with Enter and shares before it sends", async () => {
    const { client, changes } = shareClient();
    const sent: string[] = [];
    let composer: ComposerHandle | undefined;
    mount({
      client,
      conversation: chat(),
      children: createElement(Composer, { sent, onComposer: (c) => (composer = c) })
    });

    await type(required(composer), "Please look @");
    await until(() => container.querySelectorAll('[role="option"]').length === 2);
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Ben Ito"),
      expect.stringContaining("has access")
    ]);
    expect(options[1]?.getAttribute("aria-disabled")).toBe("true");
    const input = required(container.querySelector("textarea"));
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

    key("Enter");
    await until(() => container.querySelector('[data-testid="share-chips"]') !== null);
    expect(required(composer).getState().text).toBe("Please look @Ben Ito ");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector('[data-testid="share-confirm-line"]')?.textContent).toContain(
      "Ben Ito will see the whole chat, files included, and can write in it."
    );

    const form = required(container.querySelector("form"));
    await act(async () => {
      form.requestSubmit();
    });
    await until(() => sent.length === 1);
    expect(changes()).toEqual(["share user-ben"]);
    expect(sent).toEqual(["Please look @Ben Ito"]);
    expect(container.querySelector('[data-testid="share-chips"]')).toBeNull();
  });

  it("sends nothing where the share is refused, and says why on the chip", async () => {
    const { client, changes } = shareClient("personal_conversation_private");
    const sent: string[] = [];
    let composer: ComposerHandle | undefined;
    mount({
      client,
      conversation: chat(),
      children: createElement(Composer, { sent, onComposer: (c) => (composer = c) })
    });
    await type(required(composer), "@be");
    await until(() => container.querySelectorAll('[role="option"]').length > 0);
    key("Enter");
    await until(() => container.querySelector('[data-testid="share-chips"]') !== null);
    await act(async () => {
      required(container.querySelector("form")).requestSubmit();
    });
    await until(() => container.querySelector('[data-testid="share-refusal"]') !== null);
    expect(changes()).toEqual(["share user-ben"]);
    expect(sent).toEqual([]);
    expect(container.querySelector('[data-testid="share-refusal"]')?.textContent).toContain(
      "It stays yours."
    );
  });

  it("closes the menu on Escape and leaves the @ as text", async () => {
    const { client } = shareClient();
    let composer: ComposerHandle | undefined;
    mount({
      client,
      conversation: chat(),
      children: createElement(Composer, { sent: [], onComposer: (c) => (composer = c) })
    });
    await type(required(composer), "@");
    await until(() => container.querySelector('[role="listbox"]') !== null);
    key("Escape");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(required(composer).getState().text).toBe("@");
  });

  it("opens no menu for a named person or in a team chat", async () => {
    const { client, calls, changes } = shareClient();
    let composer: ComposerHandle | undefined;
    mount({
      client,
      conversation: chat({ visibility: "workspace" }),
      children: createElement(Composer, { sent: [], onComposer: (c) => (composer = c) })
    });
    await type(required(composer), "@");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(calls).toEqual([]);
    expect(changes()).toEqual([]);
  });
});

describe("who reads the chat, in its head", () => {
  const shared = chat({
    people: [{ userId: "user-ben", displayLabel: "Ben Ito", addedAt: "2026-10-17T00:00:00.000Z" }],
    createdByDisplayLabel: creator.label
  });

  it("lets the creator remove a named person", async () => {
    const { client, changes } = shareClient();
    mount({ client, conversation: shared, children: createElement(ChatPeopleHead) });
    const people = required(
      container.querySelector<HTMLButtonElement>('[data-testid="chat-people"]')
    );
    expect(people.getAttribute("aria-label")).toBe("Who can see this chat: Ben Ito");
    act(() => people.click());
    await until(() => document.querySelector('[data-testid="chat-people-panel"]') !== null);
    const rows = [...document.querySelectorAll('[data-testid="chat-reader"]')];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Ada Lovelace (you)Started the chat"),
      expect.stringContaining("Ben ItoCan read and write")
    ]);
    const remove = required(
      document.querySelector<HTMLButtonElement>('button[aria-label="Remove Ben Ito"]')
    );
    await act(async () => remove.click());
    await until(() => changes().includes("remove user-ben"));
    expect(changes()).toEqual(["remove user-ben"]);
  });

  it("lets a named person leave, and goes elsewhere", async () => {
    const { client, changes } = shareClient();
    const onLeft = vi.fn();
    mount({
      client,
      conversation: shared,
      viewer: { id: "user-ben", label: "Ben Ito" },
      onLeft,
      children: createElement(ChatPeopleHead)
    });
    expect(container.querySelector('[data-testid="chat-share-button"]')).toBeNull();
    act(() =>
      required(container.querySelector<HTMLButtonElement>('[data-testid="chat-people"]')).click()
    );
    await until(() => document.querySelector('[data-testid="chat-people-panel"]') !== null);
    expect(document.querySelector('button[aria-label="Remove Ada Lovelace"]')).toBeNull();
    const leave = required(
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Leave"
      )
    );
    act(() => leave.click());
    const confirm = await (async () => {
      await until(() =>
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent === "Leave chat"
        )
      );
      return required(
        [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Leave chat"
        )
      );
    })();
    await act(async () => confirm.click());
    await until(() => onLeft.mock.calls.length === 1);
    expect(changes()).toEqual(["remove user-ben"]);
  });
});
