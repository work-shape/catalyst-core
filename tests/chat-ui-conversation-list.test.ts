import { createElement } from "react";
import type { ConversationListItem, SafeConfig } from "@work-shape/catalyst-api-client";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { describe, expect, it } from "vitest";
import {
  railSections,
  recentConversations,
  shownRailSections,
  WorkspaceRail,
  type RailSection
} from "./support/chat-ui";
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

type RailProps = Parameters<typeof WorkspaceRail>[0];

function renderRail(
  conversations: ConversationListItem[] = [],
  overrides: Partial<RailProps> = {}
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" },
      createElement(WorkspaceRail, {
        config: railConfig,
        conversations,
        conversationsStatus: "ready",
        selectedConversationId: undefined,
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

describe("workspace rail sections", () => {
  it("shows a section that stands alone, and marks only the open conversation's row", () => {
    const inbox = { toDecide: 0 };
    const inboxSection = railSections.find((section) => section.id === "inbox");
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

    const conversations = many(2);
    expect(renderRail(conversations, { inbox })).not.toContain("aria-current");
    const inConversation = renderRail(conversations, { inbox, selectedConversationId: "conv_1" });
    expect(inConversation.match(/aria-current="true"/gu)).toHaveLength(1);
    expect(inConversation).toMatch(currentRow("Titel 1\\."));
  });
});

describe("workspace rail as the list of conversations", () => {
  const rows = (markup: string) => markup.match(/data-testid="conversation-row"/gu) ?? [];

  it("shows every loaded row and offers Load more only while there are older ones", () => {
    expect(renderRail(many(RAIL_PAGE_SIZE))).not.toContain("Load more");
    const more = { hasMoreConversations: true, onLoadMoreConversations: noop };
    const markup = renderRail(many(3 * RAIL_PAGE_SIZE), more);
    expect(rows(markup)).toHaveLength(3 * RAIL_PAGE_SIZE);
    expect(markup).toMatch(/<button[^>]*aria-busy="false"[^>]*>(?:(?!<\/button>).)*Load more/u);
  });

  it("holds the row still while a page loads, and keeps the rows with a retry after a failure", () => {
    const loading = renderRail(many(RAIL_PAGE_SIZE), {
      hasMoreConversations: true,
      loadingMoreConversations: true,
      onLoadMoreConversations: noop
    });
    expect(loading).toMatch(
      /<button[^>]*(?:disabled=""[^>]*aria-busy="true"|aria-busy="true"[^>]*disabled="")/u
    );

    const failed = renderRail(many(RAIL_PAGE_SIZE), {
      hasMoreConversations: true,
      loadMoreConversationsFailed: true,
      onLoadMoreConversations: noop
    });
    expect(rows(failed)).toHaveLength(RAIL_PAGE_SIZE);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("Load more");
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
  });
});
