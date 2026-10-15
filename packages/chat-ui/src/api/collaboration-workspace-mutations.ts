import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  ApiClient,
  CollaborationWorkspaceWithRole,
  OperationInput,
  OperationOutcome,
  WorkspaceMembershipRole
} from "@work-shape/catalyst-api-client";
import { CollaborationWorkspaceChangeHeldError } from "../collaboration-workspace/collaboration-workspace-errors";
import { workspaceQueryKeys } from "./workspace-query-keys";

interface CollaborationWorkspaceMutationInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

/**
 * The output of a workspace change that ran. A change that waits for somebody else's approval
 * changed nothing: it fails with an error the workspace screens show as their own sentence.
 */
function workspaceChangeOutput<Output>(outcome: OperationOutcome<Output>): Output {
  if (outcome.status === "done") return outcome.output;
  throw new CollaborationWorkspaceChangeHeldError();
}

export type CreateCollaborationWorkspaceInput = OperationInput<"workspaces.create">["body"];
export type UpdateCollaborationWorkspaceInput = OperationInput<"workspaces.update">["body"];

/**
 * The ten changes of workspaces, members and access requests. Each is an Operation Run and
 * answers its output once it ran.
 */
export function useCollaborationWorkspaceMutations(input: CollaborationWorkspaceMutationInput) {
  const queryClient = useQueryClient();
  const { apiBaseUrl, authScope, client } = input;
  const { workspaces } = client;

  const invalidateCollaborationWorkspaces = () => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.collaborationWorkspaces(apiBaseUrl, authScope)
    });
  };
  const invalidateDirectory = () => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.collaborationWorkspaceDirectory(apiBaseUrl, authScope)
    });
  };
  const invalidateMembership = (collaborationWorkspaceId: string) => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.collaborationWorkspaceMembers(
        apiBaseUrl,
        authScope,
        collaborationWorkspaceId
      )
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.collaborationWorkspaceAccessRequests(
        apiBaseUrl,
        authScope,
        collaborationWorkspaceId
      )
    });
    invalidateCollaborationWorkspaces();
  };

  const createCollaborationWorkspace = useMutation({
    mutationFn: async (mutationInput: CreateCollaborationWorkspaceInput) =>
      workspaceChangeOutput(await workspaces.create({ body: mutationInput })),
    onSuccess: (created) => {
      // Seeded before the refetch lands so navigating into the new workspace
      // cannot race a stale list and bounce back to the Personal Workspace.
      queryClient.setQueryData<CollaborationWorkspaceWithRole[]>(
        workspaceQueryKeys.collaborationWorkspaces(apiBaseUrl, authScope),
        (currentCollaborationWorkspaces = []) =>
          currentCollaborationWorkspaces.some(
            (collaborationWorkspace) => collaborationWorkspace.id === created.id
          )
            ? currentCollaborationWorkspaces
            : [...currentCollaborationWorkspaces, created]
      );
      invalidateCollaborationWorkspaces();
      invalidateDirectory();
    }
  });
  const updateCollaborationWorkspace = useMutation({
    mutationFn: async (mutationInput: {
      collaborationWorkspaceId: string;
      update: UpdateCollaborationWorkspaceInput;
    }) =>
      workspaceChangeOutput(
        await workspaces.update({
          params: { collaborationWorkspaceId: mutationInput.collaborationWorkspaceId },
          body: mutationInput.update
        })
      ),
    onSuccess: () => {
      invalidateCollaborationWorkspaces();
      invalidateDirectory();
    }
  });
  const deleteCollaborationWorkspace = useMutation({
    // Answers the state `deleted` or `deleting`. In both the workspace is closed to everybody,
    // so both leave the list; a call that waits for an approval fails and leaves it there.
    mutationFn: async (mutationInput: { collaborationWorkspaceId: string; confirmName: string }) =>
      workspaceChangeOutput(
        await workspaces.delete({
          params: { collaborationWorkspaceId: mutationInput.collaborationWorkspaceId },
          body: { confirmName: mutationInput.confirmName }
        })
      ),
    onSuccess: (_deletion, { collaborationWorkspaceId }) => {
      // Dropped before the refetch lands so the route guard cannot bounce back
      // into the workspace that is closed.
      queryClient.setQueryData<CollaborationWorkspaceWithRole[]>(
        workspaceQueryKeys.collaborationWorkspaces(apiBaseUrl, authScope),
        (currentCollaborationWorkspaces = []) =>
          currentCollaborationWorkspaces.filter(
            (collaborationWorkspace) => collaborationWorkspace.id !== collaborationWorkspaceId
          )
      );
      invalidateCollaborationWorkspaces();
      invalidateDirectory();
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.conversationsScope(apiBaseUrl, authScope)
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.auditEvents(apiBaseUrl, authScope)
      });
    }
  });
  const addCollaborationWorkspaceMember = useMutation({
    mutationFn: async (mutationInput: { collaborationWorkspaceId: string; email: string }) =>
      workspaceChangeOutput(
        await workspaces.members.add({
          params: { collaborationWorkspaceId: mutationInput.collaborationWorkspaceId },
          body: { email: mutationInput.email }
        })
      ),
    onSuccess: (_member, { collaborationWorkspaceId }) =>
      invalidateMembership(collaborationWorkspaceId)
  });
  const changeCollaborationWorkspaceMemberRole = useMutation({
    mutationFn: async (mutationInput: {
      collaborationWorkspaceId: string;
      userId: string;
      role: WorkspaceMembershipRole;
    }) =>
      workspaceChangeOutput(
        await workspaces.members.update_role({
          params: {
            collaborationWorkspaceId: mutationInput.collaborationWorkspaceId,
            userId: mutationInput.userId
          },
          body: { role: mutationInput.role }
        })
      ),
    onSuccess: (_membership, { collaborationWorkspaceId }) =>
      invalidateMembership(collaborationWorkspaceId)
  });
  const removeCollaborationWorkspaceMember = useMutation({
    mutationFn: async (params: { collaborationWorkspaceId: string; userId: string }) =>
      workspaceChangeOutput(await workspaces.members.remove({ params })),
    onSuccess: (_membership, { collaborationWorkspaceId }) =>
      invalidateMembership(collaborationWorkspaceId)
  });
  const leaveCollaborationWorkspace = useMutation({
    mutationFn: async (collaborationWorkspaceId: string) =>
      workspaceChangeOutput(
        await workspaces.members.leave({ params: { collaborationWorkspaceId } })
      ),
    onSuccess: (_membership, collaborationWorkspaceId) => {
      invalidateMembership(collaborationWorkspaceId);
      invalidateDirectory();
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.conversationsScope(apiBaseUrl, authScope)
      });
    }
  });
  const requestCollaborationWorkspaceAccess = useMutation({
    mutationFn: async (collaborationWorkspaceId: string) =>
      workspaceChangeOutput(
        await workspaces.access_requests.create({ params: { collaborationWorkspaceId } })
      ),
    onSuccess: invalidateDirectory
  });
  const approveCollaborationWorkspaceAccessRequest = useMutation({
    mutationFn: async (params: { collaborationWorkspaceId: string; userId: string }) =>
      workspaceChangeOutput(await workspaces.access_requests.approve({ params })),
    onSuccess: (_membership, { collaborationWorkspaceId }) =>
      invalidateMembership(collaborationWorkspaceId)
  });
  const declineCollaborationWorkspaceAccessRequest = useMutation({
    mutationFn: async (params: { collaborationWorkspaceId: string; userId: string }) =>
      workspaceChangeOutput(await workspaces.access_requests.decline({ params })),
    onSuccess: (_request, { collaborationWorkspaceId }) =>
      invalidateMembership(collaborationWorkspaceId)
  });

  return {
    createCollaborationWorkspace,
    updateCollaborationWorkspace,
    deleteCollaborationWorkspace,
    addCollaborationWorkspaceMember,
    changeCollaborationWorkspaceMemberRole,
    removeCollaborationWorkspaceMember,
    leaveCollaborationWorkspace,
    requestCollaborationWorkspaceAccess,
    approveCollaborationWorkspaceAccessRequest,
    declineCollaborationWorkspaceAccessRequest
  };
}
