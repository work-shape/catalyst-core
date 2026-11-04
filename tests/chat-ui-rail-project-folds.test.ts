// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConversationListItem, SafeConfig } from "@work-shape/catalyst-api-client";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { TranslationProvider } from "./chat-ui-render-harness";
import {
  WorkspaceRail,
  parseRailProjectsOpen,
  railProjectsToggled,
  useRailProjectsOpen
} from "./support/chat-ui";
import { createTestConfig } from "./support/fixtures";

// Felix, 2026-11-04: each project of the rail folds on its own. The caret after its label opens
// and folds it, several stand open at once, the browser keeps the choice as it keeps the Apps
// fold, and the project on screen opens.

const noop = () => undefined;
const FOLD_KEY = "vivd-catalyst:rail-projects-open";

const testConfig = createTestConfig();
const railConfig: SafeConfig = safeConfigSchema.parse(
  createSafeConfigView(
    testConfig,
    { version: 0, agents: [], skills: [] },
    resolveInstanceModules(testConfig, []).snapshot
  )
);

function project(id: string, title: string) {
  return { id, name: id, title, audience: "workspace" as const, collaborationWorkspaceId: "cw" };
}

function chat(id: string, projectId: string): ConversationListItem {
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
    projectId
  };
}

const north = project("prj_north", "North");
const south = project("prj_south", "South");
const chatsOf: Record<string, ConversationListItem[]> = {
  prj_north: [chat("n1", "prj_north")],
  prj_south: [chat("s1", "prj_south")]
};

type RailProps = ComponentProps<typeof WorkspaceRail>;

/** The rail as the workspace wires it: the fold state from the hook, the chats from a list. */
function FoldedRail(props: { activeProjectId?: string } & Partial<RailProps>) {
  const folds = useRailProjectsOpen(props.activeProjectId);
  return createElement(
    TranslationProvider,
    { children: null, locale: "en" },
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
      projects: true,
      recentProjects: [north, south],
      openProjects: new Map(
        folds.open.map((id) => [id, { chats: chatsOf[id] ?? [], more: id === "prj_north" }])
      ),
      onToggleProject: folds.toggle,
      ...props
    })
  );
}

function mount(props: { activeProjectId?: string } & Partial<RailProps> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const render = (next: typeof props) =>
    act(() =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(FoldedRail, next)
        )
      )
    );
  render(props);
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
    query: (selector: string) => container.querySelector<HTMLElement>(selector),
    unmount() {
      act(() => root.unmount());
      container.remove();
    }
  };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("the projects' folds as the browser keeps them", () => {
  it("reads the open projects' ids, and anything else as none open", () => {
    expect(parseRailProjectsOpen('["prj_a","prj_b"]')).toEqual(["prj_a", "prj_b"]);
    expect(parseRailProjectsOpen('["prj_a",3]')).toEqual(["prj_a"]);
    expect(parseRailProjectsOpen("open")).toEqual([]);
    expect(parseRailProjectsOpen('{"prj_a":true}')).toEqual([]);
    expect(parseRailProjectsOpen(null)).toEqual([]);
  });

  it("opens and folds one project without touching the others", () => {
    expect(railProjectsToggled(["prj_a"], "prj_b")).toEqual(["prj_a", "prj_b"]);
    expect(railProjectsToggled(["prj_a", "prj_b"], "prj_a")).toEqual(["prj_b"]);
  });
});

describe("the projects' folds in the browser", () => {
  it("open on the caret, several at once, and the next visit keeps them", () => {
    const first = mount();
    expect(first.open("North")).toBe(false);
    expect(first.open("South")).toBe(false);
    expect(first.text()).not.toContain("Chat n1");

    act(() => first.caret("North").click());
    act(() => first.caret("South").click());
    expect(first.open("North")).toBe(true);
    expect(first.open("South")).toBe(true);
    expect(first.text()).toContain("Chat n1");
    expect(first.text()).toContain("Chat s1");
    expect(JSON.parse(window.localStorage.getItem(FOLD_KEY) ?? "[]")).toEqual([
      "prj_north",
      "prj_south"
    ]);
    first.unmount();

    const second = mount();
    expect(second.open("North")).toBe(true);
    act(() => second.caret("North").click());
    expect(second.open("North")).toBe(false);
    expect(second.open("South")).toBe(true);
    second.unmount();
    const third = mount();
    expect(third.open("North")).toBe(false);
    third.unmount();
  });

  it("opens the project on screen without changing the choice", () => {
    const mounted = mount({ activeProjectId: "prj_south" });
    expect(mounted.open("South")).toBe(true);
    expect(mounted.open("North")).toBe(false);
    expect(window.localStorage.getItem(FOLD_KEY)).toBeNull();

    // Folded on its page, it stays folded until another project is on screen.
    act(() => mounted.caret("South").click());
    expect(mounted.open("South")).toBe(false);
    mounted.render({ activeProjectId: "prj_north" });
    expect(mounted.open("North")).toBe(true);
    mounted.unmount();
  });

  it("shows more in place and opens the page from the label", () => {
    const onShowMoreProjectChats = vi.fn();
    const onOpenProject = vi.fn();
    const mounted = mount({ activeProjectId: "prj_north", onShowMoreProjectChats, onOpenProject });
    const more = mounted.query('[data-testid="rail-project-chats-more"]');
    expect(more?.textContent).toBe("Show more");
    act(() => more?.click());
    expect(onShowMoreProjectChats).toHaveBeenCalledWith("prj_north");
    // Only where the project has more.
    act(() => mounted.caret("South").click());
    expect(mounted.query('[data-testid="rail-project-chats-more"]')).toBe(more);
    act(() => mounted.query('a[title="South"]')?.click());
    expect(onOpenProject).toHaveBeenCalledWith("prj_south");
    // The label opens the page and leaves the fold as it is.
    expect(mounted.open("South")).toBe(true);
    mounted.unmount();
  });
});
