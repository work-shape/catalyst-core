import { createElement, type ComponentProps } from "react";
import type { AssetSummary, LocaleCode, SafeConfig } from "@vivd-catalyst/api-client";
import { safeConfigSchema } from "@vivd-catalyst/api-contract";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import { createSafeConfigView } from "@vivd-catalyst/config-schema";
import { describe, expect, it } from "vitest";
import {
  parseAppOpens,
  railApps,
  RAIL_APPS_LIMIT,
  withAppOpen,
  WorkspaceRail
} from "@vivd-catalyst/chat-ui/apps";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { createTestConfig } from "./support/fixtures";

// The published Apps under the Apps row of the rail: which ones, in which order, and where the
// rail shows none. Every test here fails without the list.

const noop = () => undefined;

const testConfig = createTestConfig();
const railConfig: SafeConfig = safeConfigSchema.parse(
  createSafeConfigView(
    testConfig,
    { version: 0, agents: [], skills: [] },
    resolveInstanceModules(testConfig, []).snapshot
  )
);

function renderRail(
  overrides: Partial<ComponentProps<typeof WorkspaceRail>> = {},
  locale: LocaleCode = "en"
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(WorkspaceRail, {
        config: railConfig,
        conversations: [],
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

function summary(name: string, overrides: Partial<AssetSummary> = {}): AssetSummary {
  return {
    id: `asset_${name}`,
    kind: "app",
    name,
    title: name,
    scope: { kind: "workspace", workspaceId: "cw_shared" },
    revision: 2,
    draftRevision: 2,
    publishedRevision: 1,
    updatedAt: "2026-10-10T12:00:00.000Z",
    ...overrides
  };
}

describe("published Apps for the rail", () => {
  it("lists published Apps only, the last opened first and the rest by their latest change", () => {
    const rows = [
      summary("alt", { title: "Alt", updatedAt: "2026-10-01T12:00:00.000Z" }),
      summary("entwurf", { publishedRevision: undefined }),
      summary("neu", { title: " ", updatedAt: "2026-10-12T12:00:00.000Z" }),
      summary("mittel", { title: "Mittel", updatedAt: "2026-10-05T12:00:00.000Z" })
    ];

    expect(railApps(rows, {})).toEqual([
      // An App without a title is named by its id.
      { name: "neu", title: "neu" },
      { name: "mittel", title: "Mittel" },
      { name: "alt", title: "Alt" }
    ]);
    expect(railApps(rows, { alt: 20, mittel: 10 }).map(({ name }) => name)).toEqual([
      "alt",
      "mittel",
      "neu"
    ]);
    // An App that is gone, or that only has a draft, is not brought back by an old open.
    expect(railApps(rows, { entwurf: 50, weg: 60 }).map(({ name }) => name)).toEqual([
      "neu",
      "mittel",
      "alt"
    ]);
  });

  it("never lists more than its bound, and nothing before the list has arrived", () => {
    const rows = Array.from({ length: RAIL_APPS_LIMIT + 3 }, (_, index) => summary(`app-${index}`));

    expect(railApps(rows, {})).toHaveLength(RAIL_APPS_LIMIT);
    // The App opened last is among them wherever it stood.
    expect(railApps(rows, { "app-7": 5 })[0]?.name).toBe("app-7");
    expect(railApps(undefined, {})).toEqual([]);
    expect(railApps([], {})).toEqual([]);
  });

  it("reads what the browser kept as opens and takes anything else as nothing", () => {
    expect(parseAppOpens(JSON.stringify({ a: 3, b: "x", c: null }))).toEqual({ a: 3 });
    expect(parseAppOpens(null)).toEqual({});
    expect(parseAppOpens("not json")).toEqual({});
    expect(parseAppOpens("[1,2]")).toEqual({});
    expect(withAppOpen({ a: 3 }, "b", 9)).toEqual({ a: 3, b: 9 });
    expect(withAppOpen({ a: 3 }, undefined, 9)).toEqual({ a: 3 });
  });
});

describe("workspace rail published Apps", () => {
  const published = [
    { name: "fee-estimate", title: "Fee estimate" },
    { name: "customer-list", title: "Customer list" }
  ];

  it("lists them under the Apps row and before Recent, in the order given", () => {
    const markup = renderRail({
      inbox: { toDecide: 0 },
      apps: true,
      publishedApps: published
    });

    expect(markup).toMatch(/role="group"[^>]*aria-label="Published apps"/u);
    const order = ["lucide-layout-grid", "Fee estimate", "Customer list", "lucide-inbox", "Recent"];
    const positions = order.map((part) => markup.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(renderRail({ apps: true, publishedApps: published }, "de")).toContain(
      'aria-label="Veröffentlichte Apps"'
    );
  });

  it("shows the Apps row alone for a person without an App, and no block without the module", () => {
    const none = renderRail({ apps: true, publishedApps: [] });
    expect(none).toContain("lucide-layout-grid");
    expect(none).not.toContain("rail-apps");

    const moduleOff = renderRail({ publishedApps: published });
    expect(moduleOff).not.toContain("lucide-layout-grid");
    expect(moduleOff).not.toContain("rail-apps");
    expect(moduleOff).not.toContain("Fee estimate");
  });

  it("shows nothing more in the collapsed strip", () => {
    const markup = renderRail({
      apps: true,
      publishedApps: published,
      collapsed: true
    });

    expect(markup).toContain("lucide-layout-grid");
    expect(markup).not.toContain("rail-apps");
    expect(markup).not.toContain("Fee estimate");
  });

  it("marks the open App as the current row in place of the Apps row", () => {
    const onList = renderRail({
      apps: true,
      publishedApps: published,
      view: "apps"
    });
    expect(onList.match(/aria-current="true"/gu)).toHaveLength(1);
    expect(onList).toMatch(/<button[^>]*aria-current="true"[^>]*>(?:(?!<\/button>).)*Apps/u);

    const inApp = renderRail({
      apps: true,
      publishedApps: published,
      openAppName: "customer-list",
      view: "apps"
    });
    expect(inApp.match(/aria-current="true"/gu)).toHaveLength(1);
    expect(inApp).toMatch(
      /<button[^>]*aria-current="true"[^>]*>(?:(?!<\/button>).)*Customer list/u
    );

    // An App that is open and not listed leaves the Apps row the current one.
    const unlisted = renderRail({
      apps: true,
      publishedApps: published,
      openAppName: "other",
      view: "apps"
    });
    expect(unlisted).toMatch(/<button[^>]*aria-current="true"[^>]*>(?:(?!<\/button>).)*Apps/u);
  });
});
