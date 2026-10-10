import { createElement } from "react";
import type { ConversationListItem, LocaleCode, SafeConfig } from "@vivd-catalyst/api-client";
import { safeConfigSchema } from "@vivd-catalyst/api-contract";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import { createSafeConfigView } from "@vivd-catalyst/config-schema";
import { describe, expect, it } from "vitest";
import {
  railSections,
  recentConversations,
  shownRailSections,
  WorkspaceRail,
  type RailSection
} from "../packages/chat-ui/src/workspace/workspace-rail";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { createTestConfig } from "./support/fixtures";

const noop = () => undefined;
/** As many conversations as the rail asks for at once (`RAIL_PAGE_SIZE`). */
const RAIL_PAGE_SIZE = 30;

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

  // Fails with the sections in a group of their own: a group's space then stood between New
  // chat and the Inbox, in the open rail and not in the strip.
  it("keeps New chat and the sections in one group, with or without a section and in the strip", () => {
    const [inboxSection] = railSections;
    if (!inboxSection) {
      throw new Error("The rail has no Inbox section.");
    }
    const second: RailSection = { ...inboxSection, id: "second", label: "nav.build" };
    const groupStarts = (markup: string, from: string, to: string) =>
      markup.slice(markup.indexOf(from), markup.indexOf(to)).match(/role="group"/gu) ?? [];

    for (const collapsed of [false, true]) {
      const several = renderRail(many(1), { inbox, collapsed, sections: [inboxSection, second] });
      expect(groupStarts(several, "New chat", "Inbox")).toHaveLength(0);
      expect(groupStarts(several, "Inbox", "Build")).toHaveLength(0);
    }
    // The next group is the list under "Recent", with or without a section before it.
    for (const markup of [renderRail(many(1), { inbox }), renderRail(many(1))]) {
      expect(groupStarts(markup, "New chat", "Recent")).toHaveLength(1);
      expect(markup).not.toContain("mt-4");
    }
  });

  it("marks nothing as current on the start page, and the open conversation's row in one", () => {
    const conversations = many(2);

    expect(renderRail(conversations, { inbox })).not.toContain("aria-current");
    const inConversation = renderRail(conversations, { inbox, selectedConversationId: "conv_1" });
    expect(inConversation.match(/aria-current="true"/gu)).toHaveLength(1);
    expect(inConversation).toMatch(currentRow("Titel 1\\."));
  });

  // Fails with the list page: the strip then held a "Conversations" icon that opened it.
  it("keeps New chat and the search in the collapsed strip, and no entry for a list page", () => {
    const markup = renderRail(many(1), { collapsed: true });

    expect(markup).toContain('<span class="sr-only">New chat</span>');
    expect(markup).not.toContain("lucide-messages-square");
    expect(markup).not.toContain("Conversations");
    expect(markup).not.toContain("aria-current");
  });
});

// Each of these fails with the "Show all" row: the rail then ended in a way to a list page,
// held one page, and put the open conversation after its rows.
describe("workspace rail as the list of conversations", () => {
  it("ends with its rows while the workspace holds no older conversations", () => {
    const markup = renderRail(many(RAIL_PAGE_SIZE));

    expect(markup.match(/data-testid="conversation-row"/gu)).toHaveLength(RAIL_PAGE_SIZE);
    expect(markup).not.toContain("Load more");
    expect(markup).not.toContain("Show all");
  });

  it("ends with a quiet Load more row while there are older ones, in both languages", () => {
    const more = { hasMoreConversations: true, onLoadMoreConversations: noop };
    const markup = renderRail(many(RAIL_PAGE_SIZE), more);

    // Every loaded row shows, however many pages they are.
    expect(
      renderRail(many(3 * RAIL_PAGE_SIZE), more).match(/data-testid="conversation-row"/gu)
    ).toHaveLength(3 * RAIL_PAGE_SIZE);
    expect(markup.lastIndexOf("Load more")).toBeGreaterThan(
      markup.lastIndexOf('data-testid="conversation-row"')
    );
    expect(markup).toMatch(/<button[^>]*aria-busy="false"[^>]*>(?:(?!<\/button>).)*Load more/u);
    expect(markup).not.toContain("Show all");
    expect(renderRail(many(RAIL_PAGE_SIZE), more, "de")).toContain("Mehr laden");
  });

  it("says that a page is loading, and holds the row still meanwhile", () => {
    const loading = {
      hasMoreConversations: true,
      loadingMoreConversations: true,
      onLoadMoreConversations: noop
    };
    const markup = renderRail(many(RAIL_PAGE_SIZE), loading);

    expect(markup).toMatch(
      /<button[^>]*(?:disabled=""[^>]*aria-busy="true"|aria-busy="true"[^>]*disabled="")[^>]*>(?:(?!<\/button>).)*Loading/u
    );
    expect(renderRail(many(RAIL_PAGE_SIZE), loading, "de")).toContain("Wird geladen");
  });

  it("keeps the rows and offers a retry after a page failed to load", () => {
    const failed = {
      hasMoreConversations: true,
      loadMoreConversationsFailed: true,
      onLoadMoreConversations: noop
    };
    const markup = renderRail(many(RAIL_PAGE_SIZE), failed);

    expect(markup.match(/data-testid="conversation-row"/gu)).toHaveLength(RAIL_PAGE_SIZE);
    expect(markup).toMatch(
      /role="alert"[^>]*>(?:(?!<\/div>).)*More conversations could not be loaded\./u
    );
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("Load more");
    expect(renderRail(many(RAIL_PAGE_SIZE), failed, "de")).toContain(
      "Weitere Unterhaltungen konnten nicht geladen werden."
    );
  });

  it("puts the open conversation first and marks it while it is older than the loaded ones", () => {
    const conversations = many(RAIL_PAGE_SIZE);
    const older = conversation("conv_old", "Mietvertrag Altbau", "2026-07-01T10:00:00.000Z");

    expect(recentConversations(conversations, conversations[2])).toBe(conversations);
    expect(recentConversations(conversations, undefined)).toBe(conversations);
    const shown = recentConversations(conversations, older);
    expect(shown).toHaveLength(RAIL_PAGE_SIZE + 1);
    expect(shown[0]?.id).toBe(older.id);

    const markup = renderRail(conversations, {
      openConversation: older,
      selectedConversationId: older.id,
      hasMoreConversations: true,
      onLoadMoreConversations: noop
    });
    expect(markup).toMatch(currentRow("Mietvertrag Altbau"));
    expect(markup.match(/aria-current="true"/gu)).toHaveLength(1);
    expect(markup.indexOf("Mietvertrag Altbau")).toBeLessThan(markup.indexOf("Titel 0."));
  });
});
