import { useEffect, useState } from "react";
import type {
  ApiClient,
  CollaborationWorkspaceWithRole,
  WorkspaceMemberCandidate,
  WorkspaceMembershipRole
} from "@vivd-catalyst/api-client";
import {
  useCollaborationWorkspaceAccessRequestsQuery,
  useCollaborationWorkspaceDeletionImpactQuery,
  useCollaborationWorkspaceDirectoryQuery,
  useCollaborationWorkspaceMemberCandidatesQuery,
  useCollaborationWorkspaceMembersQuery
} from "../api/workspace-queries";
import {
  useCollaborationWorkspaceMutations,
  useMoveConversationMutation
} from "../api/workspace-mutations";
import { useTranslation, type TranslationKey } from "../i18n";
import { BrowseCollaborationWorkspacesDialog } from "./browse-collaboration-workspaces-dialog";
import { canManageCollaborationWorkspace } from "./collaboration-workspace-selector";
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
import { DeleteCollaborationWorkspaceDialog } from "./delete-collaboration-workspace-dialog";
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
  currentUserId,
  userLabel,
  collaborationWorkspaces,
  activeCollaborationWorkspaceId,
  dialog,
  onClose,
  onCollaborationWorkspaceCreated,
  onConversationMoved,
  onCollaborationWorkspaceDeleted
}: CollaborationWorkspaceSurfaceInput & {
  currentUserId: string | undefined;
  userLabel: string;
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  activeCollaborationWorkspaceId: string | undefined;
  dialog: CollaborationWorkspaceDialogState;
  onClose(): void;
  onCollaborationWorkspaceCreated(collaborationWorkspaceId: string): void;
  onConversationMoved(conversationId: string, destinationCollaborationWorkspaceId: string): void;
  onCollaborationWorkspaceDeleted(collaborationWorkspaceId: string): void;
}) {
  const settingsCollaborationWorkspace =
    dialog.kind === "settings"
      ? collaborationWorkspaces.find(
          (collaborationWorkspace) => collaborationWorkspace.id === dialog.collaborationWorkspaceId
        )
      : undefined;

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
      {settingsCollaborationWorkspace ? (
        <CollaborationWorkspaceSettingsSurface
          apiBaseUrl={apiBaseUrl}
          authScope={authScope}
          client={client}
          collaborationWorkspace={settingsCollaborationWorkspace}
          currentUserId={currentUserId}
          onClose={onClose}
          onDeleted={onCollaborationWorkspaceDeleted}
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

/**
 * Deletion splits its errors: a rejected confirmation name belongs next to the
 * input, everything else at the foot of the dialog.
 */
function useCollaborationWorkspaceDeletionError() {
  const { t } = useTranslation();
  const [errorKey, setErrorKey] = useState<TranslationKey | undefined>();
  const nameMismatch = errorKey === "collaborationWorkspaceErrorNameMismatch";

  return {
    errorMessage: errorKey && !nameMismatch ? t(errorKey) : undefined,
    nameErrorMessage: errorKey && nameMismatch ? t(errorKey) : undefined,
    clearError: () => setErrorKey(undefined),
    reportError: (error: unknown) => {
      setErrorKey(collaborationWorkspaceErrorKey("deleteCollaborationWorkspace", error));
    }
  };
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
  onClose,
  onMoved
}: CollaborationWorkspaceSurfaceInput & {
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  activeCollaborationWorkspaceId: string | undefined;
  userLabel: string;
  conversationId: string;
  conversationTitle: string;
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
      collaborationWorkspaces={collaborationWorkspaces}
      activeCollaborationWorkspaceId={activeCollaborationWorkspaceId}
      userLabel={userLabel}
      pending={moveConversation.isPending}
      errorMessage={errorMessage}
      onClose={onClose}
      onMove={(destinationCollaborationWorkspaceId) => {
        clearError();
        moveConversation.mutate(
          { conversationId, collaborationWorkspaceId: destinationCollaborationWorkspaceId },
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

/** Server-side floor for the candidate search; below it nothing is requested. */
const collaborationWorkspaceMemberCandidateMinQueryLength = 2;
const collaborationWorkspaceMemberCandidateDebounceMs = 250;
const emptyCollaborationWorkspaceMemberCandidates: WorkspaceMemberCandidate[] = [];

/** Keeps the candidate request off every keystroke. */
function useDebouncedCollaborationWorkspaceMemberQuery(query: string): string {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedQuery(query),
      collaborationWorkspaceMemberCandidateDebounceMs
    );
    return () => clearTimeout(timer);
  }, [query]);

  return debouncedQuery;
}

function CollaborationWorkspaceSettingsSurface({
  apiBaseUrl,
  authScope,
  client,
  collaborationWorkspace,
  currentUserId,
  onClose,
  onDeleted
}: CollaborationWorkspaceSurfaceInput & {
  collaborationWorkspace: CollaborationWorkspaceWithRole;
  currentUserId: string | undefined;
  onClose(): void;
  onDeleted(collaborationWorkspaceId: string): void;
}) {
  const collaborationWorkspaceId = collaborationWorkspace.id;
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [memberCandidateSearch, setMemberCandidateSearch] = useState("");
  const debouncedMemberCandidateSearch =
    useDebouncedCollaborationWorkspaceMemberQuery(memberCandidateSearch);
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
  // Candidate search is owner/admin-only server-side; a member never asks.
  const memberCandidatesQuery = useCollaborationWorkspaceMemberCandidatesQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    query: debouncedMemberCandidateSearch,
    enabled:
      canManageCollaborationWorkspace(collaborationWorkspace) &&
      debouncedMemberCandidateSearch.length >= collaborationWorkspaceMemberCandidateMinQueryLength
  });
  const deletionImpactQuery = useCollaborationWorkspaceDeletionImpactQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    enabled: deleteDialogOpen
  });
  const {
    updateCollaborationWorkspace,
    deleteCollaborationWorkspace,
    addCollaborationWorkspaceMember,
    changeCollaborationWorkspaceMemberRole,
    removeCollaborationWorkspaceMember,
    leaveCollaborationWorkspace,
    approveCollaborationWorkspaceAccessRequest,
    declineCollaborationWorkspaceAccessRequest
  } = useCollaborationWorkspaceMutations({ apiBaseUrl, authScope, client });
  const { errorMessage, clearError, reportError } = useCollaborationWorkspaceActionError();
  const deletionError = useCollaborationWorkspaceDeletionError();
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
    <>
      <CollaborationWorkspaceSettingsDialog
        open
        collaborationWorkspace={collaborationWorkspace}
        currentUserId={currentUserId}
        members={membersQuery.data ?? []}
        membersLoading={membersQuery.isPending}
        membersLoadFailed={Boolean(membersQuery.error)}
        /* A failed candidate search stays silent: the add flow reports errors. */
        memberCandidates={
          memberCandidatesQuery.error
            ? emptyCollaborationWorkspaceMemberCandidates
            : (memberCandidatesQuery.data ?? emptyCollaborationWorkspaceMemberCandidates)
        }
        memberCandidatesLoading={memberCandidatesQuery.isFetching}
        accessRequests={accessRequestsQuery.data ?? []}
        accessRequestsLoading={accessRequestsQuery.isPending}
        accessRequestsLoadFailed={Boolean(accessRequestsQuery.error)}
        savePending={updateCollaborationWorkspace.isPending}
        membershipPending={membershipPending}
        errorMessage={errorMessage}
        onClose={onClose}
        onSave={save}
        onMemberCandidateSearchChange={setMemberCandidateSearch}
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
        onRequestDelete={() => {
          clearError();
          deletionError.clearError();
          setDeleteDialogOpen(true);
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
      <DeleteCollaborationWorkspaceDialog
        open={deleteDialogOpen}
        collaborationWorkspaceName={collaborationWorkspace.name}
        deletionImpact={deletionImpactQuery.data}
        deletionImpactLoading={deletionImpactQuery.isPending}
        deletionImpactLoadFailed={Boolean(deletionImpactQuery.error)}
        pending={deleteCollaborationWorkspace.isPending}
        errorMessage={deletionError.errorMessage}
        nameErrorMessage={deletionError.nameErrorMessage}
        onClose={() => {
          deletionError.clearError();
          setDeleteDialogOpen(false);
        }}
        onDelete={(confirmName) => {
          deletionError.clearError();
          deleteCollaborationWorkspace.mutate(
            { collaborationWorkspaceId, confirmName },
            {
              onSuccess: () => {
                setDeleteDialogOpen(false);
                onDeleted(collaborationWorkspaceId);
              },
              onError: (error) => deletionError.reportError(error)
            }
          );
        }}
      />
    </>
  );
}
