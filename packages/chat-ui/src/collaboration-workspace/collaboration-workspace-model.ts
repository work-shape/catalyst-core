import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient, CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import { useCollaborationWorkspacesQuery } from "../api/workspace-queries";
import {
  readStoredCollaborationWorkspaceId,
  writeStoredCollaborationWorkspaceId
} from "../workspace-utils";
import { routeCollaborationWorkspaceId, type WorkspaceRoute } from "../workspace/workspace-route";

export type CollaborationWorkspaceDialogState =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "browse" }
  | { kind: "settings"; collaborationWorkspaceId: string };

export interface CollaborationWorkspaceModel {
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  activeCollaborationWorkspaceId: string | undefined;
  activeCollaborationWorkspace: CollaborationWorkspaceWithRole | undefined;
  personalCollaborationWorkspaceId: string | undefined;
  loading: boolean;
  loadFailed: boolean;
  dialog: CollaborationWorkspaceDialogState;
  selectCollaborationWorkspace(collaborationWorkspaceId: string): void;
  openCreateDialog(): void;
  openBrowseDialog(): void;
  openSettingsDialog(collaborationWorkspaceId: string): void;
  closeDialog(): void;
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
  const closeDialog = useCallback(() => setDialog({ kind: "none" }), []);

  return {
    collaborationWorkspaces,
    activeCollaborationWorkspaceId,
    activeCollaborationWorkspace,
    personalCollaborationWorkspaceId,
    loading: collaborationWorkspacesQuery.isPending && isAuthenticated,
    loadFailed: Boolean(collaborationWorkspacesQuery.error),
    dialog,
    selectCollaborationWorkspace,
    openCreateDialog,
    openBrowseDialog,
    openSettingsDialog,
    closeDialog
  };
}
