// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiClient,
  type ApiClient,
  type Conversation,
  type LocaleCode,
  type Message,
  type StartConversationRunResponse
} from "@work-shape/catalyst-api-client";
import {
  AgentTryHostProvider,
  conversationListCacheKey,
  recentConversations,
  DockedChat,
  acceptStartedRun,
  isTryRun,
  listedOpenThread,
  TryOpening,
  tryConversationGone,
  tryOnPage,
  tryRunLines,
  TryRunsLine,
  tryRunsOf,
  tryTurnOf,
  useAgentTry,
  useOfferAgentTry,
  useUnreadableDockConversation,
  useWorkspaceCacheActions,
  useWorkspaceDock,
  workspaceQueryKeys,
  type AgentTryTarget
} from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// TRY-1b3 (section 4.7c, checks 32 and 43): "Build | Try" in the dock's head on an agent's page.
// Each tab holds its own conversation; Try is the person's own Try conversation, which the
// instance opens; the address keeps the Build conversation; a Publish or a Discard deletes Try's
// conversation and Try opens a fresh one without the old messages.

const noop = () => undefined;
// The route type as the dock takes it.
type WorkspaceRoute = Parameters<typeof useWorkspaceDock>[0]["route"];
const AGENT_PAGE: WorkspaceRoute = { kind: "build-asset", assetKind: "agents", name: "quote_bot" };
const OTHER_PAGE: WorkspaceRoute = { kind: "build-kind", assetKind: "agents" };

type Dock = ReturnType<typeof useWorkspaceDock>["dock"];
type Try = ReturnType<typeof useAgentTry>;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const BASE = "https://chat.example";

function conversation(id: string): Conversation {
  return {
    id,
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_1",
    createdByUserId: "user_1",
    createdByExternalUserId: "external_1",
    visibility: "private",
    title: id,
    status: "active",
    createdAt: "2026-10-19T10:00:00.000Z",
    updatedAt: "2026-10-19T10:00:00.000Z",
    retainedUntil: "2027-10-19T10:00:00.000Z"
  };
}

/**
 * The product's client over a fake instance whose Try open answers the next of these
 * conversations; `opens` records the addresses it was asked.
 */
function tryClient(conversations: string[]) {
  const opens: string[] = [];
  const client = createApiClient({
    baseUrl: BASE,
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      opens.push(`${request.method} ${url.pathname}${url.search}`);
      const id = conversations.shift();
      if (id === undefined) {
        return Response.json({ error: { code: "INTERNAL", message: "down" } }, { status: 500 });
      }
      return Response.json({ conversation: conversation(id), preview: true });
    }
  });
  return { client, opens };
}

/** The call that opens Try for an agent, as the catalog names it. */
function tryOpenOf(agent: string): string {
  const { method, path } = apiOperations["agents.try.open"];
  return `${method} ${path.replace(":name", agent)}`;
}

/** What a run Try or Build started answers. */
function startedRun(
  id: string,
  preview?: NonNullable<ReturnType<typeof tryTurnOf>>
): StartConversationRunResponse {
  const started = conversation(id);
  const userMessage: Message = {
    id: `msg_${id}`,
    conversationId: id,
    clientInstanceId: "client",
    role: "user",
    text: "Hello",
    createdAt: "2026-10-19T10:00:01.000Z",
    ...(preview === undefined
      ? {}
      : {
          metadata: {
            agentRuntime: {
              version: 1,
              kind: "user_message",
              attachmentManifest: [],
              preview: { agentId: "agent_1", ...preview }
            }
          }
        })
  };
  return {
    conversation: started,
    userMessage,
    run: {
      id: `run_${id}`,
      clientInstanceId: "client",
      conversationId: id,
      ownerUserId: "user_1",
      inputMessageId: userMessage.id,
      agentName: "quote_bot",
      status: "running",
      startedAt: "2026-10-19T10:00:01.000Z",
      updatedAt: "2026-10-19T10:00:01.000Z",
      lastSequence: 0,
      correlationId: "corr_1"
    },
    thread: {
      conversation: started,
      messages: [userMessage],
      userState: {
        clientInstanceId: "client",
        conversationId: id,
        userId: "user_1",
        updatedAt: "2026-10-19T10:00:01.000Z"
      },
      serverTime: "2026-10-19T10:00:01.000Z"
    },
    eventsUrl: `runs/run_${id}/events`
  };
}

function Page({
  target,
  onOpen
}: {
  target: AgentTryTarget | undefined;
  onOpen(open?: () => void): void;
}) {
  onOpen(useOfferAgentTry(target));
  return null;
}

function mountShell(input: {
  client: ApiClient;
  route: WorkspaceRoute;
  chat: string | undefined;
  target: AgentTryTarget | undefined;
}) {
  const seen: { dock?: Dock; agentTry?: Try; open?: () => void } = {};
  const routeChanges: Array<{ route: WorkspaceRoute; chat?: string }> = [];
  function Shell({ route, chat, target }: Omit<typeof input, "client">): ReactNode {
    const { dock } = useWorkspaceDock({
      route,
      chat,
      onRouteChange: (next, options) => routeChanges.push({ route: next, chat: options?.chat })
    });
    const agentTry = useAgentTry({ client: input.client, dock });
    seen.dock = dock;
    seen.agentTry = agentTry;
    return createElement(
      AgentTryHostProvider,
      { value: agentTry.host },
      createElement(Page, { target, onOpen: (open) => (seen.open = open) })
    );
  }
  const render = (next: Omit<typeof input, "client">) =>
    act(() => root.render(createElement(Shell, next)));
  render(input);
  return { seen, routeChanges, render };
}

const target = (draftRevision: number | null): AgentTryTarget => ({
  agent: "quote_bot",
  title: "Quote bot",
  draftRevision
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Build and Try in the dock on an agent's page", () => {
  it("opens the person's Try conversation beside Build and keeps the Build address", async () => {
    const { client, opens } = tryClient(["conv_try"]);
    const shell = mountShell({ client, route: AGENT_PAGE, chat: "conv_build", target: target(4) });
    expect(shell.seen.dock?.tab).toBe("build");
    expect(shell.seen.agentTry?.view?.tab).toBe("build");

    act(() => shell.seen.agentTry?.view?.select("try"));
    // While the instance opens Try nothing can be sent, so no other conversation starts.
    expect(shell.seen.dock?.conversationId).toBeUndefined();
    expect(shell.seen.agentTry?.pane?.opening).toBe(true);
    await settle();

    expect(opens).toEqual([tryOpenOf("quote_bot")]);
    expect(shell.seen.dock?.tab).toBe("try");
    expect(shell.seen.dock?.conversationId).toBe("conv_try");
    expect(shell.seen.agentTry?.pane).toMatchObject({ agent: "quote_bot", opening: false });
    // The address still names the Build conversation: nothing navigated.
    expect(shell.routeChanges).toEqual([]);

    // The run Try's first message started leaves Try where it is.
    act(() => shell.seen.dock?.show("conv_try", { replace: true }));
    expect(shell.seen.dock?.tab).toBe("try");
    expect(shell.routeChanges).toEqual([]);

    act(() => shell.seen.agentTry?.view?.select("build"));
    expect(shell.seen.dock?.tab).toBe("build");
    expect(shell.seen.dock?.conversationId).toBe("conv_build");

    // Back in Try, the same conversation, without opening it again.
    act(() => shell.seen.agentTry?.view?.select("try"));
    expect(shell.seen.dock?.conversationId).toBe("conv_try");
    expect(opens).toHaveLength(1);
  });

  it("opens a fresh Try conversation when the draft was published or discarded", async () => {
    const { client, opens } = tryClient(["conv_try_1", "conv_try_2"]);
    const shell = mountShell({ client, route: AGENT_PAGE, chat: "conv_build", target: target(4) });
    act(() => shell.seen.agentTry?.view?.select("try"));
    await settle();
    expect(shell.seen.dock?.conversationId).toBe("conv_try_1");

    // The page reads no draft any more: the instance deleted Try's conversation with it.
    shell.render({ route: AGENT_PAGE, chat: "conv_build", target: target(null) });
    expect(shell.seen.dock?.tab).toBe("try");
    expect(shell.seen.dock?.conversationId).toBeUndefined();
    await settle();

    expect(opens).toHaveLength(2);
    expect(shell.seen.dock?.conversationId).toBe("conv_try_2");
    expect(shell.seen.agentTry?.view?.runs).toEqual({ source: "live" });
    expect(shell.routeChanges).toEqual([]);
  });

  it("is reachable on the agent's page without a Build conversation", async () => {
    const { client } = tryClient(["conv_try"]);
    const shell = mountShell({ client, route: AGENT_PAGE, chat: undefined, target: target(null) });
    expect(shell.seen.dock?.open).toBe(false);
    expect(shell.seen.open).toBeTypeOf("function");

    act(() => shell.seen.open?.());
    await settle();
    expect(shell.seen.dock).toMatchObject({ open: true, tab: "try", conversationId: "conv_try" });
    // With the dock open its head holds the tabs: the page offers no second way.
    expect(shell.seen.open).toBeUndefined();

    // Build without a conversation is the empty dock, open for one to start.
    act(() => shell.seen.agentTry?.view?.select("build"));
    expect(shell.seen.dock).toMatchObject({ open: true, tab: "build", conversationId: undefined });
  });

  it("shows Build on another page and offers nothing without the write right", async () => {
    const { client } = tryClient(["conv_try"]);
    const shell = mountShell({ client, route: AGENT_PAGE, chat: "conv_build", target: target(2) });
    act(() => shell.seen.agentTry?.view?.select("try"));
    await settle();
    shell.render({ route: OTHER_PAGE, chat: "conv_build", target: undefined });
    expect(shell.seen.dock?.tab).toBe("build");
    expect(shell.seen.dock?.conversationId).toBe("conv_build");
    expect(shell.seen.agentTry?.view).toBeUndefined();
    expect(shell.seen.open).toBeUndefined();
  });

  it("says Try could not be opened and opens it again", async () => {
    const { client, opens } = tryClient([]);
    const shell = mountShell({ client, route: AGENT_PAGE, chat: "conv_build", target: target(1) });
    act(() => shell.seen.agentTry?.view?.select("try"));
    await settle();
    expect(shell.seen.agentTry?.pane).toMatchObject({ opening: true, failed: true });
    act(() => shell.seen.agentTry?.pane?.retry());
    await settle();
    expect(opens).toHaveLength(2);
  });
});

describe("Try's conversation outside the lists", () => {
  it("keeps a run Try started out of the rail and the rest in it", () => {
    // The run's own record decides, never the tab the dock shows.
    expect(isTryRun(startedRun("conv_try", { revision: 2, source: "draft" }))).toBe(true);
    expect(isTryRun(startedRun("conv_try", { revision: 1, source: "live" }))).toBe(true);
    expect(isTryRun(startedRun("conv_build"))).toBe(false);

    const queryClient = new QueryClient();
    let cache: ReturnType<typeof useWorkspaceCacheActions> | undefined;
    function Cache() {
      cache = useWorkspaceCacheActions({
        apiBaseUrl: BASE,
        authScope: "workspace",
        client: tryClient([]).client,
        collaborationWorkspaceId: "cw_1",
        collaborationWorkspacesAvailable: true
      });
      return null;
    }
    act(() =>
      root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Cache)))
    );
    const key = conversationListCacheKey(BASE, "workspace", {
      collaborationWorkspaceId: "cw_1"
    });
    act(() => cache?.cacheRunStarted(startedRun("conv_try"), { listed: false }));
    expect(queryClient.getQueryData(key)).toBeUndefined();
    act(() => cache?.cacheRunStarted(startedRun("conv_build")));
    expect(queryClient.getQueryData(key)).toMatchObject({ conversations: [{ id: "conv_build" }] });
  });

  it.each([
    ["back to Build", AGENT_PAGE],
    ["to another page", OTHER_PAGE]
  ] as const)(
    "keeps a Try run out of Recent and the address when the person went %s before it was accepted",
    async (_moved, page) => {
      const { client } = tryClient(["conv_try"]);
      const queryClient = new QueryClient();
      const routeChanges: Array<{ route: WorkspaceRoute; chat?: string }> = [];
      const seen: {
        dock?: Dock;
        agentTry?: Try;
        cache?: ReturnType<typeof useWorkspaceCacheActions>;
      } = {};
      function Shell({ route }: { route: WorkspaceRoute }): ReactNode {
        const { dock } = useWorkspaceDock({
          route,
          chat: "conv_build",
          onRouteChange: (next, options) => routeChanges.push({ route: next, chat: options?.chat })
        });
        seen.dock = dock;
        seen.agentTry = useAgentTry({ client, dock });
        seen.cache = useWorkspaceCacheActions({
          apiBaseUrl: BASE,
          authScope: "workspace",
          client,
          collaborationWorkspaceId: "cw_1",
          collaborationWorkspacesAvailable: true
        });
        return createElement(
          AgentTryHostProvider,
          { value: seen.agentTry.host },
          createElement(Page, {
            target: route === AGENT_PAGE ? target(2) : undefined,
            onOpen: noop
          })
        );
      }
      const render = (route: WorkspaceRoute) =>
        act(() =>
          root.render(
            createElement(
              QueryClientProvider,
              { client: queryClient },
              createElement(Shell, { route })
            )
          )
        );
      render(AGENT_PAGE);
      act(() => seen.agentTry?.view?.select("try"));
      await settle();
      expect(seen.dock?.conversationId).toBe("conv_try");

      // The person sends in Try; the instance's answer is on its way.
      let accept: (response: StartConversationRunResponse) => void = noop;
      const accepted = new Promise<StartConversationRunResponse>((resolve) => (accept = resolve));
      if (page === AGENT_PAGE) act(() => seen.agentTry?.view?.select("build"));
      else render(page);
      expect(seen.dock?.tab).toBe("build");

      const listed = vi.fn();
      accept(startedRun("conv_try", { revision: 2, source: "draft" }));
      const response = await accepted;
      act(() =>
        acceptStartedRun(response, {
          cache: (inRail) => seen.cache?.cacheRunStarted(response, { listed: inRail }),
          // As the dock shows a conversation a run created.
          show: () => seen.dock?.show(response.conversation.id, { replace: true }),
          list: listed
        })
      );

      const rail = conversationListCacheKey(BASE, "workspace", {
        collaborationWorkspaceId: "cw_1"
      });
      expect(queryClient.getQueryData(rail)).toBeUndefined();
      expect(listed).not.toHaveBeenCalled();
      expect(routeChanges.filter((change) => change.chat === "conv_try")).toEqual([]);
      expect(seen.dock?.conversationId).toBe("conv_build");
      // Its own thread is kept for when Try shows again.
      expect(
        queryClient.getQueryData(workspaceQueryKeys.thread(BASE, "workspace", "conv_try"))
      ).toMatchObject({ conversation: { id: "conv_try" } });
    }
  );

  it("shows and lists a Build run as before", () => {
    const cache = vi.fn();
    const show = vi.fn();
    const list = vi.fn();
    acceptStartedRun(startedRun("conv_build"), { cache, show, list });
    expect(cache).toHaveBeenCalledWith(true);
    expect(show).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("leaves Try's open thread out of Recent, from the dock or the turns it records", async () => {
    const { client } = tryClient(["conv_try"]);
    const queryClient = new QueryClient();
    const seen: {
      dock?: Dock;
      agentTry?: Try;
      cache?: ReturnType<typeof useWorkspaceCacheActions>;
    } = {};
    function Shell(): ReactNode {
      const { dock } = useWorkspaceDock({
        route: AGENT_PAGE,
        chat: "conv_build",
        onRouteChange: noop
      });
      seen.dock = dock;
      seen.agentTry = useAgentTry({ client, dock });
      seen.cache = useWorkspaceCacheActions({
        apiBaseUrl: BASE,
        authScope: "workspace",
        client,
        collaborationWorkspaceId: "cw_1",
        collaborationWorkspacesAvailable: true
      });
      return createElement(
        AgentTryHostProvider,
        { value: seen.agentTry.host },
        createElement(Page, { target: target(2), onOpen: noop })
      );
    }
    act(() =>
      root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Shell)))
    );
    // The rail as the instance lists it: older pages hold the Build conversation, never Try's.
    const listed = [conversation("conv_other")];
    // As the shell builds Recent from the thread on screen (workspace-chat-model).
    const recent = (selected: string | undefined) => {
      const thread =
        selected === undefined
          ? undefined
          : queryClient.getQueryData<StartConversationRunResponse["thread"]>(
              workspaceQueryKeys.thread(BASE, "workspace", selected)
            );
      const open = seen.dock && listedOpenThread(thread, selected, seen.dock)?.conversation;
      return recentConversations(listed, open).map(({ id }) => id);
    };
    act(() => seen.cache?.cacheRunStarted(startedRun("conv_build")));
    act(() => seen.agentTry?.view?.select("try"));
    await settle();
    expect(seen.dock?.conversationId).toBe("conv_try");

    // Try's thread before its first turn: only the dock knows it is Try.
    act(() => {
      queryClient.setQueryData(workspaceQueryKeys.thread(BASE, "workspace", "conv_try"), {
        conversation: conversation("conv_try"),
        messages: []
      });
    });
    expect(recent(seen.dock?.conversationId)).toEqual(["conv_other"]);
    // Its first turn answered, the thread as the run start cached it, then read again.
    const tried = startedRun("conv_try", { revision: 2, source: "draft" });
    act(() => seen.cache?.cacheRunStarted(tried, { listed: false }));
    expect(recent(seen.dock?.conversationId)).toEqual(["conv_other"]);

    // Build's open conversation, older than the loaded rows, is still the current row.
    act(() => seen.agentTry?.view?.select("build"));
    expect(recent(seen.dock?.conversationId)).toEqual(["conv_build", "conv_other"]);
    // An address that names Try's conversation shows it outside Try: its turns say Try.
    expect(recent("conv_try")).toEqual(["conv_other"]);
  });

  it("opens Try afresh where its conversation is gone, instead of an empty Build", () => {
    const showTry = vi.fn();
    const show = vi.fn();
    const keepDraft = vi.fn();
    const gone = Object.assign(new Error("gone"), { status: 404 });
    function Unreadable({ tryAgent }: { tryAgent: string | undefined }) {
      useUnreadableDockConversation({
        dock: {
          conversationId: "conv_try",
          tab: tryAgent === undefined ? "build" : "try",
          tryAgent,
          open: true,
          inFront: true,
          openPage: noop,
          show,
          close: noop,
          forget: noop,
          reopen: noop,
          showPage: noop,
          showChat: noop,
          showTry,
          showBuild: noop
        },
        docked: true,
        error: gone,
        keepDraft
      });
      return null;
    }
    act(() => root.render(createElement(Unreadable, { tryAgent: "quote_bot" })));
    expect(showTry).toHaveBeenCalledWith("quote_bot", undefined);
    expect(show).not.toHaveBeenCalled();
    act(() => root.render(createElement(Unreadable, { tryAgent: undefined })));
    expect(show).toHaveBeenCalledWith(undefined, { replace: true });
  });
});

describe("the revision each Try turn ran", () => {
  const user = (id: string, preview?: NonNullable<ReturnType<typeof tryTurnOf>>): Message => ({
    id,
    conversationId: "conv_try",
    clientInstanceId: "client",
    role: "user",
    text: id,
    createdAt: "2026-10-19T10:00:00.000Z",
    metadata: {
      agentRuntime: {
        version: 1,
        kind: "user_message",
        attachmentManifest: [],
        ...(preview === undefined ? {} : { preview: { agentId: "agent_1", ...preview } })
      }
    }
  });
  const answer = (id: string): Message => ({ ...user(id), role: "assistant" });

  it("reads the revision a user message records", () => {
    expect(tryTurnOf(user("m1", { revision: 3, source: "draft" }))).toEqual({
      revision: 3,
      source: "draft"
    });
    expect(tryTurnOf(user("m1"))).toBeUndefined();
    expect(tryTurnOf({ metadata: undefined })).toBeUndefined();
  });

  it("marks only the turns another revision answered than the turn before", () => {
    const lines = tryRunLines([
      user("m1", { revision: 3, source: "draft" }),
      answer("a1"),
      user("m2", { revision: 3, source: "draft" }),
      answer("a2"),
      user("m3", { revision: 4, source: "draft" }),
      user("m4"),
      user("m5", { revision: 4, source: "draft" }),
      user("m6", { revision: 4, source: "live" })
    ]);
    expect([...lines]).toEqual([
      ["m3", { source: "draft", revision: 4 }],
      ["m6", { source: "live" }]
    ]);
  });

  it("knows the draft is gone only when one was read before", () => {
    expect(tryConversationGone(4, null)).toBe(true);
    expect(tryConversationGone(undefined, null)).toBe(false);
    expect(tryConversationGone(null, null)).toBe(false);
    expect(tryConversationGone(4, 5)).toBe(false);
    expect(tryRunsOf(undefined)).toBeUndefined();
    expect(tryRunsOf(null)).toEqual({ source: "live" });
    expect(tryRunsOf(7)).toEqual({ source: "draft", revision: 7 });
  });

  it("keeps Try on the page it was opened on", () => {
    const trying = { page: "/build/agents/quote_bot", agent: "quote_bot", conversationId: "c" };
    expect(tryOnPage(trying, "/build/agents/quote_bot")).toBe(trying);
    expect(tryOnPage(trying, "/build/agents")).toBeUndefined();
  });
});

describe.each<{
  locale: LocaleCode;
  build: string;
  tryTab: string;
  preview: string;
  live: string;
  draft: string;
  now: string;
  opening: string;
}>([
  {
    locale: "en",
    build: "Build",
    tryTab: "Try",
    preview: "Preview",
    live: "Running the published version",
    draft: "Running draft revision 4",
    now: "Now running draft revision 5",
    opening: "Opening Try…"
  },
  {
    locale: "de",
    build: "Bauen",
    tryTab: "Ausprobieren",
    preview: "Vorschau",
    live: "Läuft mit der veröffentlichten Version",
    draft: "Läuft mit Entwurfsrevision 4",
    now: "Läuft jetzt mit Entwurfsrevision 5",
    opening: "Ausprobieren wird geöffnet…"
  }
])("the dock's head on an agent's page in $locale", (text) => {
  const view = {
    mode: "dock" as const,
    layout: { over: false, width: 420, min: 380, max: 760, choose: noop, keep: noop },
    arrival: undefined,
    arrived: noop,
    measure: noop
  };
  const dock = (tab: Dock["tab"]): Dock => ({
    conversationId: tab === "try" ? "conv_try" : "conv_build",
    tab,
    tryAgent: tab === "try" ? "quote_bot" : undefined,
    open: true,
    inFront: true,
    openPage: noop,
    show: noop,
    close: noop,
    forget: noop,
    reopen: noop,
    showPage: noop,
    showChat: noop,
    showTry: noop,
    showBuild: noop
  });
  const head = (tab: Dock["tab"], runs: NonNullable<ReturnType<typeof tryRunsOf>>) =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: text.locale },
        createElement(DockedChat, {
          view,
          dock: dock(tab),
          title: "Change the quote bot",
          agent: undefined,
          agentTry: { tab, select: noop, title: "Quote bot", runs },
          onOpenFullChat: noop,
          children: null
        })
      )
    );

  it("marks Try as a preview of the agent and says what it runs", () => {
    const live = head("try", { source: "live" });
    expect(live).toContain(`>${text.build}</button>`);
    expect(live).toContain(`>${text.tryTab}</button>`);
    expect(live).toMatch(new RegExp(`aria-selected="true"[^>]*>${text.tryTab}</button>`));
    expect(live).toMatch(new RegExp(`aria-selected="false"[^>]*>${text.build}</button>`));
    expect(live).toContain('data-testid="dock-preview"');
    expect(live).toContain(`>${text.preview}</span>`);
    expect(live).toContain(text.live);
    expect(live).toContain("Quote bot");
    // A Try conversation is not opened on the chat route: it is hidden from every list.
    expect(live).not.toContain('aria-label="Open as full chat"');
    expect(head("try", { source: "draft", revision: 4 })).toContain(text.draft);
  });

  it("shows Build as the dock is on every page, with Try beside it", () => {
    const build = head("build", { source: "live" });
    expect(build).toContain('data-testid="dock-tabs"');
    expect(build).toContain(`>${text.tryTab}</button>`);
    expect(build).not.toContain('data-testid="dock-preview"');
    expect(build).not.toContain(text.live);
    expect(build).toContain("Change the quote bot");
  });

  it("says in the thread which revision answers from here on", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: text.locale },
        createElement(TryRunsLine, { runs: { source: "draft", revision: 5 } }),
        createElement(TryOpening, { failed: false, onRetry: noop })
      )
    );
    expect(markup).toContain(`role="separator" aria-label="${text.now}"`);
    expect(markup).toContain(text.opening);
  });
});
