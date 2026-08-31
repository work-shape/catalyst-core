import { ApiError } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import {
  workspaceRouteFromPath,
  workspaceRouteNavigation
} from "../packages/chat-ui/src/standalone-chat-app";
import {
  routeCollaborationWorkspaceId,
  workspaceRouteView
} from "../packages/chat-ui/src/workspace/workspace-route";
import { collaborationWorkspaceErrorKey } from "../packages/chat-ui/src/collaboration-workspace/collaboration-workspace-errors";

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
