import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient, CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
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
  | { kind: "move-conversation"; conversationId: string; conversationTitle: string };

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
  openMoveConversationDialog(conversationId: string, conversationTitle: string): void;
  closeDialog(): void;
  conversationMoved(conversationId: string, destinationCollaborationWorkspaceId: string): void;
  collaborationWorkspaceDeleted(collaborationWorkspaceId: string): void;
}

export interface CollaborationWorkspaceModelInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  isAuthenticated: boolean;
  userId: string | undefined;
  route: WorkspaceRoute;
  /** Owning workspace of a legacy `/c/:conversationId` link, once resolved. */
  legacyConversationCollaborationWorkspaceId: string | undefined;
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
    userId,
    route,
    legacyConversationCollaborationWorkspaceId,
    legacyConversationUnavailable,
    goToCollaborationWorkspace,
    showConversation
  } = input;
  const [dialog, setDialog] = useState<CollaborationWorkspaceDialogState>({ kind: "none" });
  const collaborationWorkspacesQuery = useCollaborationWorkspacesQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: isAuthenticated
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
  const activeCollaborationWorkspaceId = routeCollaborationWorkspaceId(route);
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

  // Legacy `/c/:conversationId` links keep working by resolving the owning
  // workspace and replacing the URL with its canonical form.
  useEffect(() => {
    if (route.kind !== "legacy-conversation") {
      return;
    }
    if (legacyConversationCollaborationWorkspaceId) {
      showConversation(legacyConversationCollaborationWorkspaceId, route.conversationId, {
        replace: true
      });
      return;
    }
    if (legacyConversationUnavailable && fallbackCollaborationWorkspaceId) {
      goToCollaborationWorkspace(fallbackCollaborationWorkspaceId, { replace: true });
    }
  }, [
    fallbackCollaborationWorkspaceId,
    goToCollaborationWorkspace,
    legacyConversationCollaborationWorkspaceId,
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
      if (collaborationWorkspaceId === activeCollaborationWorkspaceId) {
        return;
      }
      goToCollaborationWorkspace(collaborationWorkspaceId);
    },
    [activeCollaborationWorkspaceId, goToCollaborationWorkspace]
  );

  const openCreateDialog = useCallback(() => setDialog({ kind: "create" }), []);
  const openBrowseDialog = useCallback(() => setDialog({ kind: "browse" }), []);
  const openSettingsDialog = useCallback(
    (collaborationWorkspaceId: string) => setDialog({ kind: "settings", collaborationWorkspaceId }),
    []
  );
  const openMoveConversationDialog = useCallback(
    (conversationId: string, conversationTitle: string) =>
      setDialog({ kind: "move-conversation", conversationId, conversationTitle }),
    []
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
    loading: collaborationWorkspacesQuery.isPending && isAuthenticated,
    loadFailed: Boolean(collaborationWorkspacesQuery.error),
    dialog,
    canMoveConversation: collaborationWorkspaces.length > 1,
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
