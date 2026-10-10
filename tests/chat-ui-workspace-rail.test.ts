import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import type { ConversationListItem, LocaleCode, SafeConfig } from "@vivd-catalyst/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationWorkspaceSelector } from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-selector";
import {
  railSections,
  shownRailSections,
  WorkspaceRail,
  type RailSection
} from "../packages/chat-ui/src/workspace/workspace-rail";
import {
  retentionHintAfter,
  retentionHintClosed,
  retentionHintOpen,
  type RetentionHintEvent
} from "../packages/chat-ui/src/conversation/conversation-button";
import { withoutDraftAttachment } from "../packages/chat-ui/src/conversation/draft-attachment-controller";
import { collaborationWorkspacesAvailableFor } from "../packages/chat-ui/src/chat-workspace";
import { workspaceSendBlock } from "../packages/chat-ui/src/workspace/workspace-send-block";
import {
  activeAgentNameFor,
  isAbandonedDraftConversation,
  workspaceScopedConfigFor
} from "../packages/chat-ui/src/workspace/workspace-chat-model";

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

describe("abandoned draft conversation", () => {
  const emptied = {
    conversationId: "conv_draft",
    selectedConversationId: "conv_draft",
    messagesLoaded: true,
    messageCount: 0,
    running: false
  };

  it("returns to the start page only when the open conversation holds nothing", () => {
    expect(isAbandonedDraftConversation(emptied)).toBe(true);
    expect(isAbandonedDraftConversation({ ...emptied, messageCount: 2 })).toBe(false);
    expect(isAbandonedDraftConversation({ ...emptied, messagesLoaded: false })).toBe(false);
    expect(isAbandonedDraftConversation({ ...emptied, running: true })).toBe(false);
    expect(isAbandonedDraftConversation({ ...emptied, selectedConversationId: "conv_other" })).toBe(
      false
    );
    expect(isAbandonedDraftConversation({ ...emptied, selectedConversationId: undefined })).toBe(
      false
    );
  });

  it("counts the draft attachments that remain after a removal", () => {
    const drafts = [{ id: "att_1" }, { id: "att_2" }];
    expect(withoutDraftAttachment(drafts, "att_1").map(({ id }) => id)).toEqual(["att_2"]);
    expect(withoutDraftAttachment(withoutDraftAttachment(drafts, "att_1"), "att_2")).toEqual([]);
  });
});

const railConfig = {
  ui: { clientName: "Musterfinanz", title: "Musterfinanz Chat" }
} as SafeConfig;

type RailProps = Parameters<typeof WorkspaceRail>[0];

function renderRail(
  collaborationWorkspaceSelector?: ReactNode,
  approvals?: { pendingCount: number },
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
        approvals,
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

    expect(markup).toContain(">FI</span>");
    expect(markup).toContain(">Musterfinanz</span>");
    expect(markup).not.toContain("Vivd Catalyst");
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

describe("workspace rail section rows", () => {
  const [chat] = railSections;
  if (!chat) {
    throw new Error("The rail has no Chat section.");
  }
  const second: RailSection = { ...chat, id: "second", label: "nav.settings", view: "approvals" };

  it("shows no Chat row while Chat is the only section", () => {
    expect(railSections.map((section) => section.id)).toEqual(["chat"]);
    expect(shownRailSections(railSections)).toEqual([]);

    const markup = renderRail();
    expect(markup).not.toContain(">Chat<");
    expect(markup).not.toContain("lucide-message-square");
  });

  it("shows the Chat row once a second section is registered", () => {
    const markup = renderRail(undefined, undefined, [], { sections: [...railSections, second] });

    expect(markup.match(/lucide-message-square/gu)).toHaveLength(2);
    // The row of the open view is the current one; the other is not.
    expect(markup).toMatch(/<button[^>]*aria-current="true"[^>]*>(?:(?!<\/button>).)*Chat/u);
    expect(markup.match(/aria-current="true"/gu)).toHaveLength(1);
    expect(markup).toContain("Settings");
  });
});

describe("workspace rail Build row and Settings gear", () => {
  it("shows Build above the account row only to a viewer who may open it", () => {
    expect(renderRail()).not.toContain("lucide-blocks");

    const markup = renderRail(undefined, undefined, [], { canViewBuild: true, view: "build" });
    expect(markup).toMatch(/<button[^>]*aria-current="true"[^>]*>(?:(?!<\/button>).)*Build/u);
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
      ...input
    });

  it("offers the active workspace's agents and default instead of the instance view", () => {
    const result = scoped({
      workspaceAgents: { defaultAgentName: "contracts", items: [agent("contracts")] }
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
    const result = scoped({ workspaceAgents: { items: [] } });

    expect(result.config?.agents).toEqual([]);
    expect(result).toMatchObject({ agentsLoading: false, workspaceScoped: true });
  });

  it("keeps the instance view for embedded sessions and the Personal Workspace", () => {
    expect(scoped({ collaborationWorkspacesAvailable: false }).config).toBe(instanceConfig);
    expect(scoped({ instanceViewApplies: true })).toEqual({
      config: instanceConfig,
      agentsLoading: false,
      workspaceScoped: false
    });
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
});

describe("workspace rail approvals entry", () => {
  it("stays hidden from users who may not review", () => {
    expect(renderRail()).not.toContain("approvals");
  });

  it("is offered to reviewers without administration access, with the pending count", () => {
    const markup = renderRail(undefined, { pendingCount: 3 });

    expect(markup).toContain('aria-label="Open approvals, 3 waiting"');
    expect(markup).toContain(">3</span>");
    expect(markup).not.toContain("lucide-shield");
  });

  it("drops the badge when nothing is pending", () => {
    const markup = renderRail(undefined, { pendingCount: 0 });

    expect(markup).toContain('aria-label="Open approvals"');
    expect(markup).not.toContain("rounded-full bg-primary");
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
