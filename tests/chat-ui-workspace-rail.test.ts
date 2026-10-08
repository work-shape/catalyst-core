import { createElement, type ReactNode } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import type { ConversationListItem, LocaleCode, SafeConfig } from "@vivd-catalyst/api-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { CollaborationWorkspaceSelector } from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-selector";
import { WorkspaceRail } from "../packages/chat-ui/src/workspace/workspace-rail";
import {
  RETENTION_WARNING_DAYS,
  retentionHintAfter,
  retentionHintClosed,
  retentionHintOpen,
  retentionWarningDate,
  type RetentionHintEvent
} from "../packages/chat-ui/src/conversation/conversation-button";
import { withoutDraftAttachment } from "../packages/chat-ui/src/conversation/draft-attachment-controller";
import { collaborationWorkspacesAvailableFor } from "../packages/chat-ui/src/chat-workspace";
import { workspaceSendBlockedReason } from "../packages/chat-ui/src/workspace/workspace-send-blocked-reason";
import {
  activeAgentNameFor,
  collaborationWorkspaceChromeVisibleFor,
  isAbandonedDraftConversation,
  workspaceScopedConfigFor
} from "../packages/chat-ui/src/workspace/workspace-chat-model";

const noop = () => undefined;

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
  const pending: Parameters<typeof workspaceSendBlockedReason>[0] = {
    attachmentBlockedReason: undefined,
    selectedConversationId: undefined,
    collaborationWorkspacesAvailable: true,
    activeCollaborationWorkspaceId: undefined,
    loading: true,
    loadFailed: false,
    locale
  };
  const cases: {
    name: string;
    input: Partial<Parameters<typeof workspaceSendBlockedReason>[0]>;
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
    expect(workspaceSendBlockedReason({ ...pending, ...input })).toBe(expected);
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

describe("workspace rail branding", () => {
  it("uses in-app navigation for the client logo", () => {
    const config = {
      ui: {
        clientName: "Musterfinanz",
        logoUrl: "/assets/musterfinanz.svg"
      }
    } as SafeConfig;

    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(WorkspaceRail, {
          config,
          collaborationWorkspaceSelector: null,
          conversations: [],
          selectedConversationId: undefined,
          canViewAdministration: false,
          view: "chat",
          creatingConversation: false,
          deletingConversation: false,
          userMenu: null,
          onToggleSidebar: noop,
          onViewChange: noop,
          onCreateConversation: noop,
          onSelectConversation: noop,
          onRenameConversation: async () => undefined,
          onDeleteConversation: noop
        })
      )
    );

    expect(markup).toContain('<button type="button"');
    expect(markup).not.toContain('href="/"');
    expect(markup).toContain('aria-label="Musterfinanz"');
    expect(markup).toContain('src="/assets/musterfinanz.svg"');
  });

  it("uses the customer initial when no logo is configured", () => {
    const config = {
      ui: {
        clientName: "Musterfinanz",
        title: "Musterfinanz Chat"
      }
    } as SafeConfig;

    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(WorkspaceRail, {
          config,
          collaborationWorkspaceSelector: null,
          conversations: [],
          selectedConversationId: undefined,
          canViewAdministration: false,
          view: "chat",
          creatingConversation: false,
          deletingConversation: false,
          userMenu: null,
          onToggleSidebar: noop,
          onViewChange: noop,
          onCreateConversation: noop,
          onSelectConversation: noop,
          onRenameConversation: async () => undefined,
          onDeleteConversation: noop
        })
      )
    );

    expect(markup).toContain(">F</span>");
    expect(markup).not.toContain("Vivd Catalyst");
    expect(markup).not.toContain("lucide-shield");
  });
});

const railConfig = {
  ui: { clientName: "Musterfinanz", title: "Musterfinanz Chat" }
} as SafeConfig;

function renderRail(
  collaborationWorkspaceSelector?: ReactNode,
  approvals?: { pendingCount: number },
  conversations: ConversationListItem[] = []
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "en" },
      createElement(WorkspaceRail, {
        config: railConfig,
        collaborationWorkspaceSelector,
        conversations,
        selectedConversationId: undefined,
        canViewAdministration: false,
        approvals,
        view: "chat",
        creatingConversation: false,
        deletingConversation: false,
        canMoveConversation: false,
        userMenu: null,
        onToggleSidebar: noop,
        onViewChange: noop,
        onCreateConversation: noop,
        onSelectConversation: noop,
        onRenameConversation: async () => undefined,
        onMoveConversation: noop,
        onDeleteConversation: noop
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

describe("workspace rail collapse handle", () => {
  it("stays hidden until the rail's right border is hovered or the handle is focused", () => {
    const markup = renderRail();
    const zone = markup.match(/<div class="([^"]*group\/rail-edge[^"]*)">(<button[^>]*>)/u);

    // A narrow zone over the full height of the border, from the md breakpoint up.
    expect(zone?.[1]).toContain("absolute inset-y-0 -right-1.5");
    expect(zone?.[1]).toContain("hidden w-3 md:block");
    const handle = zone?.[2] ?? "";
    expect(handle).toContain('aria-label="Collapse sidebar"');
    expect(handle).toContain('title="Collapse sidebar"');
    expect(handle).toContain("pointer-events-none");
    expect(handle).toContain(" opacity-0 ");
    expect(handle).toContain("group-hover/rail-edge:opacity-100");
    expect(handle).toContain("group-hover/rail-edge:pointer-events-auto");
    expect(handle).toContain("focus-visible:opacity-100");
    // The list's scrollbar ends left of the zone, which reaches 6px into the rail.
    expect(markup).toContain("-mr-3 ");
    expect(markup).not.toContain("-mr-4 ");
  });
});

describe("workspace rail collaboration workspace slot", () => {
  it("falls back to the pre-feature layout when no selector is supplied", () => {
    const markup = renderRail();

    expect(markup).toContain("grid-rows-[auto_auto_minmax(0,1fr)_auto]");
    expect(markup).not.toContain('aria-label="Switch workspace"');
    // The branding row and its own collapse toggle stay exactly as they were.
    expect(markup).toContain("Musterfinanz");
    expect(markup).toContain(">F</span>");
    expect(markup).toContain("absolute right-4 top-4");
    expect(markup).toContain('aria-label="Close sidebar"');
  });

  it("lets the selector replace the branding row for a first-party session", () => {
    const markup = renderRail(selector);

    expect(markup).toContain("grid-rows-[auto_auto_minmax(0,1fr)_auto]");
    expect(markup).toContain('aria-label="Switch workspace"');
    // Direction A: no standalone branding row — the client identity moved into
    // the selector popover, which is closed here.
    expect(markup).not.toContain("Musterfinanz");
    expect(markup).not.toContain(">F</span>");
    // The collapse toggle rides along in the selector row instead.
    expect(markup).toContain('aria-label="Close sidebar"');
    expect(markup).not.toContain("absolute right-4 top-4");
    expect(markup).toContain('aria-label="Collapse sidebar"');
  });
});

describe("collaboration workspace chrome feature flag", () => {
  function configWithCollaborationWorkspaces(enabled: boolean): SafeConfig {
    return {
      ...railConfig,
      features: { collaborationWorkspaces: { enabled } }
    } as SafeConfig;
  }

  // The chrome is composed from one boolean: the rail selector, the dialogs
  // panel and the conversation move action all read it.
  function firstPartyChromeVisible(enabled: boolean): boolean {
    return collaborationWorkspaceChromeVisibleFor({
      collaborationWorkspacesAvailable: true,
      config: configWithCollaborationWorkspaces(enabled)
    });
  }

  it("hides the workspace chrome from a first-party session while the feature is off", () => {
    expect(firstPartyChromeVisible(false)).toBe(false);

    const markup = renderRail(firstPartyChromeVisible(false) ? selector : undefined);

    expect(markup).toContain("grid-rows-[auto_auto_minmax(0,1fr)_auto]");
    expect(markup).not.toContain('aria-label="Switch workspace"');
    // Zero visual change for a non-workspace instance: branding row intact.
    expect(markup).toContain("Musterfinanz");
    // The rail itself keeps working: conversations, search and the new-chat
    // action stay exactly as they are without the feature.
    expect(markup).toContain('aria-label="Conversations"');
    expect(markup).toContain('aria-label="Search conversations"');
  });

  it("shows the workspace chrome once the feature is enabled", () => {
    expect(firstPartyChromeVisible(true)).toBe(true);

    const markup = renderRail(firstPartyChromeVisible(true) ? selector : undefined);

    expect(markup).toContain("grid-rows-[auto_auto_minmax(0,1fr)_auto]");
    expect(markup).toContain('aria-label="Switch workspace"');
    expect(markup).not.toContain("Musterfinanz");
  });

  it("keeps embedded sessions chrome-free whatever the feature flag says", () => {
    expect(
      collaborationWorkspaceChromeVisibleFor({
        collaborationWorkspacesAvailable: false,
        config: configWithCollaborationWorkspaces(true)
      })
    ).toBe(false);
  });

  it("withholds the chrome until the config has loaded", () => {
    expect(
      collaborationWorkspaceChromeVisibleFor({
        collaborationWorkspacesAvailable: true,
        config: undefined
      })
    ).toBe(false);
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
      workspaceAgents: { defaultAgentName: "contracts", agents: [agent("contracts")] }
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
    const result = scoped({ workspaceAgents: { agents: [] } });

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
    conversations: ConversationListItem[] = [conversation, later]
  ): string {
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale },
        createElement(WorkspaceRail, {
          config: { ...railConfig, retention: { expireConversations } } as SafeConfig,
          conversations,
          selectedConversationId: undefined,
          canViewAdministration: false,
          view: "chat",
          creatingConversation: false,
          deletingConversation: false,
          canMoveConversation: false,
          userMenu: null,
          onToggleSidebar: noop,
          onViewChange: noop,
          onCreateConversation: noop,
          onSelectConversation: noop,
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
    expect(RETENTION_WARNING_DAYS).toBe(7);
    expect(retentionWarningDate(retainedIn(7 * day), now)).toEqual(new Date(now + 7 * day));
    expect(retentionWarningDate(retainedIn(7 * day + 1), now)).toBeUndefined();
    expect(retentionWarningDate(retainedIn(-day), now)).toEqual(new Date(now - day));

    const [atBoundary, justOutside] = retentionMarksOf(
      renderRows(true, "en", [
        { ...conversation, retainedUntil: retainedIn(7 * day) },
        { ...later, retainedUntil: retainedIn(7 * day + 1) }
      ])
    );
    expect(atBoundary?.description).toBe("Will be deleted automatically on Thursday, October 15");
    expect(justOutside?.clockName).toBeUndefined();
    expect(justOutside?.description).toBeUndefined();
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
