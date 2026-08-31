import { useState } from "react";
import type {
  ApiClient,
  CollaborationWorkspaceWithRole,
  WorkspaceMembershipRole
} from "@vivd-catalyst/api-client";
import {
  useCollaborationWorkspaceAccessRequestsQuery,
  useCollaborationWorkspaceDirectoryQuery,
  useCollaborationWorkspaceMembersQuery
} from "../api/workspace-queries";
import { useCollaborationWorkspaceMutations } from "../api/workspace-mutations";
import { useTranslation } from "../i18n";
import { BrowseCollaborationWorkspacesDialog } from "./browse-collaboration-workspaces-dialog";
import {
  CollaborationWorkspaceSettingsDialog,
  type CollaborationWorkspaceSettingsValues
} from "./collaboration-workspace-settings-dialog";
import {
  collaborationWorkspaceErrorKey,
  type CollaborationWorkspaceAction
} from "./collaboration-workspace-errors";
import type { CollaborationWorkspaceDialogState } from "./collaboration-workspace-model";
import {
  CreateCollaborationWorkspaceDialog,
  type CreateCollaborationWorkspaceValues
} from "./create-collaboration-workspace-dialog";

interface CollaborationWorkspaceSurfaceInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

export function CollaborationWorkspacePanel({
  apiBaseUrl,
  authScope,
  client,
  currentUserId,
  collaborationWorkspaces,
  dialog,
  onClose,
  onCollaborationWorkspaceCreated
}: CollaborationWorkspaceSurfaceInput & {
  currentUserId: string | undefined;
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  dialog: CollaborationWorkspaceDialogState;
  onClose(): void;
  onCollaborationWorkspaceCreated(collaborationWorkspaceId: string): void;
}) {
  const settingsCollaborationWorkspace =
    dialog.kind === "settings"
      ? collaborationWorkspaces.find(
          (collaborationWorkspace) => collaborationWorkspace.id === dialog.collaborationWorkspaceId
        )
      : undefined;

  return (
    <>
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
      {settingsCollaborationWorkspace ? (
        <CollaborationWorkspaceSettingsSurface
          apiBaseUrl={apiBaseUrl}
          authScope={authScope}
          client={client}
          collaborationWorkspace={settingsCollaborationWorkspace}
          currentUserId={currentUserId}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}

function useCollaborationWorkspaceActionError() {
  const { t } = useTranslation();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  return {
    errorMessage,
    clearError: () => setErrorMessage(undefined),
    reportError: (action: CollaborationWorkspaceAction, error: unknown) => {
      setErrorMessage(t(collaborationWorkspaceErrorKey(action, error)));
    }
  };
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

function CollaborationWorkspaceSettingsSurface({
  apiBaseUrl,
  authScope,
  client,
  collaborationWorkspace,
  currentUserId,
  onClose
}: CollaborationWorkspaceSurfaceInput & {
  collaborationWorkspace: CollaborationWorkspaceWithRole;
  currentUserId: string | undefined;
  onClose(): void;
}) {
  const collaborationWorkspaceId = collaborationWorkspace.id;
  const membersQuery = useCollaborationWorkspaceMembersQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    enabled: true
  });
  const accessRequestsQuery = useCollaborationWorkspaceAccessRequestsQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    enabled: true
  });
  const {
    updateCollaborationWorkspace,
    addCollaborationWorkspaceMember,
    changeCollaborationWorkspaceMemberRole,
    removeCollaborationWorkspaceMember,
    leaveCollaborationWorkspace,
    approveCollaborationWorkspaceAccessRequest,
    declineCollaborationWorkspaceAccessRequest
  } = useCollaborationWorkspaceMutations({ apiBaseUrl, authScope, client });
  const { errorMessage, clearError, reportError } = useCollaborationWorkspaceActionError();
  const membershipPending =
    addCollaborationWorkspaceMember.isPending ||
    changeCollaborationWorkspaceMemberRole.isPending ||
    removeCollaborationWorkspaceMember.isPending ||
    leaveCollaborationWorkspace.isPending ||
    approveCollaborationWorkspaceAccessRequest.isPending ||
    declineCollaborationWorkspaceAccessRequest.isPending;

  function save(values: CollaborationWorkspaceSettingsValues) {
    clearError();
    updateCollaborationWorkspace.mutate(
      {
        collaborationWorkspaceId,
        update: {
          name: values.name,
          description: values.description,
          visibility: values.visibility,
          emoji: values.emoji,
          accentColor: values.accentColor
        }
      },
      { onError: (error) => reportError("update", error) }
    );
  }

  return (
    <CollaborationWorkspaceSettingsDialog
      open
      collaborationWorkspace={collaborationWorkspace}
      currentUserId={currentUserId}
      members={membersQuery.data ?? []}
      membersLoading={membersQuery.isPending}
      membersLoadFailed={Boolean(membersQuery.error)}
      accessRequests={accessRequestsQuery.data ?? []}
      accessRequestsLoading={accessRequestsQuery.isPending}
      accessRequestsLoadFailed={Boolean(accessRequestsQuery.error)}
      savePending={updateCollaborationWorkspace.isPending}
      membershipPending={membershipPending}
      errorMessage={errorMessage}
      onClose={onClose}
      onSave={save}
      onAddMember={(email) => {
        clearError();
        addCollaborationWorkspaceMember.mutate(
          { collaborationWorkspaceId, email },
          { onError: (error) => reportError("addMember", error) }
        );
      }}
      onChangeMemberRole={(userId, role: WorkspaceMembershipRole) => {
        clearError();
        changeCollaborationWorkspaceMemberRole.mutate(
          { collaborationWorkspaceId, userId, role },
          { onError: (error) => reportError("changeRole", error) }
        );
      }}
      onRemoveMember={(userId) => {
        clearError();
        removeCollaborationWorkspaceMember.mutate(
          { collaborationWorkspaceId, userId },
          { onError: (error) => reportError("removeMember", error) }
        );
      }}
      onLeave={() => {
        clearError();
        leaveCollaborationWorkspace.mutate(collaborationWorkspaceId, {
          onSuccess: onClose,
          onError: (error) => reportError("leave", error)
        });
      }}
      onApproveAccessRequest={(userId) => {
        clearError();
        approveCollaborationWorkspaceAccessRequest.mutate(
          { collaborationWorkspaceId, userId },
          { onError: (error) => reportError("approveRequest", error) }
        );
      }}
      onDeclineAccessRequest={(userId) => {
        clearError();
        declineCollaborationWorkspaceAccessRequest.mutate(
          { collaborationWorkspaceId, userId },
          { onError: (error) => reportError("declineRequest", error) }
        );
      }}
    />
  );
}
