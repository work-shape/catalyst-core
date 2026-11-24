import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import type { ConversationListItem, LocaleCode, SafeConfig } from "@work-shape/catalyst-api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CollaborationWorkspaceSelector,
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
    retainedUntil: "2027-08-01T10:00:00.000Z",
    people: []
  };
}

describe("workspace send guard", () => {
  const loadingReason = "Loading workspaces…";
  const failedReason = "Workspaces could not be loaded.";
  const pending: Parameters<typeof workspaceSendBlock>[0] = {
    attachmentBlockedReason: undefined,
    selectedConversationId: undefined,
    collaborationWorkspacesAvailable: true,
    activeCollaborationWorkspaceId: undefined,
    loading: true,
    loadFailed: false,
    workspacesListed: false,
    locale: "en"
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
    { name: "failed", input: { loading: false, loadFailed: true }, expected: failedReason },
    { name: "empty", input: { loading: false }, expected: failedReason },
    {
      name: "listed before the page opens one",
      input: { loading: false, workspacesListed: true },
      expected: loadingReason
    },
    {
      name: "existing conversation after failure",
      input: { selectedConversationId: "conv_existing", loading: false, loadFailed: true },
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
      name: "attachment precedence after failure",
      input: {
        attachmentBlockedReason: "attachment blocked",
        loading: false,
        loadFailed: true
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

describe("workspace rail rows by right and state", () => {
  it("shows Studio above the account row only to a viewer who may open it", () => {
    expect(renderRail()).not.toContain("lucide-blocks");

    const markup = renderRail(undefined, undefined, [], { canViewBuild: true, view: "build" });
    expect(markup).toMatch(/<button[^>]*aria-current="true"[^>]*>(?:(?!<\/button>).)*Studio/u);
  });

  // Only the exact placeholder is translated; a title that starts with it is the person's own.
  it("shows the stored placeholder title in the reader's language, and a person's title as it is", () => {
    const markup = renderRail(
      undefined,
      undefined,
      [
        conversation("conv_new", "New conversation"),
        conversation("conv_named", "New conversation about Q3")
      ],
      {},
      "de"
    );
    expect(markup).toContain(">Neue Unterhaltung</span>");
    expect(markup).toContain(">New conversation about Q3</span>");
    expect(markup).not.toContain(">New conversation<");
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

  it("shows the Inbox row only to a person with an Inbox, with what waits to be decided", () => {
    expect(renderRail()).not.toContain("lucide-inbox");
    expect(renderRail(undefined, { toDecide: 3 })).toContain('aria-label="Inbox, 3 to decide"');
    expect(renderRail(undefined, { toDecide: 0 })).not.toContain("to decide");
  });

  it("marks only a private conversation as private", () => {
    const markup = renderRail(undefined, undefined, [
      conversation("conv_1", "Angebot Q3"),
      { ...conversation("conv_2", "Notizen"), visibility: "private" }
    ]);
    expect(markup.match(/data-testid="conversation-row"/gu)).toHaveLength(2);
    expect(markup.match(/data-testid="conversation-private-marker"/gu)).toHaveLength(1);
  });

  it("shows a working run as running and a run paused for a decision as waiting for the person", () => {
    const runWith = (status: NonNullable<ConversationListItem["activeRun"]>["status"]) => ({
      ...conversation("conv_1", "Angebot Q3"),
      activeRun: {
        id: "run_1",
        conversationId: "conv_1",
        agentName: "assistant",
        status,
        startedAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
        lastSequence: 3
      }
    });
    const running = renderRail(undefined, undefined, [runWith("running")]);
    expect(running).toContain('data-testid="conversation-running-indicator"');
    expect(running).not.toContain("conversation-waits-for-you");
    const waiting = renderRail(undefined, undefined, [runWith("waiting_for_decision")]);
    expect(waiting).not.toContain("conversation-running-indicator");
    expect(waiting).toContain('data-testid="conversation-waits-for-you"');
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
    retainedUntil: retainedIn(3 * day),
    people: []
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

  it("marks only the near conversation, with its deletion date as the row's description", () => {
    const [near, far] = retentionMarksOf(renderRows(true));
    expect(near?.clockName).toBeDefined();
    expect(near?.description).toBe("Will be deleted automatically on Sunday, October 11");
    expect(far?.clockName).toBeUndefined();
    expect(far?.description).toBeUndefined();
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

  it("does not name a date that has already passed", () => {
    const [due, overdue] = retentionMarksOf(
      renderRows(true, "en", [
        { ...conversation, retainedUntil: retainedIn(0) },
        { ...later, retainedUntil: retainedIn(-3 * day) }
      ])
    );
    expect(due?.description).toBe("Will be deleted shortly");
    expect(overdue?.description).toBe("Will be deleted shortly");
  });

  it("does not warn on an instance that keeps conversations indefinitely", () => {
    const markup = renderRows(false);

    expect(markup).not.toContain("conversation-expiry-warning");
    expect(markup).not.toContain("aria-describedby");
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
    people: [],
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

describe("the chats under an open project", () => {
  const ids = (fold: { chats: readonly ConversationListItem[] }) => fold.chats.map(({ id }) => id);

  it("are its five newest, newest first", () => {
    const fetched = [1, 2, 3, 4, 5, 6].map((minute) =>
      projectChat(`n${minute}`, minute, "prj_nord")
    );
    expect(ids(railProjectChats("prj_nord", fetched, [], undefined))).toEqual([
      "n6",
      "n5",
      "n4",
      "n3",
      "n2"
    ]);
  });

  it("offer Show more only where the project has more, and show the next ones in place", () => {
    const chats = (count: number) =>
      Array.from({ length: count }, (_, minute) => projectChat(`n${minute}`, minute, "prj_nord"));
    // Five and no more: nothing follows them.
    expect(railProjectChats("prj_nord", chats(5), [], undefined).more).toBe(false);
    // A sixth known, or a read that says more wait: Show more follows the five.
    expect(railProjectChats("prj_nord", chats(6), [], undefined).more).toBe(true);
    expect(railProjectChats("prj_nord", chats(5), [], undefined, 5, true).more).toBe(true);
    // Show more shows the next five under the first, and nothing follows the last.
    const shown = railProjectChats("prj_nord", chats(8), [], undefined, 10);
    expect(ids(shown)).toEqual(["n7", "n6", "n5", "n4", "n3", "n2", "n1", "n0"]);
    expect(shown.more).toBe(false);
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
    expect(ids(railProjectChats("prj_nord", fetched, loaded, undefined))).toEqual(["new", "n1"]);
  });

  it("show a chat as the rail has it now", () => {
    const renamed = { ...projectChat("n1", 1, "prj_nord"), title: "Neu benannt", unread: true };
    expect(
      railProjectChats("prj_nord", [projectChat("n1", 1, "prj_nord")], [renamed], undefined).chats
    ).toEqual([renamed]);
  });

  it("keep the open chat after them when it is older", () => {
    const fetched = [1, 2, 3, 4, 5, 6].map((minute) =>
      projectChat(`n${minute}`, minute + 10, "prj_nord")
    );
    const open = projectChat("old", 0, "prj_nord");
    expect(ids(railProjectChats("prj_nord", fetched, [], open))).toEqual([
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

/** The names of the projects' labels in the markup, in order. */
function projectNames(html: string): string[] {
  return [...html.matchAll(/<a [^>]*title="([^"]+)"[^>]*>/gu)].map((match) => match[1] ?? "");
}

/** The markup of one project's group: its label and what stands under it. */
function projectGroup(html: string, title: string): string {
  const groups = html.split('data-testid="rail-project"').slice(1);
  const group = groups.find((part) => part.includes(`title="${title}"`));
  expect(group).toBeDefined();
  const end = group?.indexOf("Zuletzt") ?? -1;
  return end === -1 ? (group ?? "") : (group ?? "").slice(0, end);
}

function fold(chats: readonly ConversationListItem[], more = false) {
  return { chats, more };
}
describe("the Projects group", () => {
  it("shows the five used last alphabetically, so opening one never moves it", () => {
    const used = ["Zeta", "Äpfel", "Mitte", "Beta", "Omega", "Alt"].map((title) =>
      railProject(`prj_${title}`, title)
    );
    const html = renderProjectRail({ recentProjects: used });
    // The sixth, least recently used, is left out; the five are in German alphabetical order.
    expect(projectNames(html)).toEqual(["Äpfel", "Beta", "Mitte", "Omega", "Zeta"]);
    // Using a shown one last moves it first in the order of use, not in the rail.
    const [, , , beta = nord, , alt = nord] = used;
    const reused = [beta, ...used.filter((project) => project !== beta)];
    expect(projectNames(renderProjectRail({ recentProjects: reused }))).toEqual(projectNames(html));
    // Using the sixth brings it in, at its alphabetical place.
    const brought = [alt, ...used.slice(0, 5)];
    expect(projectNames(renderProjectRail({ recentProjects: brought }))).toEqual([
      "Alt",
      "Äpfel",
      "Beta",
      "Mitte",
      "Zeta"
    ]);
    // The open project used earlier stands among them in its alphabetical place.
    expect(
      projectNames(renderProjectRail({ recentProjects: used, activeProjectId: "prj_Alt" }))
    ).toEqual(["Alt", "Äpfel", "Beta", "Mitte", "Omega", "Zeta"]);
  });

  it("is absent while projects are off", () => {
    const html = renderProjectRail({ projects: false, recentProjects: [nord] });
    expect(html).not.toContain('data-testid="rail-projects"');
    expect(html).not.toContain("Projekte");
  });
});

describe("the rail with open projects", () => {
  const inNord = [projectChat("n2", 5, "prj_nord"), projectChat("n1", 4, "prj_nord")];
  const inSued = [projectChat("s1", 3, "prj_sued")];
  const conversations = [projectChat("free", 6), ...inNord, ...inSued];

  it("opens several projects at once, each with its chats under its label", () => {
    const html = renderProjectRail({
      recentProjects: [nord, sued],
      openProjects: new Map([
        ["prj_nord", fold(inNord, true)],
        ["prj_sued", fold(inSued)]
      ]),
      conversations
    });
    expect(rows(projectGroup(html, "Projekt Nord"))).toEqual(["Chat n2", "Chat n1"]);
    expect(rows(projectGroup(html, "Projekt Süd"))).toEqual(["Chat s1"]);
    // Show more follows only the project that has more.
    expect(html.match(/data-testid="rail-project-chats-more"/gu)).toHaveLength(1);
    expect(projectGroup(html, "Projekt Nord")).toContain("rail-project-chats-more");
  });

  it("leaves the chats under open projects out of Recent, and keeps the rest there", () => {
    const html = renderProjectRail({
      recentProjects: [nord, sued],
      openProjects: new Map([["prj_nord", fold(inNord)]]),
      conversations
    });
    const recent = html.slice(html.indexOf("Zuletzt"));
    expect(rows(recent)).toEqual(["Chat free", "Chat s1"]);
    expect(rows(html)).toEqual(["Chat n2", "Chat n1", "Chat free", "Chat s1"]);
  });
});
