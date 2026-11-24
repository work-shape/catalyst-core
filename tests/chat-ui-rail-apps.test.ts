// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AssetSummary,
  ConversationListItem,
  SafeConfig
} from "@work-shape/catalyst-api-client";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  parseAppOpens,
  parseRailAppsOpen,
  railApps,
  railAppsShown,
  RAIL_APPS_LIMIT,
  withAppOpen,
  WorkspaceRail
} from "@work-shape/catalyst-chat-ui/apps";
import { parseRailProjectsOpen, railProjectsToggled, useRailProjectsOpen } from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { createTestConfig } from "./support/fixtures";

// The published Apps under the Apps row of the rail: which ones, in which order, where the rail
// shows none, and the caret that folds them. Felix, 2026-10-19: "either design them nicer and
// collapsible or leave them out for now". They stand folded until the person opens them, the
// choice is kept in the browser, and the App on screen opens the fold. Each project of the rail
// folds the same way on its own (Felix, 2026-11-04).

const noop = () => undefined;

const testConfig = createTestConfig();
const railConfig: SafeConfig = safeConfigSchema.parse(
  createSafeConfigView(
    testConfig,
    { version: 0, agents: [], skills: [] },
    resolveInstanceModules(testConfig, []).snapshot
  )
);

type RailProps = ComponentProps<typeof WorkspaceRail>;

function rail(overrides: Partial<RailProps> = {}) {
  return createElement(
    TranslationProvider,
    { children: null, locale: "en" },
    createElement(WorkspaceRail, {
      config: railConfig,
      conversations: [],
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
  );
}

function renderRail(overrides: Partial<RailProps> = {}): string {
  return renderToStaticMarkup(rail(overrides));
}

const FOLD_KEY = "vivd-catalyst:rail-apps-open";

beforeEach(() => window.localStorage.clear());

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

  it("shows the Apps used last alphabetically, so opening one never moves it", () => {
    const rows = ["Zebra", "Äpfel", "Mitte", "beta", "Omega", "Alt", "Eins"].map((title) =>
      summary(title.toLowerCase(), { title })
    );
    const shown = (opens: Record<string, number>) =>
      railAppsShown(railApps(rows, opens)).map(({ title }) => title);

    // Five of seven: the ones opened last, in German alphabetical order ("Äpfel" with "A").
    const opens = { zebra: 7, äpfel: 6, mitte: 5, beta: 4, omega: 3 };
    expect(shown(opens)).toEqual(["Äpfel", "beta", "Mitte", "Omega", "Zebra"]);
    // Opening one of them puts it first in the order of use and leaves the display as it was.
    expect(shown({ ...opens, omega: 99 })).toEqual(["Äpfel", "beta", "Mitte", "Omega", "Zebra"]);
    // Opening one that was not shown brings it in, at its alphabetical place.
    expect(shown({ ...opens, alt: 99 })).toEqual(["Alt", "Äpfel", "beta", "Mitte", "Zebra"]);
  });

  it("reads what the browser kept and takes anything else as nothing", () => {
    expect(parseAppOpens(JSON.stringify({ a: 3, b: "x", c: null }))).toEqual({ a: 3 });
    expect(parseAppOpens("not json")).toEqual({});
    expect(withAppOpen({ a: 3 }, "b", 9)).toEqual({ a: 3, b: 9 });
    expect(parseRailAppsOpen("open")).toBe(true);
    expect(parseRailAppsOpen("true")).toBe(false);
  });
});

const published = [
  { name: "fee-estimate", title: "Fee estimate" },
  { name: "customer-list", title: "Customer list" }
];

const many = Array.from({ length: RAIL_APPS_LIMIT + 2 }, (_, index) => ({
  name: `app-${index}`,
  title: `App ${index}`
}));

function itemsIn(markup: string): string[] {
  const group = /data-testid="rail-apps"[^>]*>(.*?)<\/div>/su.exec(markup)?.[1] ?? "";
  return [...group.matchAll(/<button[^>]*title="([^"]*)"/gu)].map((match) => match[1] ?? "");
}

describe("workspace rail published Apps", () => {
  it("shows the Apps row alone for a person without an App, and no block without the module", () => {
    const none = renderRail({ apps: true, publishedApps: [], openAppName: "fee-estimate" });
    expect(none).toContain("lucide-layout-grid");
    expect(none).not.toContain("rail-apps");

    const moduleOff = renderRail({ publishedApps: published, openAppName: "fee-estimate" });
    expect(moduleOff).not.toContain("lucide-layout-grid");
    expect(moduleOff).not.toContain("rail-apps");
    expect(moduleOff).not.toContain("Fee estimate");
  });

  it("lists five Apps at most and then All apps, which opens the Apps page", () => {
    const onViewChange = vi.fn();
    const open = { apps: true, openAppName: "app-0", view: "apps" as const };

    const markup = renderRail({ ...open, publishedApps: many });
    expect(itemsIn(markup)).toEqual(many.slice(0, RAIL_APPS_LIMIT).map(({ title }) => title));

    // Five and no more: the Apps row is the way to the page.
    expect(renderRail({ ...open, publishedApps: many.slice(0, RAIL_APPS_LIMIT) })).not.toContain(
      "rail-apps-all"
    );
    // Two read of a list that holds more.
    expect(
      renderRail({ ...open, publishedApps: many.slice(0, 2), morePublishedApps: true })
    ).toContain("rail-apps-all");

    const mounted = mount({ ...open, publishedApps: many, onViewChange });
    act(() => mounted.byTestId("rail-apps-all").click());
    expect(onViewChange).toHaveBeenCalledWith("apps");
    mounted.unmount();
  });
});

describe("workspace rail App fold in the browser", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens and folds on the caret, keeps the choice, and the row still opens the page", () => {
    const onViewChange = vi.fn();
    const onOpenApp = vi.fn();
    const props = { apps: true, publishedApps: published, onViewChange, onOpenApp };

    const first = mount(props);
    const toggle = first.byTestId("rail-apps-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(first.query("rail-apps")).toBeNull();

    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(window.localStorage.getItem(FOLD_KEY)).toBe("open");

    act(() => first.button("Customer list").click());
    expect(onOpenApp).toHaveBeenCalledWith("customer-list");
    act(() => first.button("Apps").click());
    expect(onViewChange).toHaveBeenCalledWith("apps");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    first.unmount();

    // The next visit in this browser starts open, and a fold is kept as well.
    const second = mount(props);
    expect(second.byTestId("rail-apps-toggle").getAttribute("aria-expanded")).toBe("true");
    act(() => second.byTestId("rail-apps-toggle").click());
    expect(second.query("rail-apps")).toBeNull();
    expect(window.localStorage.getItem(FOLD_KEY)).toBe("closed");
    second.unmount();
    const third = mount(props);
    expect(third.query("rail-apps")).toBeNull();
    third.unmount();
  });

  it("opens for the App on screen without changing the choice, and folds again on request", () => {
    window.localStorage.setItem(FOLD_KEY, "closed");
    const props = { apps: true, publishedApps: published, view: "apps" as const };

    const mounted = mount({ ...props, openAppName: "fee-estimate" });
    expect(mounted.byTestId("rail-apps-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(mounted.button("Fee estimate").getAttribute("aria-current")).toBe("true");
    expect(window.localStorage.getItem(FOLD_KEY)).toBe("closed");

    // Folded on the App, the Apps row is the current one.
    act(() => mounted.byTestId("rail-apps-toggle").click());
    expect(mounted.query("rail-apps")).toBeNull();
    expect(mounted.button("Apps").getAttribute("aria-current")).toBe("true");

    // Another App opens the fold again.
    mounted.render({ ...props, openAppName: "customer-list" });
    expect(mounted.button("Customer list").getAttribute("aria-current")).toBe("true");
    mounted.unmount();
  });

  it("starts folded and still folds where the browser keeps nothing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const mounted = mount({ apps: true, publishedApps: published });
    expect(mounted.query("rail-apps")).toBeNull();
    act(() => mounted.byTestId("rail-apps-toggle").click());
    expect(mounted.query("rail-apps")).not.toBeNull();
    mounted.unmount();
  });
});

function mount(props: Partial<RailProps>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = (next: Partial<RailProps>) =>
    act(() =>
      root.render(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, rail(next)))
    );
  render(props);
  const query = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return {
    render,
    query,
    byTestId(testId: string): HTMLElement {
      const element = query(testId);
      if (!element) {
        throw new Error(`No ${testId} in the rail.`);
      }
      return element;
    },
    button(name: string): HTMLButtonElement {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) =>
          candidate.textContent?.trim().endsWith(name) && !candidate.getAttribute("aria-label")
      );
      if (!button) {
        throw new Error(`No button ${name} in the rail.`);
      }
      return button;
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    }
  };
}

const PROJECTS_KEY = "vivd-catalyst:rail-projects-open";

function project(id: string, title: string) {
  return { id, name: id, title, audience: "workspace" as const, collaborationWorkspaceId: "cw" };
}

function projectChat(id: string, projectId: string): ConversationListItem {
  return {
    id,
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw",
    createdByUserId: "user_1",
    createdByExternalUserId: "external_1",
    visibility: "workspace",
    title: `Chat ${id}`,
    status: "active",
    createdAt: "2026-11-04T10:00:00.000Z",
    updatedAt: "2026-11-04T10:00:00.000Z",
    retainedUntil: "2027-11-04T10:00:00.000Z",
    people: [],
    projectId
  };
}

const chatsOf: Record<string, ConversationListItem[]> = {
  prj_north: [projectChat("n1", "prj_north")],
  prj_south: [projectChat("s1", "prj_south")]
};

/** The rail as the workspace wires it: the fold state from the hook, the chats from a list. */
function FoldedRail({ activeProjectId }: { activeProjectId?: string }) {
  const folds = useRailProjectsOpen(activeProjectId);
  return rail({
    projects: true,
    recentProjects: [project("prj_north", "North"), project("prj_south", "South")],
    openProjects: new Map(folds.open.map((id) => [id, { chats: chatsOf[id] ?? [], more: false }])),
    onToggleProject: folds.toggle
  });
}

function mountProjects(activeProjectId?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = (next?: string) =>
    act(() =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(FoldedRail, { activeProjectId: next })
        )
      )
    );
  render(activeProjectId);
  const caret = (title: string) => {
    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Chats in ${title}"]`
    );
    if (!button) throw new Error(`No caret for ${title}.`);
    return button;
  };
  return {
    render,
    caret,
    open: (title: string) => caret(title).getAttribute("aria-expanded") === "true",
    text: () => container.textContent ?? "",
    unmount() {
      act(() => root.unmount());
      container.remove();
    }
  };
}

describe("the projects' folds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the open projects' ids, and toggles one without touching the others", () => {
    expect(parseRailProjectsOpen('["prj_a",3]')).toEqual(["prj_a"]);
    expect(parseRailProjectsOpen('{"prj_a":true}')).toEqual([]);
    expect(railProjectsToggled(["prj_a"], "prj_b")).toEqual(["prj_a", "prj_b"]);
    expect(railProjectsToggled(["prj_a", "prj_b"], "prj_a")).toEqual(["prj_b"]);
  });

  it("open on the caret, several at once, and the next visit keeps them", () => {
    const first = mountProjects();
    expect(first.open("North")).toBe(false);
    expect(first.text()).not.toContain("Chat n1");
    act(() => first.caret("North").click());
    act(() => first.caret("South").click());
    expect(first.text()).toContain("Chat n1");
    expect(first.text()).toContain("Chat s1");
    expect(JSON.parse(window.localStorage.getItem(PROJECTS_KEY) ?? "[]")).toEqual([
      "prj_north",
      "prj_south"
    ]);
    first.unmount();

    const second = mountProjects();
    expect(second.open("North")).toBe(true);
    act(() => second.caret("North").click());
    expect(second.open("North")).toBe(false);
    expect(second.open("South")).toBe(true);
    second.unmount();
  });

  it("opens the project on screen without changing the choice", () => {
    const mounted = mountProjects("prj_south");
    expect(mounted.open("South")).toBe(true);
    expect(mounted.open("North")).toBe(false);
    expect(window.localStorage.getItem(PROJECTS_KEY)).toBeNull();
    // Folded on its page, it stays folded until another project is on screen.
    act(() => mounted.caret("South").click());
    expect(mounted.open("South")).toBe(false);
    mounted.render("prj_north");
    expect(mounted.open("North")).toBe(true);
    mounted.unmount();
  });
});
