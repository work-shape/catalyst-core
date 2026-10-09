import type {
  ApiClient,
  CollaborationWorkspaceWithRole,
  ConversationListItem
} from "@vivd-catalyst/api-client";
import { useCollaborationWorkspaceDirectoryQuery } from "../api/workspace-queries";
import {
  useCollaborationWorkspaceMutations,
  useMoveConversationMutation
} from "../api/workspace-mutations";
import { BrowseCollaborationWorkspacesDialog } from "./browse-collaboration-workspaces-dialog";
import { useCollaborationWorkspaceActionError } from "./collaboration-workspace-action-error";
import type { CollaborationWorkspaceDialogState } from "./collaboration-workspace-model";
import {
  CreateCollaborationWorkspaceDialog,
  type CreateCollaborationWorkspaceValues
} from "./create-collaboration-workspace-dialog";
import { MoveConversationDialog } from "./move-conversation-dialog";

interface CollaborationWorkspaceSurfaceInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

export function CollaborationWorkspacePanel({
  apiBaseUrl,
  authScope,
  client,
  userLabel,
  collaborationWorkspaces,
  activeCollaborationWorkspaceId,
  dialog,
  onClose,
  onCollaborationWorkspaceCreated,
  onConversationMoved
}: CollaborationWorkspaceSurfaceInput & {
  userLabel: string;
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  activeCollaborationWorkspaceId: string | undefined;
  dialog: CollaborationWorkspaceDialogState;
  onClose(): void;
  onCollaborationWorkspaceCreated(collaborationWorkspaceId: string): void;
  onConversationMoved(conversationId: string, destinationCollaborationWorkspaceId: string): void;
}) {
  return (
    <>
      {dialog.kind === "move-conversation" ? (
        <MoveConversationSurface
          apiBaseUrl={apiBaseUrl}
          authScope={authScope}
          client={client}
          collaborationWorkspaces={collaborationWorkspaces}
          activeCollaborationWorkspaceId={activeCollaborationWorkspaceId}
          userLabel={userLabel}
          conversationId={dialog.conversationId}
          conversationTitle={dialog.conversationTitle}
          conversationVisibility={dialog.conversationVisibility}
          movedByCreator={dialog.movedByCreator}
          onClose={onClose}
          onMoved={onConversationMoved}
        />
      ) : null}
      {dialog.kind === "create" ? (
        <CreateCollaborationWorkspaceSurface
          apiBaseUrl={apiBaseUrl}
          authScope={authScope}
          client={client}
          onClose={onClose}
          onCreated={onCollaborationWorkspaceCreated}
        />
      ) : null}
      {dialog.kind === "browse" ? (
        <BrowseCollaborationWorkspacesSurface
          apiBaseUrl={apiBaseUrl}
          authScope={authScope}
          client={client}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}

function MoveConversationSurface({
  apiBaseUrl,
  authScope,
  client,
  collaborationWorkspaces,
  activeCollaborationWorkspaceId,
  userLabel,
  conversationId,
  conversationTitle,
  conversationVisibility,
  movedByCreator,
  onClose,
  onMoved
}: CollaborationWorkspaceSurfaceInput & {
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  activeCollaborationWorkspaceId: string | undefined;
  userLabel: string;
  conversationId: string;
  conversationTitle: string;
  conversationVisibility: ConversationListItem["visibility"];
  movedByCreator: boolean;
  onClose(): void;
  onMoved(conversationId: string, destinationCollaborationWorkspaceId: string): void;
}) {
  const moveConversation = useMoveConversationMutation({
    apiBaseUrl,
    authScope,
    client,
    sourceCollaborationWorkspaceId: activeCollaborationWorkspaceId
  });
  const { errorMessage, clearError, reportError } = useCollaborationWorkspaceActionError();

  return (
    <MoveConversationDialog
      open
      conversationTitle={conversationTitle}
      conversationVisibility={conversationVisibility}
      movedByCreator={movedByCreator}
      collaborationWorkspaces={collaborationWorkspaces}
      activeCollaborationWorkspaceId={activeCollaborationWorkspaceId}
      userLabel={userLabel}
      pending={moveConversation.isPending}
      errorMessage={errorMessage}
      onClose={onClose}
      onMove={(destinationCollaborationWorkspaceId, visibility) => {
        clearError();
        moveConversation.mutate(
          {
            conversationId,
            collaborationWorkspaceId: destinationCollaborationWorkspaceId,
            visibility
          },
          {
            onSuccess: () => onMoved(conversationId, destinationCollaborationWorkspaceId),
            onError: (error) => reportError("moveConversation", error)
          }
        );
      }}
    />
  );
}

function CreateCollaborationWorkspaceSurface({
  apiBaseUrl,
  authScope,
  client,
  onClose,
  onCreated
}: CollaborationWorkspaceSurfaceInput & {
  onClose(): void;
  onCreated(collaborationWorkspaceId: string): void;
}) {
  const { createCollaborationWorkspace } = useCollaborationWorkspaceMutations({
    apiBaseUrl,
    authScope,
    client
  });
  const { errorMessage, clearError, reportError } = useCollaborationWorkspaceActionError();

  function create(values: CreateCollaborationWorkspaceValues) {
    clearError();
    createCollaborationWorkspace.mutate(
      {
        name: values.name,
        description: values.description,
        visibility: values.visibility,
        defaultConversationVisibility: values.defaultConversationVisibility,
        emoji: values.emoji,
        accentColor: values.accentColor
      },
      {
        onSuccess: (created) => {
          onCreated(created.id);
          onClose();
        },
        onError: (error) => reportError("create", error)
      }
    );
  }

  return (
    <CreateCollaborationWorkspaceDialog
      open
      pending={createCollaborationWorkspace.isPending}
      errorMessage={errorMessage}
      onClose={onClose}
      onCreate={create}
    />
  );
}

function BrowseCollaborationWorkspacesSurface({
  apiBaseUrl,
  authScope,
  client,
  onClose
}: CollaborationWorkspaceSurfaceInput & { onClose(): void }) {
  const directoryQuery = useCollaborationWorkspaceDirectoryQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: true
  });
  const { requestCollaborationWorkspaceAccess } = useCollaborationWorkspaceMutations({
    apiBaseUrl,
    authScope,
    client
  });
  const { errorMessage, clearError, reportError } = useCollaborationWorkspaceActionError();

  return (
    <BrowseCollaborationWorkspacesDialog
      open
      collaborationWorkspaces={directoryQuery.data ?? []}
      loading={directoryQuery.isPending}
      loadFailed={Boolean(directoryQuery.error)}
      errorMessage={errorMessage}
      pendingCollaborationWorkspaceId={
        requestCollaborationWorkspaceAccess.isPending
          ? requestCollaborationWorkspaceAccess.variables
          : undefined
      }
      onRequestAccess={(collaborationWorkspaceId) => {
        clearError();
        requestCollaborationWorkspaceAccess.mutate(collaborationWorkspaceId, {
          onError: (error) => reportError("requestAccess", error)
        });
      }}
      onClose={onClose}
    />
  );
}
