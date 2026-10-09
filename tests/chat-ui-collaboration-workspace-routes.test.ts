import { ApiError, type Conversation } from "@vivd-catalyst/api-client";
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
  PERSONAL_DEFAULT_CONVERSATION_LIST,
  conversationListCacheKey,
  listCollaborationWorkspacesWithPersonal,
  workspaceConversationsQueryOptions
} from "../packages/chat-ui/src/api/workspace-queries";
import { workspaceQueryKeys } from "../packages/chat-ui/src/api/workspace-query-keys";

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
    expect(workspaceRouteFromPath("/settings")).toEqual({ kind: "settings" });
    expect(workspaceRouteFromPath("/admin/users")).toEqual({ kind: "superadmin", tab: "users" });
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

  it("enables the embedded Personal Workspace list and targets its stable cache key", async () => {
    const listArguments: Array<string | undefined> = [];
    const options = workspaceConversationsQueryOptions({
      apiBaseUrl,
      authScope,
      client: {
        conversations: {
          list: async (collaborationWorkspaceId?: string) => {
            listArguments.push(collaborationWorkspaceId);
            return [];
          }
        }
      } as never,
      collaborationWorkspaceId: undefined,
      collaborationWorkspacesAvailable: false,
      enabled: true
    });

    expect(options.enabled).toBe(true);
    expect(options.queryKey).toEqual(
      workspaceQueryKeys.conversations(apiBaseUrl, authScope, PERSONAL_DEFAULT_CONVERSATION_LIST)
    );
    await options.queryFn();
    expect(listArguments).toEqual([undefined]);
    expect(
      conversationListCacheKey(apiBaseUrl, authScope, conversation("cw_personal"), false)
    ).toEqual(options.queryKey);
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
        return (pages.shift() ?? []).map((kind) => ({ kind }));
      },
      ensurePersonal: async () => {
        calls.push("ensurePersonal");
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
    expect(api.calls).toEqual(["list", "ensurePersonal", "list"]);
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
