import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import type { ConversationListItem, LocaleCode, SafeConfig } from "@work-shape/catalyst-api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CollaborationWorkspaceSelector,
  DockedChat,
  WorkspaceRail,
  activeRailProject,
  railProjectChats,
  type RailProject,
  retentionHintAfter,
  retentionHintClosed,
  retentionHintOpen,
  type RetentionHintEvent,
  collaborationWorkspacesAvailableFor,
  workspaceSendBlock,
  activeAgentNameFor,
  conversationAgentPickFor,
  isOwnChat,
  workspaceScopedConfigFor
} from "./support/chat-ui";

const noop = () => undefined;

function conversation(id: string, title: string): ConversationListItem {
  return {
    id,
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_shared",
    createdByUserId: "user_1",
    createdByExternalUserId: "external_1",
    visibility: "workspace",
    title,
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    retainedUntil: "2027-08-01T10:00:00.000Z"
  };
}

describe.each<{ locale: LocaleCode; loadingReason: string; failedReason: string }>([
  {
    locale: "en",
    loadingReason: "Loading workspaces…",
    failedReason: "Workspaces could not be loaded."
  },
  {
    locale: "de",
    loadingReason: "Arbeitsbereiche werden geladen…",
    failedReason: "Arbeitsbereiche konnten nicht geladen werden."
  }
])("workspace send guard ($locale)", ({ locale, loadingReason, failedReason }) => {
  const pending: Parameters<typeof workspaceSendBlock>[0] = {
    attachmentBlockedReason: undefined,
    selectedConversationId: undefined,
    collaborationWorkspacesAvailable: true,
    activeCollaborationWorkspaceId: undefined,
    loading: true,
    loadFailed: false,
    workspacesListed: false,
    locale
  };
  const cases: {
    name: string;
    input: Partial<Parameters<typeof workspaceSendBlock>[0]>;
    expected: string | undefined;
  }[] = [
    { name: "pending", input: {}, expected: loadingReason },
    {
      name: "ready after pending",
      input: { loading: false, activeCollaborationWorkspaceId: "workspace_personal" },
      expected: undefined
    },
    {
      name: "failed",
      input: { loading: false, loadFailed: true },
      expected: failedReason
    },
    { name: "empty", input: { loading: false }, expected: failedReason },
    {
      name: "listed before the page opens one",
      input: { loading: false, workspacesListed: true },
      expected: loadingReason
    },
    {
      name: "failed with an earlier list",
      input: { loading: false, loadFailed: true, workspacesListed: true },
      expected: failedReason
    },
    {
      name: "existing conversation while pending",
      input: { selectedConversationId: "conv_existing" },
      expected: undefined
    },
    {
      name: "existing conversation after failure",
      input: { selectedConversationId: "conv_existing", loading: false, loadFailed: true },
      expected: undefined
    },
    {
      name: "workspaces unavailable while pending",
      input: { collaborationWorkspacesAvailable: false },
      expected: undefined
    },
    {
      name: "workspaces unavailable after failure",
      input: { collaborationWorkspacesAvailable: false, loading: false, loadFailed: true },
      expected: undefined
    },
    {
      name: "embedded token widget",
      input: {
        collaborationWorkspacesAvailable: collaborationWorkspacesAvailableFor({
          token: "test-session-token"
        })
      },
      expected: undefined
    },
    {
      name: "embedded token provider widget",
      input: {
        collaborationWorkspacesAvailable: collaborationWorkspacesAvailableFor({
          getToken: () => "test-session-token"
        })
      },
      expected: undefined
    },
    {
      name: "attachment precedence while pending",
      input: { attachmentBlockedReason: "attachment blocked" },
      expected: "attachment blocked"
    },
    {
      name: "attachment precedence after failure",
      input: {
        attachmentBlockedReason: "attachment blocked",
        loading: false,
        loadFailed: true
      },
      expected: "attachment blocked"
    },
    {
      name: "attachment precedence when ready",
      input: {
        attachmentBlockedReason: "attachment blocked",
        loading: false,
        activeCollaborationWorkspaceId: "workspace_personal"
      },
      expected: "attachment blocked"
    }
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(workspaceSendBlock({ ...pending, ...input })?.reason).toBe(expected);
  });

  it("lets a send wait only while the workspaces load", () => {
    expect(workspaceSendBlock(pending)?.loading).toBe(true);
    expect(workspaceSendBlock({ ...pending, loading: false, loadFailed: true })?.loading).toBe(
      false
    );
    expect(workspaceSendBlock({ ...pending, loading: false })?.loading).toBe(false);
    expect(
      workspaceSendBlock({ ...pending, loading: false, workspacesListed: true })?.loading
    ).toBe(true);
    expect(
      workspaceSendBlock({ ...pending, attachmentBlockedReason: "attachment blocked" })?.loading
    ).toBe(false);
  });
});

const railConfig = {
  ui: { clientName: "Musterfinanz", title: "Musterfinanz Chat" }
} as SafeConfig;

type RailProps = Parameters<typeof WorkspaceRail>[0];

function renderRail(
  collaborationWorkspaceSelector?: ReactNode,
  inbox?: { toDecide: number },
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
        collaborationWorkspaceSelector,
        conversations,
        conversationsStatus: "ready",
        selectedConversationId: undefined,
        canViewAdministration: false,
        inbox,
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

const selector = createElement(CollaborationWorkspaceSelector, {
  collaborationWorkspaces: [],
  activeCollaborationWorkspaceId: undefined,
  userLabel: "Felix Pahlke",
  loading: false,
  loadFailed: false,
  onSelectCollaborationWorkspace: noop,
  onOpenCollaborationWorkspaceSettings: noop,
  onBrowseCollaborationWorkspaces: noop,
  onCreateCollaborationWorkspace: noop
});

describe("workspace rail branding", () => {
  it("shows the client logo where an embedded session has no workspace to select", () => {
    const markup = renderRail(undefined, undefined, [], {
      config: {
        ui: { clientName: "Musterfinanz", logoUrl: "/assets/musterfinanz.svg" }
      } as SafeConfig
    });

    expect(markup).toContain('src="/assets/musterfinanz.svg"');
    expect(markup).toContain('alt="Musterfinanz"');
    expect(markup).not.toContain('href="/"');
  });

  it("uses the client's name and initial when no logo is configured", () => {
    const markup = renderRail();

    expect(markup).toContain(">MU</span>");
    expect(markup).toContain(">Musterfinanz</span>");
    expect(markup).not.toContain("Workshape Catalyst");
  });
});

describe("workspace rail frame", () => {
  it("is one navigation landmark with search, collapse and New chat at its head", () => {
    const markup = renderRail();

    expect(markup).toMatch(/^<nav[^>]*aria-label="Main navigation"/u);
    expect(markup.match(/<nav/gu)).toHaveLength(1);
    expect(markup).toContain('aria-label="Search"');
    expect(markup).toMatch(/<button[^>]*aria-label="Collapse sidebar"[^>]*aria-expanded="true"/u);
    expect(markup).toContain("New chat");
    expect(markup).toContain("Recent");
  });

  it("is named in German as well", () => {
    const markup = renderRail(undefined, undefined, [], {}, "de");

    expect(markup).toContain('aria-label="Hauptnavigation"');
    expect(markup).toContain('aria-label="Suchen"');
    expect(markup).toContain('aria-label="Seitenleiste einklappen"');
    expect(markup).toContain("Neuer Chat");
    expect(markup).toContain("Zuletzt");
  });

  it("keeps only the icons when it is collapsed", () => {
    const markup = renderRail(selector, undefined, [conversation("conv_1", "Angebot Q3")], {
      collapsed: true
    });

    expect(markup).toMatch(/<button[^>]*aria-label="Expand sidebar"[^>]*aria-expanded="false"/u);
    expect(markup).toContain('aria-label="Search"');
    expect(markup).toContain('<span class="sr-only">New chat</span>');
    // The selector, the "Recent" label and the list leave with the width.
    expect(markup).not.toContain('aria-label="Switch workspace"');
    expect(markup).not.toContain("Recent");
    expect(markup).not.toContain("Angebot Q3");
  });
});

describe("workspace rail Studio row and Settings gear", () => {
  it("offers New chat at the end of the Recent heading, and not in the collapsed strip", () => {
    const markup = renderRail();
    const heading = markup.slice(markup.indexOf("data-nav-group-label"));
    const action = heading.slice(0, heading.indexOf("</div>"));

    // The heading names the group; the button beside it is named for what it does.
    expect(action).toMatch(/<span id="[^"]+"[^>]*>Recent<\/span>/u);
    expect(action).toMatch(/<button[^>]*aria-label="New chat"/u);
    // It keeps its room while it is unseen, shows for the pointer and the keyboard, and
    // always where nothing hovers.
    expect(action).toContain("opacity-0");
    expect(action).toContain("group-hover/nav-group:opacity-100");
    expect(action).toContain("focus-within:opacity-100");
    expect(action).toContain("[@media(hover:none)]:opacity-100");

    expect(renderRail(undefined, undefined, [], {}, "de")).toMatch(
      /data-nav-group-action=""[^>]*><button[^>]*aria-label="Neuer Chat"/u
    );
    expect(renderRail(undefined, undefined, [], { collapsed: true })).not.toContain(
      "data-nav-group-action"
    );
  });

  it("shows Studio above the account row only to a viewer who may open it", () => {
    expect(renderRail()).not.toContain("lucide-blocks");

    const markup = renderRail(undefined, undefined, [], { canViewBuild: true, view: "build" });
    expect(markup).toMatch(/<button[^>]*aria-current="true"[^>]*>(?:(?!<\/button>).)*Studio/u);
  });

  it("offers the gear to a viewer with an administration page and marks it on Settings", () => {
    expect(renderRail()).not.toContain('aria-label="Settings"');

    const markup = renderRail(undefined, undefined, [], { canViewAdministration: true });
    expect(markup).toMatch(/<button[^>]*aria-label="Settings"[^>]*aria-pressed="false"/u);
    const onSettings = renderRail(undefined, undefined, [], {
      canViewAdministration: true,
      view: "settings"
    });
    expect(onSettings).toMatch(/<button[^>]*aria-label="Return to chat"[^>]*aria-pressed="true"/u);
  });
});

describe("workspace rail conversation titles", () => {
  it.each([
    ["en", "New conversation"],
    ["de", "Neue Unterhaltung"]
  ] as const)(
    "shows the stored placeholder title in the reader's language (%s)",
    (locale, shown) => {
      const markup = renderRail(
        undefined,
        undefined,
        [
          conversation("conv_new", "New conversation"),
          conversation("conv_named", "New conversation about Q3")
        ],
        {},
        locale
      );

      expect(markup).toContain(`title="${shown}">${shown}</span>`);
      // Only the exact placeholder is translated; a title that starts with it is the person's own.
      expect(markup).toContain(
        `title="New conversation about Q3">New conversation about Q3</span>`
      );
      if (locale === "de") {
        expect(markup).not.toContain(`"New conversation"`);
        expect(markup).not.toContain(">New conversation<");
      }
    }
  );

  it.each([
    ["en", "New conversation"],
    ["de", "Neue Unterhaltung"]
  ] as const)("names the docked conversation's head by the placeholder in %s", (locale, shown) => {
    const dock = {
      conversationId: "conv_new",
      tab: "build" as const,
      tryAgent: undefined,
      open: true,
      inFront: false,
      openPage: noop,
      show: noop,
      close: noop,
      forget: noop,
      last: undefined,
      forgetLast: noop,
      reopen: noop,
      showPage: noop,
      showChat: noop,
      showTry: noop,
      showBuild: noop
    };
    const view = {
      mode: "dock" as const,
      layout: { over: false, width: 420, min: 380, max: 760, choose: noop, keep: noop },
      arrival: undefined,
      arrived: noop,
      measure: noop
    };
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(DockedChat, {
          view,
          dock,
          title: "New conversation",
          agent: undefined,
          children: null
        })
      )
    );

    expect(markup).toContain(shown);
    if (locale === "de") {
      expect(markup).not.toContain("New conversation");
    }
  });
});

describe("workspace rail conversation list states", () => {
  it("shows placeholder rows while the first page loads", () => {
    const markup = renderRail(undefined, undefined, [], { conversationsStatus: "loading" });

    expect(markup).toContain('data-testid="conversations-loading"');
    expect(markup).not.toContain("No conversations yet");
  });

  it("says that the list failed and offers to load it again", () => {
    const markup = renderRail(undefined, undefined, [], { conversationsStatus: "failed" });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Conversations could not be loaded.");
    expect(markup).toContain("Try again");
  });

  it("keeps the loaded conversations in view while a reload is under way", () => {
    const markup = renderRail(undefined, undefined, [conversation("conv_1", "Angebot Q3")], {
      conversationsStatus: "loading"
    });

    expect(markup).toContain("Angebot Q3");
    expect(markup).not.toContain('data-testid="conversations-loading"');
  });
});

describe("workspace rail collaboration workspace slot", () => {
  it("keeps the client's branding when no selector is supplied", () => {
    const markup = renderRail();

    expect(markup).not.toContain('aria-label="Switch workspace"');
    expect(markup).toContain("Musterfinanz");
  });

  it("lets the selector take the head of the rail for a first-party session", () => {
    const markup = renderRail(selector);

    expect(markup).toContain('aria-label="Switch workspace"');
    // The client identity moved into the selector's popover, which is closed here.
    expect(markup).not.toContain("Musterfinanz");
    expect(markup).toContain('aria-label="Collapse sidebar"');
  });
});

describe("workspace rail by session kind", () => {
  // `ChatWorkspace` hands the rail a selector exactly when
  // `collaborationWorkspacesAvailableFor` says the session is first-party.
  function railFor(auth: Parameters<typeof collaborationWorkspacesAvailableFor>[0]): string {
    return renderRail(collaborationWorkspacesAvailableFor(auth) ? selector : undefined);
  }

  it("gives every first-party session the selector, with no config to turn it off", () => {
    const markup = railFor({});

    expect(markup).toContain('aria-label="Switch workspace"');
    expect(markup).not.toContain("Musterfinanz");
  });

  it.each<[string, Parameters<typeof collaborationWorkspacesAvailableFor>[0]]>([
    ["a fixed token", { token: "hmac-session-token" }],
    ["a token callback", { getToken: () => "hmac-session-token" }]
  ])("keeps an embedded session with %s on the branding head without a selector", (_name, auth) => {
    const markup = railFor(auth);

    expect(markup).not.toContain('aria-label="Switch workspace"');
    expect(markup).toContain("Musterfinanz");
    expect(markup).toContain('aria-label="Main navigation"');
  });
});

describe("workspace-scoped agents", () => {
  const agent = (name: string) => ({ name, displayName: name }) as SafeConfig["agents"][number];
  const instanceConfig = {
    ...railConfig,
    defaultAgentName: "general",
    agents: [agent("general"), agent("research")]
  } as SafeConfig;
  const scoped = (
    input: Partial<Parameters<typeof workspaceScopedConfigFor>[0]>
  ): ReturnType<typeof workspaceScopedConfigFor> =>
    workspaceScopedConfigFor({
      config: instanceConfig,
      collaborationWorkspacesAvailable: true,
      workspaceAgents: undefined,
      instanceViewApplies: false,
      ownChat: false,
      ...input
    });

  it("offers the active workspace's agents and default instead of the instance view", () => {
    const result = scoped({
      workspaceAgents: {
        defaultAgentName: "contracts",
        visibleSections: [],
        items: [agent("contracts")]
      }
    });

    expect(result.config?.agents.map((entry) => entry.name)).toEqual(["contracts"]);
    expect(result.config?.defaultAgentName).toBe("contracts");
    expect(result).toMatchObject({ agentsLoading: false, workspaceScoped: true });
  });

  it("shows no agents rather than the wrong ones while a workspace's list loads", () => {
    const result = scoped({});

    expect(result.config?.agents).toEqual([]);
    expect(result.agentsLoading).toBe(true);
  });

  it("reports a workspace without agents as empty, not as loading", () => {
    const result = scoped({ workspaceAgents: { visibleSections: [], items: [] } });

    expect(result.config?.agents).toEqual([]);
    expect(result).toMatchObject({ agentsLoading: false, workspaceScoped: true });
  });

  it("keeps the instance view for embedded sessions and the Personal Workspace", () => {
    expect(scoped({ collaborationWorkspacesAvailable: false }).config).toBe(instanceConfig);
    expect(scoped({ instanceViewApplies: true })).toEqual({
      config: instanceConfig,
      agentsLoading: false,
      workspaceScoped: false,
      ownAgentsElsewhere: []
    });
  });

  it("offers the person's own agents in a chat only they read, and greys them elsewhere", () => {
    const workspaceAgents = {
      defaultAgentName: "contracts",
      visibleSections: [],
      items: [agent("contracts")],
      ownChatAgents: [agent("kai-tax")]
    };
    const own = scoped({ workspaceAgents, ownChat: true });
    expect(own.config?.agents.map((entry) => entry.name)).toEqual(["contracts", "kai-tax"]);
    expect(own.config?.defaultAgentName).toBe("contracts");
    expect(own.ownAgentsElsewhere).toEqual([]);

    const read = scoped({ workspaceAgents, ownChat: false });
    expect(read.config?.agents.map((entry) => entry.name)).toEqual(["contracts"]);
    expect(read.ownAgentsElsewhere.map((entry) => entry.name)).toEqual(["kai-tax"]);

    // An embedding host's session is refused them: neither offered nor listed greyed.
    const embedded = scoped({ workspaceAgents, ownChat: false, embedded: true });
    expect(embedded.config?.agents.map((entry) => entry.name)).toEqual(["contracts"]);
    expect(embedded.ownAgentsElsewhere).toEqual([]);
  });

  it("calls a chat the person's own only where nobody else reads it", () => {
    const team = {
      id: "cw_team",
      kind: "shared" as const,
      defaultConversationVisibility: "workspace"
    };
    const privateTeam = { ...team, defaultConversationVisibility: "private" };
    const home = {
      id: "cw_home",
      kind: "personal" as const,
      defaultConversationVisibility: "workspace"
    };
    const chat = (workspace: { id: string }, visibility: string, createdByUserId = "kai") => ({
      collaborationWorkspaceId: workspace.id,
      createdByUserId,
      visibility
    });
    const own = (input: Partial<Parameters<typeof isOwnChat>[0]>) =>
      isOwnChat({
        userId: "kai",
        workspace: team,
        conversation: undefined,
        conversationOpen: true,
        ...input
      });

    expect(own({ conversation: chat(team, "private") })).toBe(true);
    expect(own({ workspace: home, conversation: chat(home, "workspace") })).toBe(true);
    expect(own({ conversation: chat(team, "workspace") })).toBe(false);
    expect(own({ conversation: chat(team, "private", "lena") })).toBe(false);
    // Until the open chat has arrived nothing of the person's own is offered in it.
    expect(own({})).toBe(false);
    // A new chat is the person's own where the workspace starts chats only they read.
    expect(own({ conversationOpen: false, workspace: home })).toBe(true);
    expect(own({ conversationOpen: false, workspace: privateTeam })).toBe(true);
    expect(own({ conversationOpen: false })).toBe(false);
    expect(own({ conversationOpen: false, userId: undefined, workspace: home })).toBe(false);
    // An embedding host's session is never the person in their own chat.
    expect(own({ conversation: chat(team, "private"), embedded: true })).toBe(false);
    expect(own({ conversationOpen: false, workspace: home, embedded: true })).toBe(false);
  });

  it("falls back to the workspace default when the picked agent is not offered there", () => {
    const workspace = {
      defaultAgentName: "contracts",
      agents: [agent("contracts"), agent("general")]
    };

    expect(activeAgentNameFor(workspace, "general")).toBe("general");
    expect(activeAgentNameFor(workspace, "research")).toBe("contracts");
    expect(activeAgentNameFor(workspace, undefined)).toBe("contracts");
    expect(activeAgentNameFor({ defaultAgentName: "gone", agents: [agent("general")] }, "x")).toBe(
      "general"
    );
    expect(
      activeAgentNameFor({ defaultAgentName: undefined, agents: [] }, "general")
    ).toBeUndefined();
  });

  it("opens each conversation with its own agent; a pick stays in the conversation (T30)", () => {
    const thread = (id: string, agentName?: string) => ({
      conversation: { id },
      ...(agentName === undefined ? {} : { agentName })
    });
    const pick = (input: Partial<Parameters<typeof conversationAgentPickFor>[0]>) =>
      conversationAgentPickFor({
        conversationId: "conv_a",
        pickedIn: {},
        thread: undefined,
        forNew: "general",
        ...input
      });

    // A new conversation starts with the pick for new ones.
    expect(pick({ conversationId: undefined, pickedIn: { conv_a: "research" } })).toBe("general");
    // An open one keeps the agent of its latest run, whatever was picked for new ones.
    expect(pick({ thread: thread("conv_a", "contracts") })).toBe("contracts");
    // A pick in it wins, and only there.
    expect(pick({ pickedIn: { conv_a: "research" }, thread: thread("conv_a", "contracts") })).toBe(
      "research"
    );
    expect(
      pick({
        conversationId: "conv_b",
        pickedIn: { conv_a: "research" },
        thread: thread("conv_b", "contracts")
      })
    ).toBe("contracts");
    // Before its first run, and never from another conversation's thread.
    expect(pick({ thread: thread("conv_a") })).toBe("general");
    expect(pick({ thread: thread("conv_b", "contracts") })).toBe("general");
  });

  it("shows the Agents row as the instance names it, open and collapsed (NAV-VIS-1)", () => {
    for (const collapsed of [false, true]) {
      const rail = (agents: boolean) => renderRail(undefined, undefined, [], { agents, collapsed });
      expect(rail(true)).toContain("lucide-bot");
      expect(rail(false)).not.toContain("lucide-bot");
    }
  });
});

// Each of these fails without the Inbox row: the rail had a footer button for reviewers only.
describe("workspace rail Inbox row", () => {
  it("is absent for a person who decides nothing and has asked for nothing", () => {
    const markup = renderRail();

    expect(markup).not.toContain("Inbox");
    expect(markup).not.toContain("lucide-inbox");
  });

  it("shows under New chat with what waits to be decided, in both languages", () => {
    const markup = renderRail(undefined, { toDecide: 3 });

    expect(markup).toContain('aria-label="Inbox, 3 to decide"');
    expect(markup).toContain(">3</span>");
    expect(markup.indexOf("lucide-square-pen")).toBeLessThan(markup.indexOf("lucide-inbox"));
    expect(renderRail(undefined, { toDecide: 3 }, [], {}, "de")).toContain(
      'aria-label="Eingang, 3 zu entscheiden"'
    );
  });

  it("stays for a person with nothing to decide, without a count", () => {
    const markup = renderRail(undefined, { toDecide: 0 });

    expect(markup).toContain("Inbox");
    expect(markup).not.toContain("to decide");
    expect(markup).not.toContain("rounded-full bg-primary");
    expect(renderRail(undefined, { toDecide: 0 }, [], {}, "de")).toContain("Eingang");
  });

  it("keeps the count on the icon while the rail is collapsed", () => {
    const markup = renderRail(undefined, { toDecide: 12 }, [], { collapsed: true });

    expect(markup).toContain('aria-label="Inbox, 12 to decide"');
    expect(markup).toContain(">12</span>");
  });

  it("is the current row on the Inbox", () => {
    const markup = renderRail(undefined, { toDecide: 1 }, [], { view: "inbox" });

    expect(markup).toMatch(/<button[^>]*aria-current="true"[^>]*aria-label="Inbox, 1 to decide"/u);
  });
});

describe("workspace rail private conversation marker", () => {
  const conversation = {
    id: "conv_1",
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_shared",
    createdByUserId: "user_1",
    createdByExternalUserId: "external_1",
    visibility: "workspace",
    title: "Angebot Q3",
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    retainedUntil: "2027-08-01T10:00:00.000Z"
  } as ConversationListItem;

  it("marks a private conversation with a labelled lock", () => {
    const markup = renderRail(undefined, undefined, [
      conversation,
      { ...conversation, id: "conv_2", title: "Notizen", visibility: "private" }
    ]);

    expect(markup.match(/data-testid="conversation-row"/gu)).toHaveLength(2);
    expect(markup.match(/data-testid="conversation-private-marker"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-label="Private, only you can open it"');
  });

  it("leaves workspace-visible conversations unmarked", () => {
    const markup = renderRail(undefined, undefined, [conversation]);

    expect(markup).toContain("Angebot Q3");
    expect(markup).not.toContain("conversation-private-marker");
  });
});

describe("workspace rail run marker", () => {
  const conversation = {
    id: "conv_1",
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_shared",
    createdByUserId: "user_1",
    createdByExternalUserId: "external_1",
    visibility: "workspace",
    title: "Angebot Q3",
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    retainedUntil: "2027-08-01T10:00:00.000Z"
  } as ConversationListItem;
  const runWith = (status: NonNullable<ConversationListItem["activeRun"]>["status"]) => ({
    ...conversation,
    activeRun: {
      id: "run_1",
      conversationId: conversation.id,
      agentName: "assistant",
      status,
      startedAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      lastSequence: 3
    }
  });

  it("keeps the spinner for a run that works", () => {
    const markup = renderRail(undefined, undefined, [runWith("running")]);

    expect(markup).toContain('data-testid="conversation-running-indicator"');
    expect(markup).not.toContain("conversation-waits-for-you");
  });

  it.each<[LocaleCode, string]>([
    ["en", "Waits for you"],
    ["de", "Wartet auf dich"]
  ])("marks a run paused for a decision as waiting for the person (%s)", (locale, text) => {
    const markup = renderRail(undefined, undefined, [runWith("waiting_for_decision")], {}, locale);

    expect(markup).not.toContain("conversation-running-indicator");
    expect(markup).toMatch(
      new RegExp(`data-testid="conversation-waits-for-you"[^>]*>.*${text}</span>`, "u")
    );
  });
});

describe("workspace rail conversation rows", () => {
  const day = 24 * 60 * 60 * 1000;
  // Midday UTC, so the deletion dates below fall on the same calendar day in every time zone.
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  const retainedIn = (milliseconds: number) => new Date(now + milliseconds).toISOString();
  const conversation = {
    id: "conv_1",
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_shared",
    createdByUserId: "user_1",
    createdByExternalUserId: "external_1",
    visibility: "workspace",
    title: "Angebot Q3",
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    retainedUntil: retainedIn(3 * day)
  } as ConversationListItem;
  const later = {
    ...conversation,
    id: "conv_2",
    title: "Notizen",
    retainedUntil: retainedIn(30 * day)
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderRows(
    expireConversations: boolean,
    locale: LocaleCode = "en",
    conversations: ConversationListItem[] = [conversation, later],
    conversationDays = 30
  ): string {
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(WorkspaceRail, {
          config: {
            ...railConfig,
            retention: { expireConversations, conversationDays }
          } as SafeConfig,
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
          onDeleteConversation: noop
        })
      )
    );
  }

  /** What each row says about its deletion: the clock's short name and the row's description. */
  function retentionMarksOf(
    markup: string
  ): { button: string; clockName?: string; describedBy?: string; description?: string }[] {
    return markup
      .split('data-testid="conversation-row"')
      .slice(1)
      .map((row) => {
        const button = /<button[^>]*>/u.exec(row)?.[0] ?? "";
        const clock = /<span[^>]*data-testid="conversation-expiry-warning"[^>]*>/u.exec(row)?.[0];
        const describedBy = /aria-describedby="([^"]+)"/u.exec(button)?.[1];
        return {
          button,
          clockName: clock ? /aria-label="([^"]*)"/u.exec(clock)?.[1] : undefined,
          describedBy,
          description: describedBy
            ? row.split(`<span id="${describedBy}"`)[1]?.match(/^[^>]*>([^<]*)<\/span>/u)?.[1]
            : undefined
        };
      });
  }

  it("warns from exactly seven days before the retention date", () => {
    const [atBoundary, justOutside] = retentionMarksOf(
      renderRows(true, "en", [
        { ...conversation, retainedUntil: retainedIn(7 * day) },
        { ...later, retainedUntil: retainedIn(7 * day + 1) }
      ])
    );
    expect(atBoundary?.clockName).toBe("will be deleted soon");
    expect(atBoundary?.description).toBe("Will be deleted automatically on Thursday, October 15");
    expect(justOutside?.clockName).toBeUndefined();
    expect(justOutside?.description).toBeUndefined();
  });

  it("warns for at most half of a short retention period", () => {
    // A message moves the date a whole period ahead: it must leave the warning behind.
    const marked = (conversationDays: number, daysLeft: number) =>
      retentionMarksOf(
        renderRows(
          true,
          "en",
          [{ ...conversation, retainedUntil: retainedIn(daysLeft * day) }],
          conversationDays
        )
      )[0]?.clockName !== undefined;

    expect(marked(7, 7)).toBe(false);
    expect(marked(7, 3.5)).toBe(true);
    expect(marked(7, 3.5 + 1 / 24)).toBe(false);
    expect(marked(1, 1)).toBe(false);
    expect(marked(1, 0.5)).toBe(true);
    // From fourteen days on the window is the full seven days.
    expect(marked(14, 7)).toBe(true);
    expect(marked(90, 7)).toBe(true);
    expect(marked(90, 7.1)).toBe(false);
  });

  it.each<{ locale: LocaleCode; clockName: string; description: string }>([
    {
      locale: "en",
      clockName: "will be deleted soon",
      description: "Will be deleted automatically on Sunday, October 11"
    },
    {
      locale: "de",
      clockName: "wird bald gelöscht",
      description: "Wird am Sonntag, 11. Oktober automatisch gelöscht"
    }
  ])(
    "marks the near conversation with a clock and describes its deletion date ($locale)",
    ({ locale, clockName, description }) => {
      const markup = renderRows(true, locale);
      const [near, far] = retentionMarksOf(markup);

      expect(markup.match(/data-testid="conversation-expiry-warning"/gu)).toHaveLength(1);
      // The short name is all the row's name gains; the sentence is its description.
      expect(near?.clockName).toBe(clockName);
      expect(near?.description).toBe(description);
      expect(markup.split(description)).toHaveLength(2);
      // The clock alone carries the colour; the title stays as calm as its neighbours'.
      expect(markup).toMatch(
        /class="[^"]*text-warning[^"]*" data-testid="conversation-expiry-warning"/u
      );
      expect(near?.button).not.toContain("text-warning");
      // It stands in the row's label, which shows at rest, not in the slot of the row menu.
      const nearRow = markup.split('data-testid="conversation-row"')[1] ?? "";
      expect(nearRow).toContain("conversation-expiry-warning");
      expect(nearRow.indexOf("conversation-expiry-warning")).toBeLessThan(
        nearRow.indexOf("</button>")
      );
      expect(markup).toContain("lucide-clock");
      expect(markup).not.toContain("lucide-triangle-alert");
      expect(far).toEqual({ button: near?.button.replace(/ aria-describedby="[^"]+"/u, "") });
    }
  );

  it("gives each expiring row a description of its own", () => {
    const markup = renderRows(true, "en", [
      conversation,
      { ...later, retainedUntil: retainedIn(5 * day) }
    ]);
    const [first, second] = retentionMarksOf(markup);

    expect(first?.describedBy).toBeTruthy();
    expect(second?.describedBy).toBeTruthy();
    expect(first?.describedBy).not.toBe(second?.describedBy);
    for (const id of [first?.describedBy, second?.describedBy]) {
      expect(markup.split(`id="${id}"`)).toHaveLength(2);
    }
    expect(first?.description).toBe("Will be deleted automatically on Sunday, October 11");
    expect(second?.description).toBe("Will be deleted automatically on Tuesday, October 13");
  });

  it("keeps the hint open while the pointer or the keyboard holds it", () => {
    const openAfter = (...events: RetentionHintEvent[]) =>
      retentionHintOpen(events.reduce(retentionHintAfter, retentionHintClosed));

    expect(openAfter()).toBe(false);
    expect(openAfter("hover")).toBe(true);
    expect(openAfter("hover", "unhover")).toBe(false);
    expect(openAfter("focus")).toBe(true);
    expect(openAfter("focus", "blur")).toBe(false);
    // Keyboard focus on the row survives the pointer passing over the clock, and the reverse.
    expect(openAfter("focus", "hover", "unhover")).toBe(true);
    expect(openAfter("hover", "focus", "blur")).toBe(true);
    expect(openAfter("focus", "hover", "unhover", "blur")).toBe(false);
  });

  it("stays dismissed after Escape until the next hover or focus", () => {
    const openAfter = (...events: RetentionHintEvent[]) =>
      retentionHintOpen(events.reduce(retentionHintAfter, retentionHintClosed));

    expect(openAfter("focus", "hover", "dismiss")).toBe(false);
    expect(openAfter("focus", "hover", "dismiss", "unhover")).toBe(false);
    expect(openAfter("focus", "dismiss", "blur")).toBe(false);
    expect(openAfter("focus", "hover", "dismiss", "unhover", "hover")).toBe(true);
    expect(openAfter("hover", "dismiss", "focus")).toBe(true);
  });

  it.each<{ locale: LocaleCode; description: string }>([
    { locale: "en", description: "Will be deleted shortly" },
    { locale: "de", description: "Wird in Kürze gelöscht" }
  ])("does not name a date that has already passed ($locale)", ({ locale, description }) => {
    const [due, overdue] = retentionMarksOf(
      renderRows(true, locale, [
        { ...conversation, retainedUntil: retainedIn(0) },
        { ...later, retainedUntil: retainedIn(-3 * day) }
      ])
    );

    expect(due?.description).toBe(description);
    expect(overdue?.description).toBe(description);
  });

  it("does not warn on an instance that keeps conversations indefinitely", () => {
    const markup = renderRows(false);

    expect(markup).not.toContain("conversation-expiry-warning");
    expect(markup).not.toContain("aria-describedby");
  });

  it("shows the title without the last-updated date", () => {
    const markup = renderRows(false);

    expect(markup).toContain("Angebot Q3");
    expect(markup).not.toContain("Aug 1");
  });
});

// PRJ-5: the project whose page or chat is open unfolds in the rail to its five newest chats
// the person reads, with "All chats" to its page; "Recent" leaves those chats out.

function projectChat(id: string, minute: number, projectId?: string): ConversationListItem {
  const at = `2026-10-29T10:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    id,
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_team",
    createdByUserId: "user_1",
    createdByExternalUserId: "external_1",
    visibility: "workspace",
    title: `Chat ${id}`,
    status: "active",
    createdAt: at,
    updatedAt: at,
    retainedUntil: "2027-10-29T10:00:00.000Z",
    ...(projectId ? { projectId } : {})
  };
}

function railProject(id: string, title: string, audience: "workspace" | "private" = "workspace") {
  return {
    id,
    name: id,
    title,
    audience,
    collaborationWorkspaceId: "cw_team"
  } satisfies RailProject;
}

const nord = railProject("prj_nord", "Projekt Nord");
const sued = railProject("prj_sued", "Projekt Süd");

describe("the active project of the rail", () => {
  const projects = [nord, sued];

  it("is the project whose page is open", () => {
    expect(activeRailProject(projects, { projectName: "prj_sued" })).toBe(sued);
  });

  it("is the project of the open chat", () => {
    expect(activeRailProject(projects, { conversation: projectChat("c1", 1, "prj_nord") })).toBe(
      nord
    );
  });

  it("is none for a chat outside a project, or a project the rail does not list", () => {
    expect(activeRailProject(projects, { conversation: projectChat("c1", 1) })).toBeUndefined();
    expect(
      activeRailProject(projects, { conversation: projectChat("c1", 1, "prj_hidden") })
    ).toBeUndefined();
    expect(activeRailProject(projects, { projectName: "prj_hidden" })).toBeUndefined();
    expect(activeRailProject(undefined, { projectName: "prj_nord" })).toBeUndefined();
  });
});

describe("the chats under the active project's row", () => {
  it("are its five newest, newest first", () => {
    const fetched = [1, 2, 3, 4, 5, 6].map((minute) =>
      projectChat(`n${minute}`, minute, "prj_nord")
    );
    expect(railProjectChats("prj_nord", fetched, [], undefined).map(({ id }) => id)).toEqual([
      "n6",
      "n5",
      "n4",
      "n3",
      "n2"
    ]);
  });

  it("take a chat just started, and leave out one moved out or of another project", () => {
    const fetched = [projectChat("n1", 1, "prj_nord"), projectChat("n2", 2, "prj_nord")];
    const loaded = [
      projectChat("new", 9, "prj_nord"),
      // Moved out since the project's list was read.
      { ...projectChat("n2", 8), title: "Moved" },
      projectChat("s1", 7, "prj_sued"),
      projectChat("free", 6)
    ];
    expect(railProjectChats("prj_nord", fetched, loaded, undefined).map(({ id }) => id)).toEqual([
      "new",
      "n1"
    ]);
  });

  it("show a chat as the rail has it now", () => {
    const renamed = { ...projectChat("n1", 1, "prj_nord"), title: "Neu benannt", unread: true };
    expect(
      railProjectChats("prj_nord", [projectChat("n1", 1, "prj_nord")], [renamed], undefined)
    ).toEqual([renamed]);
  });

  it("keep the open chat after them when it is older", () => {
    const fetched = [1, 2, 3, 4, 5, 6].map((minute) =>
      projectChat(`n${minute}`, minute + 10, "prj_nord")
    );
    const open = projectChat("old", 0, "prj_nord");
    expect(railProjectChats("prj_nord", fetched, [], open).map(({ id }) => id)).toEqual([
      "n6",
      "n5",
      "n4",
      "n3",
      "n2",
      "old"
    ]);
  });
});

/** The rail of a workspace with projects, in German unless said otherwise. */
function renderProjectRail(overrides: Partial<RailProps>, locale: LocaleCode = "de"): string {
  return renderRail(
    undefined,
    undefined,
    [...(overrides.conversations ?? [])],
    { projects: true, ...overrides },
    locale
  );
}

/** The titles of the conversation rows in the markup, in order. */
function rows(html: string): string[] {
  return [...html.matchAll(/data-testid="conversation-row"[^]*?title="([^"]+)"/gu)].map(
    (match) => match[1] ?? ""
  );
}

/** The part of the markup from one test id to the next one given. */
function between(html: string, from: string, to: string): string {
  const start = html.indexOf(`data-testid="${from}"`);
  const end = html.indexOf(`data-testid="${to}"`, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("the Projects group", () => {
  it("is the only place of projects: a group whose label links to the page, with a plus", () => {
    const html = renderProjectRail({
      recentProjects: [nord, sued],
      projectsHref: "/w/ws_1/projects",
      onCreateProject: () => {}
    });
    expect(html).toContain('data-testid="rail-projects"');
    expect(html).toMatch(/<a [^>]*href="\/w\/ws_1\/projects"[^>]*>Projekte<\/a>/u);
    expect(html).toContain('aria-label="Projekt hinzufügen"');
    expect(html.match(/data-testid="rail-project"/gu)).toHaveLength(2);
    // The label is the way to the page; no row stands for it.
    expect(html).not.toContain("Alle Projekte");
    // The group stands before "Recent", and no section row names projects.
    expect(html.indexOf('data-testid="rail-projects"')).toBeLessThan(html.indexOf("Zuletzt"));
    expect(html.slice(0, html.indexOf('data-testid="rail-projects"'))).not.toContain("Projekte");
  });

  it("has no row to all projects, however many there are", () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => railProject(`prj_${n}`, `Projekt ${n}`));
    const html = renderProjectRail({ recentProjects: six, projectsHref: "/w/ws_1/projects" });
    expect(html.match(/data-testid="rail-project"/gu)).toHaveLength(5);
    expect(html).not.toContain("Alle Projekte");
    expect(html).toMatch(/<a [^>]*href="\/w\/ws_1\/projects"[^>]*>Projekte<\/a>/u);
  });

  it("shows the five used last alphabetically, so opening one never moves it", () => {
    const used = ["Zeta", "Äpfel", "Mitte", "Beta", "Omega", "Alt"].map((title) =>
      railProject(`prj_${title}`, title)
    );
    const names = (html: string) =>
      [...html.matchAll(/<[^>]*data-testid="rail-project"[^>]*>/gu)].map(
        (match) => /title="([^"]+)"/u.exec(match[0])?.[1] ?? ""
      );
    const html = renderProjectRail({ recentProjects: used });
    // The sixth, least recently used, is left out; the five are in German alphabetical order.
    expect(names(html)).toEqual(["Äpfel", "Beta", "Mitte", "Omega", "Zeta"]);
    // Using a shown one last moves it first in the order of use, not in the rail.
    const [, , , beta = nord, , alt = nord] = used;
    const reused = [beta, ...used.filter((project) => project !== beta)];
    expect(names(renderProjectRail({ recentProjects: reused }))).toEqual(names(html));
    // Using the sixth brings it in, at its alphabetical place.
    const brought = [alt, ...used.slice(0, 5)];
    expect(names(renderProjectRail({ recentProjects: brought }))).toEqual([
      "Alt",
      "Äpfel",
      "Beta",
      "Mitte",
      "Zeta"
    ]);
    // The open project used earlier stands among them in its alphabetical place.
    expect(
      names(
        renderProjectRail({
          recentProjects: used,
          activeProject: { id: "prj_Alt", chats: [] }
        })
      )
    ).toEqual(["Alt", "Äpfel", "Beta", "Mitte", "Omega", "Zeta"]);
  });

  it("shows its label and plus without a project", () => {
    const html = renderProjectRail({ recentProjects: [], onCreateProject: () => {} });
    expect(html).toContain('data-testid="rail-projects"');
    expect(html).toContain("Projekte");
    expect(html).toContain('aria-label="Projekt hinzufügen"');
    expect(html).not.toContain("Alle Projekte");
  });

  it("is absent while projects are off", () => {
    const html = renderProjectRail({ projects: false, recentProjects: [nord] });
    expect(html).not.toContain('data-testid="rail-projects"');
    expect(html).not.toContain("Projekte");
  });
});

describe("the rail with an active project", () => {
  const inNord = [projectChat("n2", 5, "prj_nord"), projectChat("n1", 4, "prj_nord")];
  const conversations = [projectChat("free", 6), ...inNord, projectChat("s1", 3, "prj_sued")];

  it("unfolds the active project's row to its chats and All chats, and no other", () => {
    const html = renderProjectRail({
      recentProjects: [nord, sued],
      activeProject: { id: "prj_nord", chats: inNord },
      conversations,
      selectedConversationId: "n1"
    });
    expect(html.match(/data-testid="rail-project-chats"/gu)).toHaveLength(1);
    expect(html).toContain('aria-label="Chats in Projekt Nord"');
    const group = between(html, "rail-project-chats", "rail-project-chats-all");
    expect(rows(group)).toEqual(["Chat n2", "Chat n1"]);
    expect(between(html, "rail-project-chats", "rail-project-chats-all")).not.toContain(
      "Projekt Süd"
    );
    expect(between(html, "rail-project-chats-all", "rail-project")).toContain("Alle Chats");
    // The rows under the project carry no project mark: the row above says it.
    expect(group).not.toContain('data-testid="conversation-project-marker"');
    expect(group).toMatch(/data-selected="true"[^]*Chat n1/u);
    // The chats stand right under their project's row, before the next project.
    expect(html.indexOf("Projekt Nord")).toBeLessThan(
      html.indexOf('data-testid="rail-project-chats"')
    );
    expect(html.indexOf('data-testid="rail-project-chats"')).toBeLessThan(
      html.indexOf("Projekt Süd")
    );
  });

  it("leaves those chats out of Recent, and keeps the rest there", () => {
    const html = renderProjectRail({
      recentProjects: [nord, sued],
      activeProject: { id: "prj_nord", chats: inNord },
      conversations
    });
    const recent = html.slice(html.indexOf("Zuletzt"));
    expect(recent).toContain("Zuletzt");
    expect(rows(recent)).toEqual(["Chat free", "Chat s1"]);
    expect(rows(html)).toEqual(["Chat n2", "Chat n1", "Chat free", "Chat s1"]);
  });

  it("says nothing is there when Recent holds only the project's chats", () => {
    const html = renderProjectRail({
      recentProjects: [nord],
      activeProject: { id: "prj_nord", chats: inNord },
      conversations: inNord
    });
    expect(html).toContain("Zuletzt");
    expect(html).not.toContain("Noch keine Unterhaltungen");
    expect(rows(html)).toEqual(["Chat n2", "Chat n1"]);
  });

  it("lists the active project among the recent ones when it was used earlier", () => {
    const projects = [1, 2, 3, 4, 5].map((n) => railProject(`prj_${n}`, `Projekt ${n}`));
    const older = railProject("prj_alt", "Projekt Alt");
    const html = renderProjectRail({
      recentProjects: [...projects, older],
      activeProject: { id: "prj_alt", chats: [projectChat("a1", 1, "prj_alt")] }
    });
    expect(html.match(/data-testid="rail-project"/gu)).toHaveLength(6);
    expect(html).toContain("Projekt Alt");
    expect(html.slice(html.indexOf('data-testid="rail-project-chats"'))).toContain("Chat a1");
  });

  it("unfolds nothing without an active project", () => {
    const html = renderProjectRail({ recentProjects: [nord, sued], conversations }, "en");
    expect(html).not.toContain('data-testid="rail-project-chats"');
    expect(rows(html)).toEqual(["Chat free", "Chat n2", "Chat n1", "Chat s1"]);
  });
});
