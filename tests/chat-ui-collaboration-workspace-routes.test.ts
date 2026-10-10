import {
  ApiError,
  createApiClient,
  type Conversation,
  type ConversationListItem
} from "@vivd-catalyst/api-client";
import { apiOperations } from "@vivd-catalyst/api-contract";
import {
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId
} from "@vivd-catalyst/core";
import { describe, expect, it } from "vitest";
import { workspaceRouteFromPath, workspaceRouteNavigation } from "../packages/chat-ui/src/routes";
import {
  routeCollaborationWorkspaceId,
  workspaceRouteView
} from "../packages/chat-ui/src/workspace/workspace-route";
import { canonicalConversationRedirect } from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-model";
import { collaborationWorkspaceErrorKey } from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-errors";
import { collaborationWorkspacesAvailableFor } from "../packages/chat-ui/src/chat-workspace";
import {
  conversationListCacheKey,
  listCollaborationWorkspacesWithPersonal,
  cacheStartedRunThread,
  createWorkspaceQueryClient,
  readThreadAgain
} from "../packages/chat-ui/src/api/workspace-queries";
import { workspaceQueryKeys } from "../packages/chat-ui/src/api/workspace-query-keys";
import {
  RAIL_PAGE_SIZE,
  loadOlderRailConversations,
  railConversationsQueryOptions,
  refreshRailConversations,
  updateRailConversations,
  withFirstPage,
  withOlderPage,
  type RailConversations
} from "../packages/chat-ui/src/api/rail-conversations";
import { createTestFetch, createTestInstance } from "./support/test-instance";

describe("collaboration workspace routes", () => {
  it("reads the workspace home and its conversations from the path", () => {
    expect(workspaceRouteFromPath("/w/cw_1")).toEqual({
      kind: "new-conversation",
      collaborationWorkspaceId: "cw_1"
    });
    expect(workspaceRouteFromPath("/w/cw_1/c/conv_2")).toEqual({
      kind: "conversation",
      collaborationWorkspaceId: "cw_1",
      conversationId: "conv_2"
    });
    expect(workspaceRouteFromPath("/w/cw%201/c/conv%202")).toEqual({
      kind: "conversation",
      collaborationWorkspaceId: "cw 1",
      conversationId: "conv 2"
    });
  });

  it("keeps legacy conversation links resolvable and the root unresolved", () => {
    expect(workspaceRouteFromPath("/c/conv_2")).toEqual({
      kind: "legacy-conversation",
      conversationId: "conv_2"
    });
    expect(workspaceRouteFromPath("/")).toEqual({ kind: "collaboration-workspace-root" });
    expect(workspaceRouteFromPath("/w/")).toEqual({ kind: "collaboration-workspace-root" });
  });

  it("leaves workspace-independent routes alone", () => {
    expect(workspaceRouteFromPath("/settings")).toEqual({
      kind: "settings",
      group: "you",
      page: "profile"
    });
    expect(workspaceRouteFromPath("/admin/users")).toEqual({
      kind: "settings",
      group: "instance",
      page: "users"
    });
  });

  it("navigates back to the same canonical urls", () => {
    expect(
      workspaceRouteNavigation({ kind: "new-conversation", collaborationWorkspaceId: "cw_1" })
    ).toEqual({
      to: "/w/$collaborationWorkspaceId",
      params: { collaborationWorkspaceId: "cw_1" }
    });
    expect(
      workspaceRouteNavigation({
        kind: "conversation",
        collaborationWorkspaceId: "cw_1",
        conversationId: "conv_2"
      })
    ).toEqual({
      to: "/w/$collaborationWorkspaceId/c/$conversationId",
      params: { collaborationWorkspaceId: "cw_1", conversationId: "conv_2" }
    });
    expect(workspaceRouteNavigation({ kind: "collaboration-workspace-root" })).toEqual({ to: "/" });
  });

  it("treats every unresolved chat route as the chat view", () => {
    expect(workspaceRouteView({ kind: "collaboration-workspace-root" })).toBe("chat");
    expect(workspaceRouteView({ kind: "legacy-conversation", conversationId: "conv_2" })).toBe(
      "chat"
    );
    expect(routeCollaborationWorkspaceId({ kind: "collaboration-workspace-root" })).toBeUndefined();
    expect(
      routeCollaborationWorkspaceId({ kind: "new-conversation", collaborationWorkspaceId: "cw_1" })
    ).toBe("cw_1");
  });
});

describe("canonical conversation redirect", () => {
  it("resolves a legacy conversation link to the workspace that owns it", () => {
    expect(
      canonicalConversationRedirect({
        route: { kind: "legacy-conversation", conversationId: "conv_2" },
        loadedConversationCollaborationWorkspaceId: "cw_owner"
      })
    ).toEqual({ collaborationWorkspaceId: "cw_owner", conversationId: "conv_2" });
  });

  it("replaces a stale workspace segment left behind by a moved conversation", () => {
    expect(
      canonicalConversationRedirect({
        route: {
          kind: "conversation",
          collaborationWorkspaceId: "cw_stale",
          conversationId: "conv_2"
        },
        loadedConversationCollaborationWorkspaceId: "cw_owner"
      })
    ).toEqual({ collaborationWorkspaceId: "cw_owner", conversationId: "conv_2" });
  });

  it("leaves a conversation already on its canonical url alone", () => {
    expect(
      canonicalConversationRedirect({
        route: {
          kind: "conversation",
          collaborationWorkspaceId: "cw_owner",
          conversationId: "conv_2"
        },
        loadedConversationCollaborationWorkspaceId: "cw_owner"
      })
    ).toBeUndefined();
  });

  it("waits for the thread instead of guessing while it loads", () => {
    expect(
      canonicalConversationRedirect({
        route: {
          kind: "conversation",
          collaborationWorkspaceId: "cw_stale",
          conversationId: "conv_2"
        },
        loadedConversationCollaborationWorkspaceId: undefined
      })
    ).toBeUndefined();
    expect(
      canonicalConversationRedirect({
        route: { kind: "legacy-conversation", conversationId: "conv_2" },
        loadedConversationCollaborationWorkspaceId: undefined
      })
    ).toBeUndefined();
  });

  it("never redirects a route that names no conversation", () => {
    expect(
      canonicalConversationRedirect({
        route: { kind: "new-conversation", collaborationWorkspaceId: "cw_stale" },
        loadedConversationCollaborationWorkspaceId: "cw_owner"
      })
    ).toBeUndefined();
    expect(
      canonicalConversationRedirect({
        route: { kind: "collaboration-workspace-root" },
        loadedConversationCollaborationWorkspaceId: "cw_owner"
      })
    ).toBeUndefined();
  });
});

describe("conversation list cache targeting", () => {
  const apiBaseUrl = "https://example.test";
  const authScope = "standalone";

  function conversation(collaborationWorkspaceId: string): Conversation {
    return {
      id: "conv_2",
      clientInstanceId: "client_1",
      collaborationWorkspaceId,
      visibility: "workspace",
      createdByUserId: "user_1",
      createdByExternalUserId: "external_1",
      title: "Moved conversation",
      status: "active",
      createdAt: "2026-08-31T10:00:00.000Z",
      updatedAt: "2026-08-31T10:00:00.000Z",
      retainedUntil: "2026-09-30T10:00:00.000Z"
    };
  }

  it("keys a list write by the conversation's own workspace, not the routed one", () => {
    // The link that is open still names `cw_stale`; the conversation moved to
    // `cw_owner`, and the cache write has to follow the conversation.
    expect(conversationListCacheKey(apiBaseUrl, authScope, conversation("cw_owner"))).toEqual(
      workspaceQueryKeys.conversations(apiBaseUrl, authScope, "cw_owner")
    );
    expect(conversationListCacheKey(apiBaseUrl, authScope, conversation("cw_owner"))).not.toEqual(
      workspaceQueryKeys.conversations(apiBaseUrl, authScope, "cw_stale")
    );
  });

  it("separates the lists of two workspaces", () => {
    expect(conversationListCacheKey(apiBaseUrl, authScope, conversation("cw_a"))).not.toEqual(
      conversationListCacheKey(apiBaseUrl, authScope, conversation("cw_b"))
    );
  });
});

describe("personal workspace on the workspace list", () => {
  const client = (kinds: string[][]) => {
    const calls: string[] = [];
    const pages = [...kinds];
    return {
      calls,
      list: async () => {
        calls.push("list");
        return { items: (pages.shift() ?? []).map((kind) => ({ kind })) };
      },
      ensure_personal: async () => {
        calls.push("ensure_personal");
      }
    };
  };

  it("only reads when the list already has the Personal Workspace", async () => {
    const api = client([["personal", "shared"]]);
    const listed = await listCollaborationWorkspacesWithPersonal(api);
    expect(listed).toEqual([{ kind: "personal" }, { kind: "shared" }]);
    expect(api.calls).toEqual(["list"]);
  });

  it("creates the Personal Workspace once when the list has none, then reads again", async () => {
    const api = client([["shared"], ["personal", "shared"]]);
    const listed = await listCollaborationWorkspacesWithPersonal(api);
    expect(listed).toEqual([{ kind: "personal" }, { kind: "shared" }]);
    expect(api.calls).toEqual(["list", "ensure_personal", "list"]);
  });
});

describe("embedded auth mode", () => {
  it("keeps collaboration workspaces first-party only", () => {
    expect(collaborationWorkspacesAvailableFor({})).toBe(true);
    expect(collaborationWorkspacesAvailableFor({ token: "hmac-session-token" })).toBe(false);
    expect(collaborationWorkspacesAvailableFor({ getToken: () => "hmac-session-token" })).toBe(
      false
    );
  });
});

describe("collaboration workspace error copy", () => {
  const apiError = (status: number) => new ApiError(status, "Server prose", undefined);

  it("explains the missing invitation flow for an unusable member email", () => {
    expect(collaborationWorkspaceErrorKey("addMember", apiError(422))).toBe(
      "collaborationWorkspaceErrorInvitationsUnavailable"
    );
    expect(collaborationWorkspaceErrorKey("addMember", apiError(409))).toBe(
      "collaborationWorkspaceErrorAlreadyMember"
    );
  });

  it("explains a move rejected for making someone else's conversation private", () => {
    expect(collaborationWorkspaceErrorKey("moveConversation", apiError(422))).toBe(
      "collaborationWorkspaceErrorMovePrivateCreatorOnly"
    );
    expect(collaborationWorkspaceErrorKey("moveConversation", apiError(400))).toBe(
      "collaborationWorkspaceErrorInvalid"
    );
  });

  it("maps the last-owner conflict for every membership removal path", () => {
    expect(collaborationWorkspaceErrorKey("leave", apiError(409))).toBe(
      "collaborationWorkspaceErrorLastOwner"
    );
    expect(collaborationWorkspaceErrorKey("removeMember", apiError(409))).toBe(
      "collaborationWorkspaceErrorLastOwner"
    );
    expect(collaborationWorkspaceErrorKey("changeRole", apiError(409))).toBe(
      "collaborationWorkspaceErrorLastOwner"
    );
  });

  it("separates gone requests from gone workspaces", () => {
    expect(collaborationWorkspaceErrorKey("approveRequest", apiError(404))).toBe(
      "collaborationWorkspaceErrorRequestGone"
    );
    expect(collaborationWorkspaceErrorKey("update", apiError(404))).toBe(
      "collaborationWorkspaceErrorNotFound"
    );
  });

  it("falls back without matching server prose", () => {
    expect(collaborationWorkspaceErrorKey("create", apiError(403))).toBe(
      "collaborationWorkspaceErrorNotPermitted"
    );
    expect(collaborationWorkspaceErrorKey("requestAccess", apiError(409))).toBe(
      "collaborationWorkspaceErrorRequestPending"
    );
    expect(collaborationWorkspaceErrorKey("create", apiError(500))).toBe(
      "collaborationWorkspaceErrorUnexpected"
    );
    expect(collaborationWorkspaceErrorKey("create", new Error("offline"))).toBe(
      "collaborationWorkspaceErrorUnexpected"
    );
  });
});

interface Thread {
  run: string;
}

/** A read of the thread whose answer the test sends when it chooses to. */
function slowRead(): { read(): Promise<Thread>; answer(thread: Thread): void } {
  let answer: (thread: Thread) => void = () => undefined;
  const pending = new Promise<Thread>((resolve) => {
    answer = resolve;
  });
  return { read: () => pending, answer: (thread) => answer(thread) };
}

describe("the cached thread of a conversation", () => {
  const threadKey = workspaceQueryKeys.thread("http://api.test", "user", "conversation-1");
  const beforeTheRun: Thread = { run: "first, as the instance last reported it" };
  const ofTheNewRun: Thread = { run: "second, just started" };

  it("keeps the thread of a run that started while a re-read was on its way", async () => {
    const queryClient = createWorkspaceQueryClient();
    const instance = slowRead();

    const reread = readThreadAgain(queryClient, threadKey, instance.read);
    cacheStartedRunThread(queryClient, threadKey, ofTheNewRun);
    instance.answer(beforeTheRun);

    // The overtaken re-read answers with the run's thread and leaves the cache alone.
    await expect(reread).resolves.toEqual(ofTheNewRun);
    expect(queryClient.getQueryData(threadKey)).toEqual(ofTheNewRun);
  });

  it("takes the answer of a re-read that nothing overtook, and passes its failure on", async () => {
    const queryClient = createWorkspaceQueryClient();
    cacheStartedRunThread(queryClient, threadKey, ofTheNewRun);

    const later: Thread = { run: "second, ended" };
    await expect(readThreadAgain(queryClient, threadKey, async () => later)).resolves.toEqual(
      later
    );
    expect(queryClient.getQueryData(threadKey)).toEqual(later);

    const refused = new Error("refused");
    await expect(
      readThreadAgain(queryClient, threadKey, async () => {
        throw refused;
      })
    ).rejects.toBe(refused);
  });
});

// Each of these fails without the paged rail: it kept a plain array of one page, so a reading
// of the first page replaced whatever was loaded, and there was no page after it.
describe("the rail's loaded conversations", () => {
  const at = (minute: number) => `2026-08-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const row = (id: string, minute: number): ConversationListItem => ({
    id,
    clientInstanceId: "client",
    collaborationWorkspaceId: "cw_shared",
    createdByUserId: "user_1",
    createdByExternalUserId: "external_1",
    visibility: "workspace",
    title: `Titel ${id}`,
    status: "active",
    createdAt: at(minute),
    updatedAt: at(minute),
    retainedUntil: "2027-08-01T10:00:00.000Z"
  });
  const ids = (loaded: RailConversations | undefined) => loaded?.conversations.map(({ id }) => id);

  it("takes the first page as it is while nothing older is loaded or the list ends on it", () => {
    const page = { items: [row("b", 2), row("a", 1)], nextCursor: "after-a" };

    expect(withFirstPage(undefined, page)).toEqual({
      conversations: page.items,
      nextCursor: "after-a"
    });
    // The whole list fits the page: rows that were loaded and are gone do not stay.
    const loaded = { conversations: [row("b", 2), row("a", 1), row("z", 0)], nextCursor: "x" };
    expect(withFirstPage(loaded, { items: [row("b", 2)] })).toEqual({
      conversations: [row("b", 2)],
      nextCursor: undefined
    });
  });

  it("keeps the older rows a person loaded when the first page is read again", () => {
    const loaded = {
      conversations: [row("d", 4), row("c", 3), row("b", 2), row("a", 1)],
      nextCursor: "after-a"
    };
    // "d" was deleted elsewhere, "c" got a message and moved up, "e" is new.
    const again = withFirstPage(loaded, {
      items: [row("e", 6), row("c", 5), row("b", 2)],
      nextCursor: "after-b"
    });

    // What the first page covers is as the server has it; "a" is older than it and stays.
    expect(ids(again)).toEqual(["e", "c", "b", "a"]);
    // The place the next older page starts at is still the one after the loaded rows.
    expect(again.nextCursor).toBe("after-a");
  });

  it("keeps a row that a new conversation pushed off the first page", () => {
    const loaded = { conversations: [row("c", 3), row("b", 2)], nextCursor: "after-b" };
    const again = withFirstPage(loaded, {
      items: [row("d", 4), row("c", 3)],
      nextCursor: "after-c"
    });

    expect(ids(again)).toEqual(["d", "c", "b"]);
    expect(again.nextCursor).toBe("after-b");
  });

  it("adds an older page once, and drops one asked for from a place the list has left", () => {
    const loaded = { conversations: [row("c", 3), row("b", 2)], nextCursor: "after-b" };
    // "b" moved between the two requests and is on both pages.
    const page = { items: [row("b", 2), row("a", 1)] };

    const added = withOlderPage(loaded, "after-b", page);
    expect(ids(added)).toEqual(["c", "b", "a"]);
    expect(added?.nextCursor).toBeUndefined();
    expect(withOlderPage(loaded, "after-c", page)).toBe(loaded);
    expect(withOlderPage(undefined, "after-b", page)).toBeUndefined();
  });
});

// Fails without the change: the rail read every page of the list (200 a page), which is 5
// requests at 1,000 conversations and 50 at 10,000, and what refreshed it during a run read
// them all again.
describe("the rail's requests in a workspace of 1,000 conversations", () => {
  const apiBaseUrl = "https://catalyst.test";
  const authScope = "standalone";
  const seeded = 1_000;

  it("costs one request to load, one per further page and one per refresh during a run", async () => {
    const instance = await createTestInstance();
    const created = await instance.call("conversations.create", {
      payload: { title: "Conversation 0" }
    });
    expect(created.statusCode).toBe(200);
    const first = created.json<ConversationListItem>();
    const clientInstanceId = asClientInstanceId(first.clientInstanceId);
    const collaborationWorkspaceId = asCollaborationWorkspaceId(first.collaborationWorkspaceId);
    const { conversations } = instance.stores;
    // A conversation is listed once it holds a message.
    const seedMessage = (conversationId: string) =>
      conversations.appendMessage({
        clientInstanceId,
        conversationId: asConversationId(conversationId),
        role: "user",
        text: "First message"
      });
    const seedOne = async (index: number) => {
      const stored = await conversations.createConversation({
        clientInstanceId,
        collaborationWorkspaceId,
        createdByUserId: first.createdByUserId,
        createdByExternalUserId: first.createdByExternalUserId,
        visibility: "workspace",
        title: `Conversation ${index}`,
        retainedUntil: first.retainedUntil
      });
      await seedMessage(stored.id);
    };
    const atOnce = 20;
    await seedMessage(first.id);
    for (let done = 1; done < seeded; done += atOnce) {
      await Promise.all(
        Array.from({ length: Math.min(atOnce, seeded - done) }, (_, index) => seedOne(done + index))
      );
    }

    const testFetch = createTestFetch(instance);
    const listRequests: URLSearchParams[] = [];
    const client = createApiClient({
      baseUrl: apiBaseUrl,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (
          request.method === apiOperations["conversations.list"].method &&
          url.pathname === apiOperations["conversations.list"].path
        ) {
          listRequests.push(url.searchParams);
        }
        return testFetch(request);
      }
    });
    const source = {
      apiBaseUrl,
      authScope,
      client,
      collaborationWorkspaceId,
      collaborationWorkspacesAvailable: true,
      enabled: true
    };
    const rail = railConversationsQueryOptions(source);
    const queryClient = createWorkspaceQueryClient();
    const loaded = () => queryClient.getQueryData<RailConversations>(rail.queryKey);

    // Load: one request for one page.
    await queryClient.fetchQuery(rail);
    expect(listRequests).toHaveLength(1);
    expect(listRequests[0]?.get("limit")).toBe(String(RAIL_PAGE_SIZE));
    expect(listRequests[0]?.get("cursor")).toBeNull();
    expect(loaded()?.conversations).toHaveLength(RAIL_PAGE_SIZE);
    expect(loaded()?.nextCursor).toBeDefined();

    // Scrolling: every further page is one request, from where the last one ended.
    const furtherPages = 3;
    for (let page = 1; page <= furtherPages; page += 1) {
      const cursor = loaded()?.nextCursor;
      await loadOlderRailConversations(queryClient, source);
      expect(listRequests).toHaveLength(1 + page);
      expect(listRequests.at(-1)?.get("cursor")).toBe(cursor);
      expect(listRequests.at(-1)?.get("limit")).toBe(String(RAIL_PAGE_SIZE));
      expect(loaded()?.conversations).toHaveLength(RAIL_PAGE_SIZE * (page + 1));
    }
    const rows = loaded()?.conversations.map(({ id }) => id) ?? [];
    expect(new Set(rows).size).toBe(rows.length);

    // During a run: a refresh reads the first page alone, and the loaded pages stay.
    const before = listRequests.length;
    const refreshes = 3;
    for (let refresh = 0; refresh < refreshes; refresh += 1) {
      await refreshRailConversations(queryClient, rail.queryKey);
    }
    expect(listRequests).toHaveLength(before + refreshes);
    for (const request of listRequests.slice(before)) {
      expect(request.get("cursor")).toBeNull();
      expect(request.get("limit")).toBe(String(RAIL_PAGE_SIZE));
    }
    expect(loaded()?.conversations.map(({ id }) => id)).toEqual(rows);

    // Two refreshes at once wait for one answer instead of asking twice.
    await Promise.all([
      refreshRailConversations(queryClient, rail.queryKey),
      refreshRailConversations(queryClient, rail.queryKey)
    ]);
    expect(listRequests).toHaveLength(before + refreshes + 1);

    // A rename, a delete or a new chat changes the loaded rows without a request.
    updateRailConversations(queryClient, rail.queryKey, (current) => current.slice(1));
    expect(loaded()?.conversations).toHaveLength(rows.length - 1);
    expect(loaded()?.nextCursor).toBeDefined();
    expect(listRequests).toHaveLength(before + refreshes + 1);
  }, 120_000);

  it("reads the one list of a session without workspaces under its stable cache key", async () => {
    const listed: unknown[] = [];
    const options = railConversationsQueryOptions({
      apiBaseUrl,
      authScope,
      client: createApiClient({
        baseUrl: apiBaseUrl,
        fetchImpl: async (input, init) => {
          listed.push(
            new URL(new Request(input, init).url).searchParams.get("collaborationWorkspaceId")
          );
          return Response.json({ items: [] });
        }
      }),
      collaborationWorkspaceId: undefined,
      collaborationWorkspacesAvailable: false,
      enabled: true
    });
    const queryClient = createWorkspaceQueryClient();

    expect(options.enabled).toBe(true);
    expect(options.queryKey[3]).toBe("personal-default");
    await expect(queryClient.fetchQuery(options)).resolves.toEqual({
      conversations: [],
      nextCursor: undefined
    });
    expect(listed).toEqual([null]);
  });
});
