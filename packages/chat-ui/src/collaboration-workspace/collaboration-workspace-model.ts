import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiClient,
  CollaborationWorkspaceWithRole,
  ConversationListItem
} from "@vivd-catalyst/api-client";
import { useCollaborationWorkspacesQuery } from "../api/workspace-queries";
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
  | { kind: "settings"; collaborationWorkspaceId: string }
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
  openSettingsDialog(collaborationWorkspaceId: string): void;
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
    showConversation
  } = input;
  const [dialog, setDialog] = useState<CollaborationWorkspaceDialogState>({ kind: "none" });
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
  // Settings, approvals and administration have no workspace in their URL. The
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

  // Application root: restore the browser-local last workspace, validated
  // against the memberships the server actually returns.
  useEffect(() => {
    if (route.kind !== "collaboration-workspace-root" || !collaborationWorkspacesLoaded) {
      return;
    }
    const storedCollaborationWorkspaceId = userId
      ? readStoredCollaborationWorkspaceId(apiBaseUrl, userId)
      : undefined;
    const restored = collaborationWorkspaces.find(
      (collaborationWorkspace) => collaborationWorkspace.id === storedCollaborationWorkspaceId
    );
    const target = restored?.id ?? fallbackCollaborationWorkspaceId;
    if (target) {
      goToCollaborationWorkspace(target, { replace: true });
    }
  }, [
    apiBaseUrl,
    collaborationWorkspaces,
    collaborationWorkspacesLoaded,
    fallbackCollaborationWorkspaceId,
    goToCollaborationWorkspace,
    route.kind,
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

  useEffect(() => {
    if (dialog.kind !== "settings" || !collaborationWorkspacesLoaded) {
      return;
    }
    const stillManageable = collaborationWorkspaces.some(
      (collaborationWorkspace) => collaborationWorkspace.id === dialog.collaborationWorkspaceId
    );
    if (!stillManageable) {
      setDialog({ kind: "none" });
    }
  }, [collaborationWorkspaces, collaborationWorkspacesLoaded, dialog]);

  const selectCollaborationWorkspace = useCallback(
    (collaborationWorkspaceId: string) => {
      if (collaborationWorkspaceId === routedCollaborationWorkspaceId) {
        return;
      }
      goToCollaborationWorkspace(collaborationWorkspaceId);
    },
    [goToCollaborationWorkspace, routedCollaborationWorkspaceId]
  );

  const openCreateDialog = useCallback(() => setDialog({ kind: "create" }), []);
  const openBrowseDialog = useCallback(() => setDialog({ kind: "browse" }), []);
  const openSettingsDialog = useCallback(
    (collaborationWorkspaceId: string) => setDialog({ kind: "settings", collaborationWorkspaceId }),
    []
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
    openSettingsDialog,
    openMoveConversationDialog,
    closeDialog,
    conversationMoved,
    collaborationWorkspaceDeleted
  };
}

function isPageOutsideCollaborationWorkspace(route: WorkspaceRoute): boolean {
  return (
    route.kind === "settings" ||
    route.kind === "approvals" ||
    route.kind === "superadmin" ||
    route.kind === "ui-library"
  );
}
