import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiClient,
  CollaborationWorkspaceWithRole,
  ConversationListItem
} from "@vivd-catalyst/api-client";
import { useCollaborationWorkspacesQuery } from "../api/workspace-queries";
import { canManageCollaborationWorkspace } from "./collaboration-workspace-selector";
import {
  clearStoredCollaborationWorkspaceId,
  readStoredCollaborationWorkspaceId,
  writeStoredCollaborationWorkspaceId
} from "../workspace-utils";
import {
  routeCollaborationWorkspaceId,
  routeConversationId,
  type WorkspaceRoute
} from "../workspace/workspace-route";

export type CollaborationWorkspaceDialogState =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "browse" }
  | {
      kind: "move-conversation";
      conversationId: string;
      conversationTitle: string;
      conversationVisibility: ConversationListItem["visibility"];
      movedByCreator: boolean;
    };

export interface CollaborationWorkspaceModel {
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  activeCollaborationWorkspaceId: string | undefined;
  activeCollaborationWorkspace: CollaborationWorkspaceWithRole | undefined;
  personalCollaborationWorkspaceId: string | undefined;
  loading: boolean;
  loadFailed: boolean;
  dialog: CollaborationWorkspaceDialogState;
  canMoveConversation: boolean;
  selectCollaborationWorkspace(collaborationWorkspaceId: string): void;
  openCreateDialog(): void;
  openBrowseDialog(): void;
  /**
   * The shared workspace the Workspace pages of Settings change: the one last opened there,
   * else the active one where the user manages it, else the first one they manage.
   */
  settingsCollaborationWorkspace: CollaborationWorkspaceWithRole | undefined;
  selectSettingsCollaborationWorkspace(collaborationWorkspaceId: string): void;
  /** Opens a workspace's settings: Members while requests wait there, General otherwise. */
  openSettings(collaborationWorkspaceId: string): void;
  openMoveConversationDialog(
    conversation: Pick<ConversationListItem, "id" | "title" | "visibility" | "createdByUserId">
  ): void;
  closeDialog(): void;
  conversationMoved(conversationId: string, destinationCollaborationWorkspaceId: string): void;
  collaborationWorkspaceDeleted(collaborationWorkspaceId: string): void;
}

/**
 * A conversation's own Collaboration Workspace decides its canonical URL. A
 * legacy `/c/:conversationId` link carries no workspace at all, and a
 * `/w/:collaborationWorkspaceId/c/:conversationId` link saved before the
 * conversation moved names one that no longer owns it — both resolve to the
 * workspace the loaded thread reports.
 */
export function canonicalConversationRedirect(input: {
  route: WorkspaceRoute;
  loadedConversationCollaborationWorkspaceId: string | undefined;
}): { collaborationWorkspaceId: string; conversationId: string } | undefined {
  const { route, loadedConversationCollaborationWorkspaceId } = input;
  if (!loadedConversationCollaborationWorkspaceId) {
    return undefined;
  }
  if (route.kind === "legacy-conversation") {
    return {
      collaborationWorkspaceId: loadedConversationCollaborationWorkspaceId,
      conversationId: route.conversationId
    };
  }
  if (
    route.kind === "conversation" &&
    route.collaborationWorkspaceId !== loadedConversationCollaborationWorkspaceId
  ) {
    return {
      collaborationWorkspaceId: loadedConversationCollaborationWorkspaceId,
      conversationId: route.conversationId
    };
  }
  return undefined;
}

export interface CollaborationWorkspaceModelInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  isAuthenticated: boolean;
  /**
   * Off for embedded token sessions: their scope is capped below
   * `collaboration_workspace:read`, so the widget stays fixed-context and never
   * asks for a workspace list it cannot be granted.
   */
  enabled: boolean;
  userId: string | undefined;
  route: WorkspaceRoute;
  /** Owning workspace of the routed conversation, once its thread is loaded. */
  loadedConversationCollaborationWorkspaceId: string | undefined;
  legacyConversationUnavailable: boolean;
  goToCollaborationWorkspace(collaborationWorkspaceId: string, options?: { replace?: true }): void;
  showConversation(
    collaborationWorkspaceId: string,
    conversationId: string,
    options?: { replace?: true }
  ): void;
  showSettings(group: string, page: string): void;
  /** Opens the list of every conversation of a workspace. */
  showConversationList(collaborationWorkspaceId: string, options?: { replace?: true }): void;
}

export function useCollaborationWorkspaceModel(
  input: CollaborationWorkspaceModelInput
): CollaborationWorkspaceModel {
  const {
    apiBaseUrl,
    authScope,
    client,
    isAuthenticated,
    enabled,
    userId,
    route,
    loadedConversationCollaborationWorkspaceId,
    legacyConversationUnavailable,
    goToCollaborationWorkspace,
    showConversation,
    showSettings,
    showConversationList
  } = input;
  const [dialog, setDialog] = useState<CollaborationWorkspaceDialogState>({ kind: "none" });
  const [settingsCollaborationWorkspaceId, setSettingsCollaborationWorkspaceId] = useState<
    string | undefined
  >();
  const collaborationWorkspacesQuery = useCollaborationWorkspacesQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: isAuthenticated && enabled
  });
  const collaborationWorkspaces = useMemo(
    () => collaborationWorkspacesQuery.data ?? [],
    [collaborationWorkspacesQuery.data]
  );
  const collaborationWorkspacesLoaded = collaborationWorkspacesQuery.isSuccess;
  const personalCollaborationWorkspaceId = collaborationWorkspaces.find(
    (collaborationWorkspace) => collaborationWorkspace.kind === "personal"
  )?.id;
  const fallbackCollaborationWorkspaceId =
    personalCollaborationWorkspaceId ?? collaborationWorkspaces[0]?.id;
  // Settings, the Inbox and administration have no workspace in their URL. The
  // rail still shows the workspace the user came from, so its conversations
  // stay in reach; the membership check keeps a stale stored id out.
  const routedCollaborationWorkspaceId = routeCollaborationWorkspaceId(route);
  const activeCollaborationWorkspaceId = useMemo(() => {
    if (routedCollaborationWorkspaceId || !isPageOutsideCollaborationWorkspace(route)) {
      return routedCollaborationWorkspaceId;
    }
    const storedCollaborationWorkspaceId = userId
      ? readStoredCollaborationWorkspaceId(apiBaseUrl, userId)
      : undefined;
    const restored = collaborationWorkspaces.find(
      (collaborationWorkspace) => collaborationWorkspace.id === storedCollaborationWorkspaceId
    );
    return restored?.id ?? fallbackCollaborationWorkspaceId;
  }, [
    apiBaseUrl,
    collaborationWorkspaces,
    fallbackCollaborationWorkspaceId,
    route,
    routedCollaborationWorkspaceId,
    userId
  ]);
  const activeCollaborationWorkspace = collaborationWorkspaces.find(
    (collaborationWorkspace) => collaborationWorkspace.id === activeCollaborationWorkspaceId
  );

  // Application root, and the conversation list without a workspace: restore the
  // browser-local last workspace, validated against the memberships the server
  // actually returns.
  useEffect(() => {
    if (
      (route.kind !== "collaboration-workspace-root" && route.kind !== "conversation-list-root") ||
      !collaborationWorkspacesLoaded
    ) {
      return;
    }
    const storedCollaborationWorkspaceId = userId
      ? readStoredCollaborationWorkspaceId(apiBaseUrl, userId)
      : undefined;
    const restored = collaborationWorkspaces.find(
      (collaborationWorkspace) => collaborationWorkspace.id === storedCollaborationWorkspaceId
    );
    const target = restored?.id ?? fallbackCollaborationWorkspaceId;
    if (!target) {
      return;
    }
    if (route.kind === "conversation-list-root") {
      showConversationList(target, { replace: true });
    } else {
      goToCollaborationWorkspace(target, { replace: true });
    }
  }, [
    apiBaseUrl,
    collaborationWorkspaces,
    collaborationWorkspacesLoaded,
    fallbackCollaborationWorkspaceId,
    goToCollaborationWorkspace,
    route.kind,
    showConversationList,
    userId
  ]);

  // Legacy `/c/:conversationId` links and stale `/w/:other/c/:id` links both
  // keep working by replacing the URL with the conversation's canonical form.
  useEffect(() => {
    const redirect = canonicalConversationRedirect({
      route,
      loadedConversationCollaborationWorkspaceId
    });
    if (redirect) {
      showConversation(redirect.collaborationWorkspaceId, redirect.conversationId, {
        replace: true
      });
      return;
    }
    if (
      route.kind === "legacy-conversation" &&
      legacyConversationUnavailable &&
      fallbackCollaborationWorkspaceId
    ) {
      goToCollaborationWorkspace(fallbackCollaborationWorkspaceId, { replace: true });
    }
  }, [
    fallbackCollaborationWorkspaceId,
    goToCollaborationWorkspace,
    loadedConversationCollaborationWorkspaceId,
    legacyConversationUnavailable,
    route,
    showConversation
  ]);

  // A URL naming an unavailable workspace falls back to the Personal Workspace;
  // guessing an id must never open someone else's workspace.
  useEffect(() => {
    if (!activeCollaborationWorkspaceId || !collaborationWorkspacesLoaded) {
      return;
    }
    if (activeCollaborationWorkspace || !fallbackCollaborationWorkspaceId) {
      return;
    }
    goToCollaborationWorkspace(fallbackCollaborationWorkspaceId, { replace: true });
  }, [
    activeCollaborationWorkspace,
    activeCollaborationWorkspaceId,
    collaborationWorkspacesLoaded,
    fallbackCollaborationWorkspaceId,
    goToCollaborationWorkspace
  ]);

  useEffect(() => {
    if (!userId || !activeCollaborationWorkspace) {
      return;
    }
    writeStoredCollaborationWorkspaceId(apiBaseUrl, userId, activeCollaborationWorkspace.id);
  }, [activeCollaborationWorkspace, apiBaseUrl, userId]);

  const settingsCollaborationWorkspace = useMemo(() => {
    const managed = collaborationWorkspaces.filter(canManageCollaborationWorkspace);
    return (
      managed.find((candidate) => candidate.id === settingsCollaborationWorkspaceId) ??
      managed.find((candidate) => candidate.id === activeCollaborationWorkspaceId) ??
      managed[0]
    );
  }, [activeCollaborationWorkspaceId, collaborationWorkspaces, settingsCollaborationWorkspaceId]);

  const selectCollaborationWorkspace = useCallback(
    (collaborationWorkspaceId: string) => {
      if (collaborationWorkspaceId === routedCollaborationWorkspaceId) {
        return;
      }
      // The list of every conversation stays open and shows the chosen workspace's.
      if (route.kind === "conversation-list") {
        showConversationList(collaborationWorkspaceId);
        return;
      }
      goToCollaborationWorkspace(collaborationWorkspaceId);
    },
    [goToCollaborationWorkspace, route.kind, routedCollaborationWorkspaceId, showConversationList]
  );

  const openCreateDialog = useCallback(() => setDialog({ kind: "create" }), []);
  const openBrowseDialog = useCallback(() => setDialog({ kind: "browse" }), []);
  const openSettings = useCallback(
    (collaborationWorkspaceId: string) => {
      const requestsWait = collaborationWorkspaces.some(
        (candidate) =>
          candidate.id === collaborationWorkspaceId && candidate.pendingAccessRequestCount > 0
      );
      setSettingsCollaborationWorkspaceId(collaborationWorkspaceId);
      showSettings("workspace", requestsWait ? "members" : "general");
    },
    [collaborationWorkspaces, showSettings]
  );
  const openMoveConversationDialog = useCallback(
    (conversation: Pick<ConversationListItem, "id" | "title" | "visibility" | "createdByUserId">) =>
      setDialog({
        kind: "move-conversation",
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        conversationVisibility: conversation.visibility,
        movedByCreator: conversation.createdByUserId === userId
      }),
    [userId]
  );
  const closeDialog = useCallback(() => setDialog({ kind: "none" }), []);

  // A moved conversation keeps its canonical URL: only the workspace segment
  // changes, and only while that conversation is the one on screen.
  const conversationMoved = useCallback(
    (conversationId: string, destinationCollaborationWorkspaceId: string) => {
      setDialog({ kind: "none" });
      if (routeConversationId(route) === conversationId) {
        showConversation(destinationCollaborationWorkspaceId, conversationId, { replace: true });
      }
    },
    [route, showConversation]
  );

  const collaborationWorkspaceDeleted = useCallback(
    (deletedCollaborationWorkspaceId: string) => {
      setDialog({ kind: "none" });
      // The browser-local last workspace must not resurrect a deleted id on the
      // next application root visit.
      if (
        userId &&
        readStoredCollaborationWorkspaceId(apiBaseUrl, userId) === deletedCollaborationWorkspaceId
      ) {
        clearStoredCollaborationWorkspaceId(apiBaseUrl, userId);
      }
      if (personalCollaborationWorkspaceId) {
        goToCollaborationWorkspace(personalCollaborationWorkspaceId, { replace: true });
      }
    },
    [apiBaseUrl, goToCollaborationWorkspace, personalCollaborationWorkspaceId, userId]
  );

  return {
    collaborationWorkspaces,
    activeCollaborationWorkspaceId,
    activeCollaborationWorkspace,
    personalCollaborationWorkspaceId,
    loading: collaborationWorkspacesQuery.isPending && isAuthenticated && enabled,
    loadFailed: Boolean(collaborationWorkspacesQuery.error),
    dialog,
    canMoveConversation: enabled && collaborationWorkspaces.length > 1,
    selectCollaborationWorkspace,
    openCreateDialog,
    openBrowseDialog,
    settingsCollaborationWorkspace,
    selectSettingsCollaborationWorkspace: setSettingsCollaborationWorkspaceId,
    openSettings,
    openMoveConversationDialog,
    closeDialog,
    conversationMoved,
    collaborationWorkspaceDeleted
  };
}

function isPageOutsideCollaborationWorkspace(route: WorkspaceRoute): boolean {
  return (
    route.kind === "build-kind" ||
    route.kind === "build-asset" ||
    route.kind === "settings" ||
    route.kind === "administration" ||
    route.kind === "build" ||
    route.kind === "inbox" ||
    route.kind === "inbox-item" ||
    route.kind === "ui-library"
  );
}
