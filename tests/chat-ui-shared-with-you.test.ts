// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiClient,
  ConversationListItem,
  LocaleCode,
  SafeConfig,
  SharedFromOutsideListItem
} from "@work-shape/catalyst-api-client";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { UiRoot, uiLabelsEn, type CommandPaletteProps } from "@work-shape/catalyst-ui";
import { ConversationPalette, WorkspaceRail, useSharedFromOutsideQuery } from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { recordedApiClient } from "./support/recorded-api-client";

// CHAT-SHARE-6b: the chats shared with a person from workspaces they are no member of stand in
// the rail's group "Shared with you" below "Recent", in every workspace, each with its
// workspace's name, and the palette finds them.

// The palette's overlay mounts in a browser; its groups are rendered here as a list, with the
// last props kept so a test can type and pick.
let palette: CommandPaletteProps | undefined;
vi.mock("@work-shape/catalyst-ui", async (importOriginal) => {
  const library = await importOriginal<typeof import("@work-shape/catalyst-ui")>();
  return {
    ...library,
    CommandPalette: (props: CommandPaletteProps) => {
      palette = props;
      return createElement(
        "div",
        null,
        props.groups
          .filter((group) => group.items.length > 0)
          .map((group) =>
            createElement(
              "section",
              { key: group.heading ?? "", "data-heading": group.heading ?? "" },
              group.items.map((item) =>
                createElement(
                  "p",
                  { key: item.value, "data-value": item.value },
                  [item.label, item.description].filter(Boolean).join(" · ")
                )
              )
            )
          ),
        props.message === undefined ? null : createElement("output", null, props.message)
      );
    }
  };
});

const noop = () => undefined;

function conversation(id: string, title: string): ConversationListItem {
  return {
    id,
    title,
    clientInstanceId: "client",
    collaborationWorkspaceId: "cws_own",
    createdByUserId: "user-reader",
    createdByExternalUserId: "external",
    visibility: "workspace",
    status: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    retainedUntil: "2027-11-01T00:00:00.000Z",
    people: []
  };
}

function sharedChat(id: string, title: string, workspaceName: string): SharedFromOutsideListItem {
  return {
    ...conversation(id, title),
    collaborationWorkspaceId: `cws_${workspaceName.toLowerCase().replace(/\W+/gu, "_")}`,
    createdByUserId: "user-creator",
    createdByDisplayLabel: "Creator",
    visibility: "private",
    people: [
      { userId: "user-reader", displayLabel: "Reader", addedAt: "2026-11-01T00:00:00.000Z" }
    ],
    workspaceName
  };
}

const fromTeam = sharedChat("conv_shared", "Quarter figures", "Team T");
const fromOther = sharedChat("conv_other", "Launch notes", "Other team");

const testConfig = createTestConfig();
const railConfig: SafeConfig = safeConfigSchema.parse(
  createSafeConfigView(
    testConfig,
    { version: 0, agents: [], skills: [] },
    resolveInstanceModules(testConfig, []).snapshot
  )
);

type RailProps = Parameters<typeof WorkspaceRail>[0];

function railProps(overrides: Partial<RailProps>): RailProps {
  return {
    config: railConfig,
    conversations: [conversation("conv_own", "Own notes")],
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
  };
}

function renderRail(overrides: Partial<RailProps>, locale: LocaleCode = "en"): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
      createElement(WorkspaceRail, railProps(overrides))
    )
  );
}

class StillResizeObserver {
  observe() {}
  unobserve() {}
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
  palette = undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Lets the timers and the requests run until `check` holds. */
async function until(check: () => boolean) {
  const deadline = Date.now() + CONDITION_WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("The condition did not come true in time");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function mount(
  node: ReactNode,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  locale: LocaleCode = "en"
) {
  act(() =>
    root?.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { children: null, locale },
          createElement(QueryClientProvider, { client: queryClient }, node)
        )
      )
    )
  );
  return queryClient;
}

describe("the rail's group Shared with you", () => {
  it("stands below Recent with each chat's title and its workspace's name", () => {
    const markup = renderRail({ sharedWithYou: [fromTeam, fromOther] });
    const group = markup.slice(markup.indexOf('data-testid="rail-shared-with-you"'));
    expect(markup.indexOf("Recent")).toBeLessThan(markup.indexOf("Shared with you"));
    expect(markup.indexOf("Own notes")).toBeLessThan(markup.indexOf('data-testid="rail-shared'));
    expect(group.match(/data-testid="rail-shared-chat"/gu)).toHaveLength(2);
    expect(group).toMatch(
      /title="Quarter figures, in Team T"[^>]*>(?:(?!<\/button>).)*Quarter figures(?:(?!<\/button>).)*data-testid="rail-shared-chat-workspace"[^>]*>Team T</u
    );
    expect(group).toContain(">Launch notes<");
    expect(group).toContain(">Other team<");
    // A row has no menu: Share, Move and Delete are the creator's.
    expect(group).not.toContain("Options for");
  });

  it("is named in German", () => {
    expect(renderRail({ sharedWithYou: [fromTeam] }, "de")).toContain("Mit dir geteilt");
  });

  it("is absent while it holds nothing, and in the collapsed strip", () => {
    expect(renderRail({})).not.toContain("rail-shared-with-you");
    expect(renderRail({ sharedWithYou: [] })).not.toContain("Shared with you");
    const collapsed = renderRail({ sharedWithYou: [fromTeam], collapsed: true });
    expect(collapsed).not.toContain("Shared with you");
    expect(collapsed).not.toContain("Quarter figures");
  });

  it("marks the open chat as the current row", () => {
    const markup = renderRail({
      sharedWithYou: [fromTeam, fromOther],
      selectedConversationId: "conv_other"
    });
    expect(
      markup.match(/aria-current="true"[^>]*title="Launch notes, in Other team"/gu)
    ).toHaveLength(1);
    expect(markup).not.toMatch(/aria-current="true"[^>]*title="Quarter figures/u);
  });

  it("opens a chat with its own workspace on a click", () => {
    const opened: SharedFromOutsideListItem[] = [];
    mount(
      createElement(
        WorkspaceRail,
        railProps({
          sharedWithYou: [fromTeam],
          onSelectSharedConversation: (chat) => opened.push(chat)
        })
      )
    );
    act(() =>
      required(
        container.querySelector<HTMLButtonElement>('[data-testid="rail-shared-chat"]')
      ).click()
    );
    expect(opened.map((chat) => [chat.id, chat.collaborationWorkspaceId])).toEqual([
      ["conv_shared", "cws_team_t"]
    ]);
  });
});

function paletteClient(found: readonly SharedFromOutsideListItem[]) {
  return recordedApiClient((call) => {
    switch (call.operation) {
      case "conversations.list":
        return { items: [] };
      case "conversations.shared_from_outside.list":
        return { items: found };
      default:
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 }
        );
    }
  });
}

function mountPalette(input: {
  client: ApiClient;
  sharedWithYou?: readonly SharedFromOutsideListItem[];
  onSelectSharedConversation?: (chat: SharedFromOutsideListItem) => void;
}) {
  mount(
    createElement(ConversationPalette, {
      open: true,
      apiBaseUrl: "https://chat.example",
      authScope: "workspace",
      client: input.client,
      collaborationWorkspaceId: "cws_own",
      collaborationWorkspacesAvailable: true,
      searchedWorkspaceName: "Own team",
      recentConversations: [conversation("conv_own", "Own notes")],
      ...(input.sharedWithYou ? { sharedWithYou: input.sharedWithYou } : {}),
      goToTargets: [],
      onNewChat: noop,
      onSelectConversation: noop,
      ...(input.onSelectSharedConversation
        ? { onSelectSharedConversation: input.onSelectSharedConversation }
        : {}),
      onGoTo: noop,
      onClose: noop
    })
  );
}

/** The palette's groups as shown: each heading with its rows. */
function shownGroups(): [string, string[]][] {
  return [...container.querySelectorAll("section")].map((section) => [
    section.getAttribute("data-heading") ?? "",
    [...section.querySelectorAll("p")].map((row) => row.textContent ?? "")
  ]);
}

describe("the palette's chats shared from outside", () => {
  it("lists them after Recent before anything is typed, and asks nothing", () => {
    const { client, calls } = paletteClient([]);
    mountPalette({ client, sharedWithYou: [fromTeam] });
    expect(shownGroups()).toEqual([
      ["", ["New chat"]],
      ["Recent", ["Own notes"]],
      ["Shared with you", ["Quarter figures · Team T"]]
    ]);
    expect(calls).toEqual([]);
  });

  it("searches them with the typed text and opens a match with its own workspace", async () => {
    const { client, calls } = paletteClient([fromOther]);
    const opened: SharedFromOutsideListItem[] = [];
    mountPalette({
      client,
      sharedWithYou: [fromTeam],
      onSelectSharedConversation: (chat) => opened.push(chat)
    });
    act(() => required(palette).onQueryChange("launch"));
    await until(
      () => container.querySelector('[data-value="shared-from-outside:conv_other"]') !== null
    );
    expect(shownGroups()).toEqual([["Shared with you", ["Launch notes · Other team"]]]);
    expect(
      calls
        .filter((call) => call.operation === "conversations.shared_from_outside.list")
        .map((call) => call.query.query)
    ).toEqual(["launch"]);
    // A match alone is not "no results".
    expect(container.querySelector("output")).toBeNull();
    act(() => required(palette).onSelect("shared-from-outside:conv_other"));
    expect(opened.map((chat) => [chat.id, chat.collaborationWorkspaceId])).toEqual([
      ["conv_other", "cws_other_team"]
    ]);
  });

  it("says no results only where neither list matches", async () => {
    const { client } = paletteClient([]);
    mountPalette({ client });
    act(() => required(palette).onQueryChange("nothing"));
    await until(() => container.querySelector("output") !== null);
    expect(container.querySelector("output")?.textContent).toBe(
      'No results for "nothing" in Own team.'
    );
  });
});

describe("the list of chats shared from outside", () => {
  function List({
    client,
    openOutsideConversationId
  }: {
    client: ApiClient;
    openOutsideConversationId?: string;
  }) {
    const query = useSharedFromOutsideQuery({
      apiBaseUrl: "https://chat.example",
      authScope: "workspace",
      client,
      enabled: true,
      openOutsideConversationId
    });
    return createElement(
      "ul",
      null,
      (query.data ?? []).map((chat) => createElement("li", { key: chat.id }, chat.title))
    );
  }
  const shown = () => [...container.querySelectorAll("li")].map((row) => row.textContent);

  it("reads its first page again once for an open chat it does not hold yet", async () => {
    let found: SharedFromOutsideListItem[] = [fromOther];
    const recorded = recordedApiClient(() => ({ items: found }));
    const reads = () =>
      recorded.calls.filter((call) => call.operation === "conversations.shared_from_outside.list");
    const queryClient = mount(createElement(List, { client: recorded.client }));
    await until(() => shown().length === 1);
    expect(reads().map((call) => call.query.limit)).toEqual(["20"]);

    // A fresh share: the Inbox notice opens the chat before the list holds it.
    found = [fromTeam, fromOther];
    mount(
      createElement(List, { client: recorded.client, openOutsideConversationId: "conv_shared" }),
      queryClient
    );
    await until(() => shown().length === 2);
    expect(shown()).toEqual(["Quarter figures", "Launch notes"]);
    expect(reads()).toHaveLength(2);
  });

  it("is read again when the conversations are marked as changed, as a leave does", async () => {
    let found: SharedFromOutsideListItem[] = [fromTeam];
    const recorded = recordedApiClient(() => ({ items: found }));
    const queryClient = mount(createElement(List, { client: recorded.client }));
    await until(() => shown().length === 1);
    found = [];
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["conversations", "https://chat.example", "workspace"]
      });
    });
    await until(() => shown().length === 0);
  });
});
