// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  AdministeredUser,
  ApiUser,
  ConversationListItem,
  CreatePermissionGrantRequest,
  EffectivePermissions,
  StartConversationRunResponse
} from "@work-shape/catalyst-api-client";
import { grantOptions, GrantsTab } from "@work-shape/catalyst-chat-ui/access";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { required } from "./support/assertions";
import {
  GrantDialog,
  readLastDockConversation,
  storeLastDockConversation,
  useControlPlaneModel,
  useConversationListRefresh,
  useUnreadableDockConversation,
  useWorkspaceDock,
  workspaceQueryKeys
} from "./support/chat-ui";
import { TranslationProvider } from "./support/chat-ui/shared";
import { platformContext } from "./chat-ui-build-fixtures";
import { recordedApiClient } from "./support/recorded-api-client";

// Cover tests that replace browser specs: grantable rights, the dock, the rail's polling and
// the UI library route.

const assets = {
  app: {
    failed: false,
    items: [
      {
        id: "app-a",
        name: "Held App",
        resource: { kind: "app", name: "app-a", assetId: "app-a", workspaceId: "w-a" }
      },
      {
        id: "app-b",
        name: "Unheld App",
        resource: { kind: "app", name: "app-b", assetId: "app-b", workspaceId: "w-b" }
      }
    ]
  }
};
const workspaces = {
  failed: false,
  items: [
    { id: "w-a", name: "Held workspace" },
    { id: "w-b", name: "Unheld workspace" }
  ]
};
const label = (node: Element) =>
  document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent;

it.each(["asset", "workspace"] as const)(
  "renders only held verbs and places for an %s giver",
  async (scopeKind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const rights: EffectivePermissions = {
      holderActive: true,
      items: (scopeKind === "asset" ? ["app.read"] : ["app.read", "app.write"]).map((action) => ({
        action,
        effect: "allow",
        scopeKind,
        scopeId: scopeKind === "asset" ? "app-a" : "w-a",
        source: "grant"
      }))
    };
    const onGrant = vi.fn(async () => ({ added: 0, existing: 0 }));
    const button = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
        node.getAttribute("aria-label")?.startsWith(name)
      );
    try {
      await act(async () =>
        root.render(
          createElement(TranslationProvider, {
            locale: "en",
            children: createElement(
              UiRoot,
              { mode: "light", labels: uiLabelsEn },
              createElement(GrantDialog, {
                users: [],
                usersFailed: false,
                assets: [],
                assetsFailure: undefined,
                kindAssets: assets,
                options: grantOptions(rights, assets, workspaces),
                workspaces,
                onGrant,
                onClose: () => undefined
              })
            )
          })
        )
      );
      const groups = [...document.querySelectorAll('[role="radiogroup"]')];
      const levels = groups.find((group) => label(group) === "Level");
      expect(levels).toBeDefined();
      expect([...required(levels).querySelectorAll('[role="radio"]')].map(label)).toEqual(
        scopeKind === "asset" ? ["View"] : ["View", "Edit"]
      );
      const where = groups.find((group) => label(group) === "Where");
      if (scopeKind === "asset") expect(where).toBeUndefined();
      else
        expect([...required(where).querySelectorAll('[role="radio"]')].map(label)).toEqual([
          "In a shared workspace",
          "On one App"
        ]);
      const picker = button(scopeKind === "asset" ? "App:" : "Workspace:");
      expect(picker).toBeDefined();
      await act(async () => picker?.click());
      expect(
        [...document.querySelectorAll('[role="option"]')].map((node) => node.textContent)
      ).toEqual([scopeKind === "asset" ? "Held App" : "Held workspace"]);
      expect(onGrant).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
      await act(async () => vi.runOnlyPendingTimersAsync());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  }
);

/** Mounts `element` in English, runs `check`, and unmounts. */
async function mounted(element: ReactElement, check: () => Promise<void>): Promise<void> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(TranslationProvider, {
          locale: "en",
          children: createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element)
        })
      )
    );
    await check();
  } finally {
    act(() => root.unmount());
    host.remove();
    await act(async () => vi.runOnlyPendingTimersAsync());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

// Radix returns focus on a zero-delay timer when a picker closes. Finish that
// lifecycle before opening another picker, or the old focus return dismisses it.
async function chooseOption(name: string): Promise<void> {
  await act(async () => optionNamed(name).click());
  await act(async () => vi.runOnlyPendingTimersAsync());
}

const buttonNamed = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === name || node.getAttribute("aria-label")?.startsWith(name)
  );
const radioNamed = (name: string) =>
  required(
    [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (node) => label(node) === name
    )
  );
const optionNamed = (name: string) =>
  required(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent === name
    )
  );

// Replaces e2e/grantable-rights.spec.ts "a giver with users.manage alone cannot open a new-right
// dialog": a giver who holds no right to give, though the instance has Apps and workspaces to
// give rights on, finds New right disabled.
it("disables New right for a giver who holds no right to give", async () => {
  const onGrant = vi.fn(async () => ({ added: 0, existing: 0 }));
  await mounted(
    createElement(GrantsTab, {
      giver: { holderActive: true, items: [] },
      grants: [],
      loadFailed: false,
      onRetry: () => undefined,
      users: [],
      usersFailed: false,
      assets: [],
      assetsFailure: undefined,
      kindAssets: assets,
      workspaces,
      onGrant,
      onRevoke: async () => undefined
    }),
    async () => {
      expect(required(buttonNamed("New right")).disabled).toBe(true);
      expect(onGrant).not.toHaveBeenCalled();
    }
  );
});

// Replaces e2e/grantable-rights.spec.ts "the new-right dialog offers only the giver's workspace
// verbs and places" (its write): Edit brings View with it, so Create right writes both rows,
// View first, for the chosen person in the chosen workspace.
it("writes View and Edit, View first, when a workspace giver grants Edit", async () => {
  const recipient: AdministeredUser = {
    id: "user-r",
    clientInstanceId: "client-1",
    displayLabel: "Rita Recipient",
    roles: ["user"],
    permissionRefs: [],
    permissions: [],
    status: "active",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-01T10:00:00Z",
    identities: []
  };
  const rights: EffectivePermissions = {
    holderActive: true,
    items: ["app.read", "app.write"].map((action) => ({
      action,
      effect: "allow",
      scopeKind: "workspace",
      scopeId: "w-a",
      source: "grant"
    }))
  };
  const written: (readonly CreatePermissionGrantRequest[])[] = [];
  const onGrant = vi.fn(async (requests: readonly CreatePermissionGrantRequest[]) => {
    written.push(requests);
    return { added: requests.length, existing: 0 };
  });
  await mounted(
    createElement(GrantDialog, {
      users: [recipient],
      usersFailed: false,
      assets: [],
      assetsFailure: undefined,
      kindAssets: assets,
      options: grantOptions(rights, assets, workspaces),
      workspaces,
      onGrant,
      onClose: () => undefined
    }),
    async () => {
      await act(async () => required(buttonNamed("Person")).click());
      await chooseOption("Rita Recipient");
      await act(async () => radioNamed("In a shared workspace").click());
      await act(async () => required(buttonNamed("Workspace:")).click());
      await chooseOption("Held workspace");
      await act(async () => radioNamed("Edit").click());
      await act(async () => required(buttonNamed("Create right")).click());
      expect(written).toEqual([
        [
          expect.objectContaining({
            holderKind: "user",
            holderId: "user-r",
            action: "app.read",
            effect: "allow",
            scopeKind: "workspace",
            scopeId: "w-a"
          }),
          expect.objectContaining({
            holderKind: "user",
            holderId: "user-r",
            action: "app.write",
            effect: "allow",
            scopeKind: "workspace",
            scopeId: "w-a"
          })
        ]
      ]);
    }
  );
});

it("replaces an unreadable conversation with an empty open dock and forgets its identity", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const keepDraft = vi.fn();
  const routes = vi.fn();
  const gone = Object.assign(new Error("Not found"), { status: 404 });
  storeLastDockConversation("conv_foreign");
  let seen: ReturnType<typeof useWorkspaceDock>["dock"] | undefined;
  function Shell() {
    const [chat, setChat] = useState<string | undefined>("conv_foreign");
    const { dock } = useWorkspaceDock({
      route: { kind: "build-kind", assetKind: "agents" },
      chat,
      onRouteChange: (route, options) => {
        routes(route, options);
        setChat(options?.chat);
      }
    });
    useUnreadableDockConversation({ dock, docked: true, error: gone, keepDraft });
    seen = dock;
    return createElement("div", { "data-open": dock.open }, dock.conversationId ?? "New chat");
  }
  try {
    act(() => root.render(createElement(Shell)));
    expect(seen?.open).toBe(true);
    expect(seen?.conversationId).toBeUndefined();
    expect(seen?.last).toBeUndefined();
    expect(readLastDockConversation()).toBeUndefined();
    expect(host.textContent).toBe("New chat");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(keepDraft).toHaveBeenCalledExactlyOnceWith("conv_foreign");
    expect(routes).toHaveBeenCalledExactlyOnceWith(
      { kind: "build-kind", assetKind: "agents" },
      { chat: undefined, replace: true }
    );
  } finally {
    act(() => root.unmount());
    storeLastDockConversation(undefined);
    vi.unstubAllGlobals();
  }
});

it("does not poll the streamed conversation or an idle rail, and stops when its title arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const root = createRoot(document.createElement("div"));
  const refresh = vi.fn();
  const conversation: ConversationListItem = {
    id: "conv_1",
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_1",
    createdByUserId: "usr_1",
    createdByExternalUserId: "external_1",
    visibility: "private",
    status: "active",
    retainedUntil: "2027-10-24T10:00:00Z",
    people: [],
    title: "Temporary",
    createdAt: "2026-10-24T10:00:00Z",
    updatedAt: "2026-10-24T10:00:00Z",
    activeRun: {
      id: "run_1",
      conversationId: "conv_1",
      agentName: "assistant",
      status: "running",
      startedAt: "2026-10-24T10:00:00Z",
      updatedAt: "2026-10-24T10:00:00Z",
      lastSequence: 0
    }
  };
  let accepted: ReturnType<typeof useConversationListRefresh>["runAccepted"] | undefined;
  function Rail({
    rows,
    streamed
  }: {
    rows: ConversationListItem[];
    streamed: string | undefined;
  }) {
    accepted = useConversationListRefresh({
      enabled: true,
      conversations: rows,
      streamedConversationId: streamed,
      refresh
    }).runAccepted;
    return null;
  }
  const show = (rows: ConversationListItem[], streamed?: string) =>
    act(() => root.render(createElement(Rail, { rows, streamed })));
  const advance = async (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  try {
    show([conversation], conversation.id);
    await advance(10_000);
    expect(refresh).not.toHaveBeenCalled();
    // The stream ended while the list still reports its run: read only until it catches up.
    show([conversation]);
    await advance(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    const idle = { ...conversation, activeRun: undefined };
    show([idle]);
    await advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    const userMessage = {
      id: "msg_1",
      conversationId: idle.id,
      clientInstanceId: "client",
      role: "user" as const,
      text: "First turn",
      createdAt: idle.createdAt
    };
    const response: StartConversationRunResponse = {
      conversation: idle,
      userMessage,
      run: {
        ...required(conversation.activeRun),
        clientInstanceId: "client",
        ownerUserId: "usr_1",
        correlationId: "corr_1",
        inputMessageId: userMessage.id
      },
      thread: {
        conversation: idle,
        messages: [userMessage],
        userState: {
          clientInstanceId: "client",
          conversationId: idle.id,
          userId: "usr_1",
          updatedAt: idle.updatedAt
        },
        serverTime: idle.updatedAt
      },
      eventsUrl: "/runs/run_1/events"
    };
    act(() => accepted?.(response));
    expect(refresh).toHaveBeenCalledTimes(2);
    await advance(2_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    show([{ ...idle, title: "Learned title" }]);
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    // Workspace switch: stale title waiting must not poll the new workspace.
    show([]);
    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("opens the gallery route for an administrator and redirects a plain member without showing it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const queryClient = new QueryClient();
  const { client } = recordedApiClient(() => platformContext());
  const apiBaseUrl = "https://chat.example";
  queryClient.setQueryData(
    workspaceQueryKeys.platformContext(apiBaseUrl, "workspace"),
    platformContext()
  );
  const goToDefaultChat = vi.fn();
  const noop = () => undefined;
  const user: ApiUser = {
    id: "usr_admin",
    clientInstanceId: "client",
    externalUserId: "admin",
    displayLabel: "Admin",
    authSource: "standalone",
    roles: ["admin"],
    permissionRefs: [],
    permissions: ["users.manage"]
  };
  function Route({ viewer }: { viewer: ApiUser }) {
    const model = useControlPlaneModel({
      apiBaseUrl,
      authScope: "workspace",
      client,
      user: viewer,
      config: undefined,
      administration: undefined,
      collaborationWorkspaces: [],
      collaborationWorkspacesReady: true,
      settingsCollaborationWorkspace: undefined,
      selectSettingsCollaborationWorkspace: noop,
      activeCollaborationWorkspace: undefined,
      isAuthenticated: true,
      route: { kind: "ui-library" },
      view: "ui-library",
      supportedLocales: ["en"],
      activeLocale: "en",
      selectLocale: noop,
      showContextIndicator: false,
      setShowContextIndicator: noop,
      themePreference: "light",
      selectThemePreference: noop,
      goToDefaultChat,
      showRoute: noop,
      onAccountDeleted: noop,
      onCollaborationWorkspaceDeleted: noop,
      agentActions: {}
    });
    return model.showUiLibrary ? createElement("h1", null, "UI library") : null;
  }
  const render = async (viewer: ApiUser) =>
    act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Route, { viewer })
        )
      );
    });
  try {
    await render(user);
    expect(container.textContent).toBe("UI library");
    expect(goToDefaultChat).not.toHaveBeenCalled();
    await render({ ...user, id: "usr_member", roles: ["user"], permissions: [] });
    expect(container.querySelector("h1")).toBeNull();
    expect(goToDefaultChat).toHaveBeenCalledExactlyOnceWith({ replace: true });
  } finally {
    act(() => root.unmount());
    queryClient.clear();
    vi.unstubAllGlobals();
  }
});
