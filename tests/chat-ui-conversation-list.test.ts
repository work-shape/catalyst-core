import { createElement } from "react";
import type { ConversationListItem, LocaleCode, SafeConfig } from "@vivd-catalyst/api-client";
import { safeConfigSchema } from "@vivd-catalyst/api-contract";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import { createSafeConfigView } from "@vivd-catalyst/config-schema";
import { describe, expect, it } from "vitest";
import {
  ConversationListView,
  formatLastActivity,
  type ConversationListState
} from "../packages/chat-ui/src/conversation/conversation-list-area";
import {
  RAIL_RECENT_LIMIT,
  railSections,
  recentConversations,
  shownRailSections,
  WorkspaceRail,
  type RailSection
} from "../packages/chat-ui/src/workspace/workspace-rail";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { createTestConfig } from "./support/fixtures";

const noop = () => undefined;
const now = new Date("2026-08-03T10:00:00.000Z");

function conversation(
  id: string,
  title: string,
  updatedAt: string,
  visibility: ConversationListItem["visibility"] = "workspace"
): ConversationListItem {
  return {
    id,
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_shared",
    createdByUserId: "user_1",
    createdByExternalUserId: "external_1",
    visibility,
    title,
    status: "active",
    createdAt: updatedAt,
    updatedAt,
    retainedUntil: "2027-08-01T10:00:00.000Z"
  };
}

function ready(
  conversations: ConversationListItem[],
  overrides: Partial<Extract<ConversationListState, { status: "ready" }>> = {}
): ConversationListState {
  return {
    status: "ready",
    conversations,
    searched: "",
    hasMore: false,
    loadingMore: false,
    moreFailed: false,
    onShowMore: noop,
    ...overrides
  };
}

function renderList(
  state: ConversationListState,
  locale: LocaleCode = "en",
  overrides: Partial<Parameters<typeof ConversationListView>[0]> = {}
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(ConversationListView, {
        state,
        query: "",
        deleting: false,
        now,
        onQueryChange: noop,
        onOpen: noop,
        onNewChat: noop,
        onRename: async () => undefined,
        onDelete: noop,
        ...overrides
      })
    )
  );
}

// Every test here fails without the list of every conversation: there was no such page.
describe("conversation list page", () => {
  const rows = [
    conversation("conv_new", "Angebot Q3", "2026-08-03T08:00:00.000Z"),
    conversation("conv_old", "Mietvertrag", "2026-07-20T10:00:00.000Z", "private")
  ];

  it("names the page and its search field in both languages", () => {
    const english = renderList(ready(rows));
    const german = renderList(ready(rows), "de");

    expect(english).toMatch(/<h1[^>]*>Conversations<\/h1>/u);
    expect(english).toMatch(/<input[^>]*type="search"[^>]*aria-label="Search conversations"/u);
    expect(german).toMatch(/<h1[^>]*>Unterhaltungen<\/h1>/u);
    expect(german).toMatch(/<input[^>]*aria-label="Unterhaltungen durchsuchen"/u);
  });

  it("shows each conversation as a row that opens it, with its last activity and its menu", () => {
    const markup = renderList(ready(rows));

    expect(markup.match(/data-testid="conversation-list-row"/gu)).toHaveLength(2);
    expect(markup.indexOf("Angebot Q3")).toBeLessThan(markup.indexOf("Mietvertrag"));
    expect(markup).toMatch(/<time dateTime="2026-08-03T08:00:00.000Z">2 hr\. ago<\/time>/u);
    // After a week the row says the day, and the year once it is another one.
    expect(markup).toMatch(/<time dateTime="2026-07-20T10:00:00.000Z">Jul 20<\/time>/u);
    expect(formatLastActivity("2025-03-04T10:00:00.000Z", "de", now)).toBe("4. März 2025");
    expect(markup).toContain('aria-label="Conversation options for Angebot Q3"');
    expect(markup).toContain('aria-label="Private, only you can open it"');
    // The row is a button, so the keyboard reaches and opens it.
    expect(markup).toMatch(/<button type="button"[^>]*>(?:(?!<\/button>).)*Angebot Q3/u);
  });

  it("offers the older rows only while the server has more", () => {
    expect(renderList(ready(rows))).not.toContain("Show more");
    expect(renderList(ready(rows, { hasMore: true }))).toContain("Show more");
    expect(renderList(ready(rows, { hasMore: true }), "de")).toContain("Mehr anzeigen");

    const failed = renderList(ready(rows, { hasMore: true, moreFailed: true }));
    expect(failed).toContain("More conversations could not be loaded.");
    expect(failed).toContain("Try again");
    // The rows that had arrived stay.
    expect(failed).toContain("Angebot Q3");
  });

  it("says that a workspace has no conversations and offers New chat", () => {
    const markup = renderList(ready([]));

    expect(markup).toContain('data-testid="conversation-list-empty"');
    expect(markup).toContain("No conversations yet.");
    expect(markup).toContain("New chat");
    expect(renderList(ready([]), "de")).toContain("Noch keine Unterhaltungen.");
  });

  it("names the searched text and the workspace when nothing matches", () => {
    const markup = renderList(ready([], { searched: "Steuer" }), "en", {
      workspaceName: { kind: "shared", name: "Kai Spezis" }
    });

    expect(markup).toContain('data-testid="conversation-list-no-match"');
    expect(markup).toContain("No results for &quot;Steuer&quot; in Kai Spezis.");
    expect(markup).not.toContain("New chat");
  });

  it("says that the list failed, in words, and offers to load it again", () => {
    const markup = renderList({ status: "failed", onRetry: noop });

    expect(markup).toMatch(/role="alert"[^>]*>Conversations could not be loaded\./u);
    expect(markup).toContain("Try again");
    expect(renderList({ status: "failed", onRetry: noop }, "de")).toContain(
      "Unterhaltungen konnten nicht geladen werden."
    );
  });

  it("shows placeholder rows while the first page is on its way", () => {
    const markup = renderList({ status: "loading" });

    expect(markup).toContain('data-testid="conversation-list-loading"');
    expect(markup).not.toContain("No conversations yet.");
  });

  it("reports a change that went wrong above the rows", () => {
    expect(renderList(ready(rows), "en", { notice: "Delete failed" })).toMatch(
      /role="alert"[^>]*>Delete failed/u
    );
  });
});

const testConfig = createTestConfig();
const railConfig: SafeConfig = safeConfigSchema.parse(
  createSafeConfigView(
    testConfig,
    { version: 0, agents: [], skills: [] },
    resolveInstanceModules(testConfig).snapshot
  )
);

type RailProps = Parameters<typeof WorkspaceRail>[0];

function renderRail(
  conversations: ConversationListItem[] = [],
  overrides: Partial<RailProps> = {},
  locale: LocaleCode = "en"
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(WorkspaceRail, {
        config: railConfig,
        conversations,
        conversationsStatus: "ready",
        selectedConversationId: undefined,
        canViewAdministration: false,
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
        onShowAllConversations: noop,
        onSelectConversation: noop,
        onReloadConversations: noop,
        onRenameConversation: async () => undefined,
        onMoveConversation: noop,
        onDeleteConversation: noop,
        ...overrides
      })
    )
  );
}

const many = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    conversation(`conv_${index}`, `Titel ${index}.`, "2026-08-01T10:00:00.000Z")
  );
const currentRow = (label: string) =>
  new RegExp(`<button[^>]*aria-current="true"[^>]*>(?:(?!</button>).)*${label}`, "u");

// Each of these fails with the Chat row: the rail then offered "Chat" beside "New chat", and
// hid a section that stood alone.
describe("workspace rail without a Chat row", () => {
  const inbox = { toDecide: 0 };

  it("has no Chat row: New chat is the one entry for a chat", () => {
    expect(railSections.map((section) => section.id)).toEqual(["inbox"]);

    for (const markup of [renderRail(), renderRail([], { inbox })]) {
      expect(markup).not.toContain(">Chat<");
      expect(markup).not.toMatch(/lucide-message-square[ "]/u);
      expect(markup.match(/New chat/gu)).toHaveLength(1);
    }
  });

  it("shows a section that stands alone, and every registered one in its order", () => {
    const [inboxSection] = railSections;
    if (!inboxSection) {
      throw new Error("The rail has no Inbox section.");
    }
    const second: RailSection = {
      ...inboxSection,
      id: "second",
      label: "nav.settings",
      shown: undefined
    };

    expect(shownRailSections(railSections, { inbox })).toEqual([inboxSection]);
    expect(shownRailSections([inboxSection, second])).toEqual([second]);
    const markup = renderRail([], { inbox, sections: [inboxSection, second] });
    expect(markup.indexOf("Inbox")).toBeLessThan(markup.indexOf("Settings"));
  });

  it("marks nothing as current on the start page, and the open conversation's row in one", () => {
    const conversations = many(2);

    expect(renderRail(conversations, { inbox })).not.toContain("aria-current");
    const inConversation = renderRail(conversations, { inbox, selectedConversationId: "conv_1" });
    expect(inConversation.match(/aria-current="true"/gu)).toHaveLength(1);
    expect(inConversation).toMatch(currentRow("Titel 1\\."));
  });

  it("gives the collapsed strip a way to the conversations, which it marks on their list", () => {
    const markup = renderRail(many(1), { collapsed: true, view: "conversations" });

    expect(markup).toContain('<span class="sr-only">Conversations</span>');
    expect(markup.match(/aria-current="true"/gu)).toHaveLength(1);
    expect(markup.indexOf("lucide-square-pen")).toBeLessThan(
      markup.indexOf("lucide-messages-square")
    );
    expect(renderRail(many(1), { collapsed: true }, "de")).toContain(
      '<span class="sr-only">Unterhaltungen</span>'
    );
  });
});

// Each of these fails without the cap: the rail listed every conversation and had no such row.
describe("workspace rail Show all", () => {
  it("is absent while the rail shows every conversation there is", () => {
    const markup = renderRail(many(RAIL_RECENT_LIMIT));

    expect(markup.match(/data-testid="conversation-row"/gu)).toHaveLength(RAIL_RECENT_LIMIT);
    expect(markup).not.toContain("Show all");
  });

  it("ends the list once there are more conversations than the rail shows", () => {
    const markup = renderRail(many(RAIL_RECENT_LIMIT + 1));

    expect(markup.match(/data-testid="conversation-row"/gu)).toHaveLength(RAIL_RECENT_LIMIT);
    expect(markup).not.toContain(`Titel ${RAIL_RECENT_LIMIT}.`);
    expect(markup.lastIndexOf("Show all")).toBeGreaterThan(
      markup.lastIndexOf('data-testid="conversation-row"')
    );
    expect(renderRail(many(RAIL_RECENT_LIMIT + 1), {}, "de")).toContain("Alle anzeigen");
  });

  it("is the current row on the list of every conversation", () => {
    const markup = renderRail(many(RAIL_RECENT_LIMIT + 1), { view: "conversations" });

    expect(markup).toMatch(currentRow("Show all"));
    expect(markup.match(/aria-current="true"/gu)).toHaveLength(1);
  });

  // Fails without the change: the rail looked for the open conversation in a list of every
  // conversation, which it no longer loads, and took an id instead of the conversation.
  it("keeps the open conversation in the rail when it is an older one", () => {
    // What the rail is given: the latest conversations and one more.
    const conversations = many(RAIL_RECENT_LIMIT + 1);
    const older = conversation("conv_old", "Mietvertrag Altbau", "2026-07-01T10:00:00.000Z");

    expect(recentConversations(conversations, conversations[2])).toHaveLength(RAIL_RECENT_LIMIT);
    expect(recentConversations(conversations, undefined)).toHaveLength(RAIL_RECENT_LIMIT);
    const shown = recentConversations(conversations, older);
    expect(shown).toHaveLength(RAIL_RECENT_LIMIT + 1);
    expect(shown.at(-1)?.id).toBe(older.id);

    const markup = renderRail(conversations, {
      openConversation: older,
      selectedConversationId: older.id
    });
    expect(markup).toMatch(currentRow("Mietvertrag Altbau"));
    expect(markup.match(/aria-current="true"/gu)).toHaveLength(1);
    // The open conversation stands after the latest ones and before the way to all of them.
    expect(markup.indexOf("Mietvertrag Altbau")).toBeGreaterThan(
      markup.indexOf(`Titel ${RAIL_RECENT_LIMIT - 1}.`)
    );
    expect(markup.indexOf("Mietvertrag Altbau")).toBeLessThan(markup.lastIndexOf("Show all"));
  });
});
