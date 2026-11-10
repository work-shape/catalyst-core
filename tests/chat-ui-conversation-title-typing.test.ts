// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationListItem, SafeConfig } from "@work-shape/catalyst-api-client";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { required } from "./support/assertions";
import { WorkspaceRail } from "./support/chat-ui";
import { TranslationProvider } from "./chat-ui-render-harness";
import { createTestConfig } from "./support/fixtures";

// A title the rail's row did not get from the person in front of it is typed in: the title the
// server generates for a new conversation, and the one an agent gives with
// `platform.conversations.rename`. Both reach the row the same way, as another title of the
// listed conversation. A title the person typed into the row stands at once. Fails without the
// change: every title stood at once.

const noop = () => undefined;
const STEP_MS = 24;

class StillResizeObserver {
  observe() {}
  disconnect() {}
}

function conversation(title: string): ConversationListItem {
  return {
    id: "conv_1",
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_shared",
    createdByUserId: "user_1",
    createdByExternalUserId: "external_1",
    visibility: "workspace",
    title,
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    retainedUntil: "2027-08-01T10:00:00.000Z",
    people: []
  };
}

const testConfig = createTestConfig();
const railConfig: SafeConfig = safeConfigSchema.parse(
  createSafeConfigView(
    testConfig,
    { version: 0, agents: [], skills: [] },
    resolveInstanceModules(testConfig, []).snapshot
  )
);

function typeInto(field: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the title of a conversation in the rail", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let renamedTo: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", StillResizeObserver);
    renamedTo = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The rail with the one conversation, open, under the title the list reports for it. */
  const showRail = (title: string) =>
    act(() =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { children: null, locale: "en" },
            createElement(WorkspaceRail, {
              config: railConfig,
              conversations: [conversation(title)],
              conversationsStatus: "ready",
              selectedConversationId: "conv_1",
              view: "chat",
              deletingConversation: false,
              canMoveConversation: false,
              accountMenu: null,
              collapsed: false,
              drawerOpen: false,
              onDrawerClose: noop,
              onToggleCollapsed: noop,
              onOpenSearch: noop,
              onViewChange: noop,
              onCreateConversation: noop,
              onSelectConversation: noop,
              onReloadConversations: noop,
              onRenameConversation: (_id: string, next: string) => {
                renamedTo.push(next);
                return Promise.resolve();
              },
              onMoveConversation: noop,
              onDeleteConversation: noop
            })
          )
        )
      )
    );
  const title = () =>
    required(container.querySelector<HTMLElement>('[data-testid="conversation-row"] [title]'));
  const typing = () => title().hasAttribute("data-typing");
  const finishTyping = () => {
    for (let step = 0; step < 60 && typing(); step += 1) {
      act(() => {
        vi.advanceTimersByTime(STEP_MS);
      });
    }
  };

  it("types in the title the server generates and the one an agent gives", () => {
    showRail("Which offers came in this week");
    expect(typing()).toBe(false);

    // The title job replaced the first line of the message.
    showRail("Offers of the week");
    expect(typing()).toBe(true);
    expect(title().getAttribute("title")).toBe("Offers of the week");
    expect(title().textContent).toBe("Offers of the week");
    act(() => {
      vi.advanceTimersByTime(STEP_MS);
    });
    expect(title().firstChild?.nodeValue).toBe("O");
    finishTyping();
    expect(title().outerHTML).toContain(">Offers of the week</span>");

    // The agent renamed the chat: the list reports the new title after the tool's call.
    showRail("Roof renovation");
    expect(typing()).toBe(true);
    finishTyping();
    expect(title().textContent).toBe("Roof renovation");
  });

  it("shows a title the person typed into the row at once, and types in the next one from elsewhere", async () => {
    showRail("Offers of the week");

    // A click on the open conversation's title edits it in place.
    act(() => title().click());
    const field = required(container.querySelector<HTMLInputElement>('input[type="text"]'));
    act(() => typeInto(field, "My offers"));
    await act(async () => {
      required(field.form).requestSubmit();
      await Promise.resolve();
    });
    expect(renamedTo).toEqual(["My offers"]);

    showRail("My offers");
    expect(typing()).toBe(false);
    expect(title().textContent).toBe("My offers");

    showRail("Roof renovation");
    expect(typing()).toBe(true);
  });

  it("does not type the placeholder of a conversation without a first line", () => {
    showRail("Offers of the week");
    showRail("New conversation");

    expect(typing()).toBe(false);
    expect(title().textContent).toBe("New conversation");
  });
});
