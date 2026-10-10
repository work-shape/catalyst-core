import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdministeredUser,
  AgentAvailability,
  AdministeredUserIdentity,
  ApiClient,
  OperationInput,
  ChangeCurrentUserPasswordRequest,
  CollaborationWorkspaceWithRole,
  ConversationListItem,
  ConversationThreadSnapshot,
  CreateApiCredentialRequest,
  CreateAdministeredUserRequest,
  CreateServicePrincipalRequest,
  UpdateAdministeredUserRequest,
  UpdateServicePrincipalRequest,
  UpdateCurrentUserRequest,
  UpsertAdministeredUserIdentityRequest,
  WorkspaceMembershipRole
} from "@vivd-catalyst/api-client";
import { signOut } from "@vivd-catalyst/api-client";
import { apiErrorMessage } from "../workspace-utils";
import { createAssetWrites } from "./asset-writes";
import { updateRailConversations } from "./rail-conversations";
import { workspaceQueryKeys } from "./workspace-query-keys";
import {
  createApiAccessRevealController,
  type RevealedApiCredential
} from "../control-plane/api-access-reveal-controller";

interface WorkspaceMutationInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

interface CollaborationWorkspaceScopedMutationInput extends WorkspaceMutationInput {
  collaborationWorkspaceId: string | undefined;
}

export function useApiAccessMutations(
  input: WorkspaceMutationInput & { authorityKey: string | undefined }
) {
  const queryClient = useQueryClient();
  const [credentialCreationPending, setCredentialCreationPending] = useState(false);
  const [revealedCredential, setRevealedCredential] = useState<RevealedApiCredential>();
  const revealControllerRef = useRef(createApiAccessRevealController(input.authorityKey));
  revealControllerRef.current.updateAuthority(input.authorityKey);
  const clearRevealedCredential = useCallback(() => setRevealedCredential(undefined), []);

  useEffect(() => {
    setRevealedCredential((current) =>
      current?.authorityKey === input.authorityKey ? current : undefined
    );
  }, [input.authorityKey]);

  const invalidateApiAccess = () => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.servicePrincipals(input.apiBaseUrl, input.authScope)
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
    });
  };

  const createPrincipal = useMutation({
    mutationFn: (mutationInput: CreateServicePrincipalRequest) =>
      input.client.service_principals.create({ body: mutationInput }),
    onSuccess: invalidateApiAccess
  });
  const updatePrincipal = useMutation({
    mutationFn: (mutationInput: { principalId: string; update: UpdateServicePrincipalRequest }) =>
      input.client.service_principals.update({
        params: { servicePrincipalId: mutationInput.principalId },
        body: mutationInput.update
      }),
    onSuccess: invalidateApiAccess
  });
  const createCredential = {
    mutateAsync: async (mutationInput: {
      principalId: string;
      credential: CreateApiCredentialRequest;
    }) => {
      const originAuthority = revealControllerRef.current.captureAuthority();
      setCredentialCreationPending(true);
      try {
        const response = await input.client.api_credentials.create({
          params: { servicePrincipalId: mutationInput.principalId },
          body: mutationInput.credential
        });
        const acceptedReveal = revealControllerRef.current.accept(originAuthority, {
          secret: response.secret,
          credentialName: response.credential.name,
          serverUrl: input.apiBaseUrl
        });
        if (acceptedReveal) {
          setRevealedCredential(acceptedReveal);
        }
        invalidateApiAccess();
        return response;
      } finally {
        setCredentialCreationPending(false);
      }
    }
  };
  const revokeCredential = useMutation({
    mutationFn: (credentialId: string) =>
      input.client.api_credentials.revoke({ params: { credentialId } }),
    onSuccess: invalidateApiAccess
  });

  return {
    createPrincipal,
    updatePrincipal,
    createCredential,
    revealedCredential:
      revealedCredential?.authorityKey === input.authorityKey ? revealedCredential : undefined,
    clearRevealedCredential,
    revokeCredential,
    isPending:
      createPrincipal.isPending ||
      updatePrincipal.isPending ||
      credentialCreationPending ||
      revokeCredential.isPending
  };
}

export function useDeleteConversationMutation(
  input: CollaborationWorkspaceScopedMutationInput & {
    selectedConversationId: string | undefined;
    clearConversationUploads(conversationId: string): void;
    onDeletedActiveConversation(nextSelectedConversationId: string | undefined): void;
    onDeletedConversation(): void;
    onErrorMessage(message: string | undefined): void;
  }
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (conversationId: string) =>
      input.client.conversations.delete({ params: { conversationId } }),
    onSuccess: (deletedConversation) => {
      let nextSelectedConversationId: string | undefined;
      const deletedActiveConversation = input.selectedConversationId === deletedConversation.id;
      updateRailConversations(
        queryClient,
        workspaceQueryKeys.conversations(
          input.apiBaseUrl,
          input.authScope,
          input.collaborationWorkspaceId
        ),
        (currentConversations) => {
          const remainingConversations = currentConversations.filter(
            (conversation) => conversation.id !== deletedConversation.id
          );
          nextSelectedConversationId =
            !input.selectedConversationId || input.selectedConversationId === deletedConversation.id
              ? remainingConversations[0]?.id
              : input.selectedConversationId;
          return remainingConversations;
        }
      );
      queryClient.removeQueries({
        queryKey: workspaceQueryKeys.thread(
          input.apiBaseUrl,
          input.authScope,
          deletedConversation.id
        )
      });
      queryClient.removeQueries({
        queryKey: workspaceQueryKeys.draftAttachments(
          input.apiBaseUrl,
          input.authScope,
          deletedConversation.id
        )
      });
      input.clearConversationUploads(deletedConversation.id);
      if (deletedActiveConversation) {
        input.onDeletedActiveConversation(nextSelectedConversationId);
      }
      input.onDeletedConversation();
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.conversations(
          input.apiBaseUrl,
          input.authScope,
          input.collaborationWorkspaceId
        )
      });
    },
    onError: (error) => {
      input.onErrorMessage(apiErrorMessage(error, "Delete failed"));
    }
  });
}

export function useRenameConversationMutation(
  input: CollaborationWorkspaceScopedMutationInput & {
    onErrorMessage(message: string | undefined): void;
  }
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) =>
      input.client.conversations.rename({ params: { conversationId }, body: { title } }),
    onSuccess: (updatedConversation) => {
      updateRailConversations(
        queryClient,
        workspaceQueryKeys.conversations(
          input.apiBaseUrl,
          input.authScope,
          input.collaborationWorkspaceId
        ),
        (currentConversations) =>
          currentConversations.map((conversation) =>
            conversation.id === updatedConversation.id
              ? { ...conversation, ...updatedConversation }
              : conversation
          )
      );
      queryClient.setQueryData<ConversationThreadSnapshot>(
        workspaceQueryKeys.thread(input.apiBaseUrl, input.authScope, updatedConversation.id),
        (current) =>
          current
            ? {
                ...current,
                conversation: updatedConversation
              }
            : current
      );
      input.onErrorMessage(undefined);
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.conversations(
          input.apiBaseUrl,
          input.authScope,
          input.collaborationWorkspaceId
        )
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
      });
    },
    onError: (error) => {
      input.onErrorMessage(apiErrorMessage(error, "Rename failed"));
    }
  });
}

export function useMoveConversationMutation(
  input: WorkspaceMutationInput & {
    sourceCollaborationWorkspaceId: string | undefined;
  }
) {
  const queryClient = useQueryClient();
  const conversationsKey = (collaborationWorkspaceId: string | undefined) =>
    workspaceQueryKeys.conversations(input.apiBaseUrl, input.authScope, collaborationWorkspaceId);

  return useMutation({
    mutationFn: (mutationInput: {
      conversationId: string;
      collaborationWorkspaceId: string;
      visibility?: ConversationListItem["visibility"];
    }) =>
      input.client.conversations.move({
        params: { conversationId: mutationInput.conversationId },
        body: {
          collaborationWorkspaceId: mutationInput.collaborationWorkspaceId,
          visibility: mutationInput.visibility
        }
      }),
    onSuccess: (movedConversation, { collaborationWorkspaceId }) => {
      // Dropped from the source list before the refetch lands so the rail never
      // shows a conversation that now lives in another workspace.
      updateRailConversations(
        queryClient,
        conversationsKey(input.sourceCollaborationWorkspaceId),
        (currentConversations) =>
          currentConversations.filter((conversation) => conversation.id !== movedConversation.id)
      );
      for (const listCollaborationWorkspaceId of new Set(
        [input.sourceCollaborationWorkspaceId, collaborationWorkspaceId].filter(
          (candidate): candidate is string => Boolean(candidate)
        )
      )) {
        void queryClient.invalidateQueries({
          queryKey: conversationsKey(listCollaborationWorkspaceId)
        });
      }
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.thread(input.apiBaseUrl, input.authScope, movedConversation.id)
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
      });
    }
  });
}

export type CreateCollaborationWorkspaceInput = OperationInput<"workspaces.create">["body"];
export type UpdateCollaborationWorkspaceInput = OperationInput<"workspaces.update">["body"];

export function useCollaborationWorkspaceMutations(input: WorkspaceMutationInput) {
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
    mutationFn: (mutationInput: CreateCollaborationWorkspaceInput) =>
      workspaces.create({ body: mutationInput }),
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
    mutationFn: (mutationInput: {
      collaborationWorkspaceId: string;
      update: UpdateCollaborationWorkspaceInput;
    }) =>
      workspaces.update({
        params: { collaborationWorkspaceId: mutationInput.collaborationWorkspaceId },
        body: mutationInput.update
      }),
    onSuccess: () => {
      invalidateCollaborationWorkspaces();
      invalidateDirectory();
    }
  });
  const deleteCollaborationWorkspace = useMutation({
    mutationFn: (mutationInput: { collaborationWorkspaceId: string; confirmName: string }) =>
      workspaces.delete({
        params: { collaborationWorkspaceId: mutationInput.collaborationWorkspaceId },
        body: { confirmName: mutationInput.confirmName }
      }),
    onSuccess: (_deletion, { collaborationWorkspaceId }) => {
      // Dropped before the refetch lands so the route guard cannot bounce back
      // into the workspace that no longer exists.
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
    mutationFn: (mutationInput: { collaborationWorkspaceId: string; email: string }) =>
      workspaces.members.add({
        params: { collaborationWorkspaceId: mutationInput.collaborationWorkspaceId },
        body: { email: mutationInput.email }
      }),
    onSuccess: (_member, { collaborationWorkspaceId }) =>
      invalidateMembership(collaborationWorkspaceId)
  });
  const changeCollaborationWorkspaceMemberRole = useMutation({
    mutationFn: (mutationInput: {
      collaborationWorkspaceId: string;
      userId: string;
      role: WorkspaceMembershipRole;
    }) =>
      workspaces.members.update_role({
        params: {
          collaborationWorkspaceId: mutationInput.collaborationWorkspaceId,
          userId: mutationInput.userId
        },
        body: { role: mutationInput.role }
      }),
    onSuccess: (_membership, { collaborationWorkspaceId }) =>
      invalidateMembership(collaborationWorkspaceId)
  });
  const removeCollaborationWorkspaceMember = useMutation({
    mutationFn: (params: { collaborationWorkspaceId: string; userId: string }) =>
      workspaces.members.remove({ params }),
    onSuccess: (_membership, { collaborationWorkspaceId }) =>
      invalidateMembership(collaborationWorkspaceId)
  });
  const leaveCollaborationWorkspace = useMutation({
    mutationFn: (collaborationWorkspaceId: string) =>
      workspaces.members.leave({ params: { collaborationWorkspaceId } }),
    onSuccess: (_membership, collaborationWorkspaceId) => {
      invalidateMembership(collaborationWorkspaceId);
      invalidateDirectory();
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.conversationsScope(apiBaseUrl, authScope)
      });
    }
  });
  const requestCollaborationWorkspaceAccess = useMutation({
    mutationFn: (collaborationWorkspaceId: string) =>
      workspaces.access_requests.create({ params: { collaborationWorkspaceId } }),
    onSuccess: invalidateDirectory
  });
  const approveCollaborationWorkspaceAccessRequest = useMutation({
    mutationFn: (params: { collaborationWorkspaceId: string; userId: string }) =>
      workspaces.access_requests.approve({ params }),
    onSuccess: (_membership, { collaborationWorkspaceId }) =>
      invalidateMembership(collaborationWorkspaceId)
  });
  const declineCollaborationWorkspaceAccessRequest = useMutation({
    mutationFn: (params: { collaborationWorkspaceId: string; userId: string }) =>
      workspaces.access_requests.decline({ params }),
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

export function useWorkspaceSignOutMutation(input: { apiBaseUrl: string; onSignedOut(): void }) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => signOut(input.apiBaseUrl),
    onSuccess: () => {
      input.onSignedOut();
      void queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.me(input.apiBaseUrl) });
    }
  });
}

export function useCancelRunMutation(
  input: CollaborationWorkspaceScopedMutationInput & {
    onErrorMessage(message: string | undefined): void;
  }
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { conversationId: string; runId: string }) =>
      input.client.conversations.runs.cancel({ params, body: { reason: "user_requested" } }),
    onMutate: ({ conversationId, runId }) => {
      queryClient.setQueryData<ConversationThreadSnapshot>(
        workspaceQueryKeys.thread(input.apiBaseUrl, input.authScope, conversationId),
        (current) => markThreadRunCancelling(current, runId)
      );
    },
    onSuccess: (_response, { conversationId }) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.thread(input.apiBaseUrl, input.authScope, conversationId)
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.conversations(
          input.apiBaseUrl,
          input.authScope,
          input.collaborationWorkspaceId
        )
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
      });
    },
    onError: (error) => {
      input.onErrorMessage(apiErrorMessage(error, "Cancel failed"));
    }
  });
}

export function useUpdateCurrentUserMutation(input: WorkspaceMutationInput) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mutationInput: UpdateCurrentUserRequest) =>
      input.client.me.update({ body: mutationInput }),
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(workspaceQueryKeys.me(input.apiBaseUrl), updatedUser);
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
      });
    }
  });
}

export function useChangeCurrentUserPasswordMutation(input: WorkspaceMutationInput) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mutationInput: ChangeCurrentUserPasswordRequest) =>
      input.client.me.password.change({ body: mutationInput }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
      });
    }
  });
}

export function useDeleteCurrentUserMutation(
  input: WorkspaceMutationInput & {
    onDeleted(): void;
  }
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => input.client.me.delete(),
    onSuccess: () => {
      input.onDeleted();
      queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.me(input.apiBaseUrl) });
    }
  });
}

export function useConfigAssetMutations(input: WorkspaceMutationInput) {
  const queryClient = useQueryClient();

  const invalidateConfigAssets = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.configAssetsOverview(input.apiBaseUrl, input.authScope)
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
      })
    ]);
  };

  const assetWrites = createAssetWrites({
    client: input.client,
    queryClient,
    overviewKey: workspaceQueryKeys.configAssetsOverview(input.apiBaseUrl, input.authScope)
  });
  const putAsset = useMutation({ mutationFn: assetWrites.put, onSuccess: invalidateConfigAssets });
  const deleteAsset = useMutation({
    mutationFn: assetWrites.delete,
    onSuccess: invalidateConfigAssets
  });
  const setDefaultAgent = useMutation({
    mutationFn: (mutationInput: { agentName?: string; baseVersion?: number }) =>
      input.client.config_agents.set_default({ body: mutationInput }),
    onSuccess: () => invalidateConfigAssets()
  });
  const setAgentAvailability = useMutation({
    mutationFn: (mutationInput: {
      name: string;
      mode: AgentAvailability["mode"];
      personalWorkspaces: boolean;
      collaborationWorkspaceIds: string[];
    }) => {
      const { name, ...availability } = mutationInput;
      return input.client.config_agents.set_availability({ params: { name }, body: availability });
    },
    // The admin's own picker reads the same lists, so it follows the change at once.
    onSuccess: () =>
      Promise.all([
        invalidateConfigAssets(),
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.collaborationWorkspaceAgentsScope(
            input.apiBaseUrl,
            input.authScope
          )
        }),
        queryClient.invalidateQueries({ queryKey: ["config", input.apiBaseUrl, input.authScope] })
      ])
  });
  const revertAsset = useMutation({
    mutationFn: assetWrites.revert,
    onSuccess: invalidateConfigAssets
  });

  return {
    putAsset,
    deleteAsset,
    setDefaultAgent,
    setAgentAvailability,
    revertAsset,
    isPending:
      putAsset.isPending ||
      deleteAsset.isPending ||
      setDefaultAgent.isPending ||
      setAgentAvailability.isPending ||
      revertAsset.isPending
  };
}

export function useSuperadminUserMutations(input: WorkspaceMutationInput) {
  const queryClient = useQueryClient();

  const invalidateSuperadminUsers = () => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.superadminUsers(input.apiBaseUrl, input.authScope)
    });
  };
  const invalidateAuditEvents = () => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
    });
  };

  const createUser = useMutation({
    mutationFn: (mutationInput: CreateAdministeredUserRequest) =>
      input.client.users.create({ body: mutationInput }),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const updateUser = useMutation({
    mutationFn: (mutationInput: { userId: string; update: UpdateAdministeredUserRequest }) =>
      input.client.users.update({
        params: { userId: mutationInput.userId },
        body: mutationInput.update
      }),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const deleteUser = useMutation({
    mutationFn: (userId: string) => input.client.users.delete({ params: { userId } }),
    onSuccess: (deletedUser) => {
      // Without a user the account is closed and still being removed: the list reads it so.
      if (deletedUser) {
        queryClient.setQueryData<AdministeredUser[]>(
          workspaceQueryKeys.superadminUsers(input.apiBaseUrl, input.authScope),
          (currentUsers = []) => currentUsers.filter((user) => user.id !== deletedUser.id)
        );
      }
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const upsertUserIdentity = useMutation({
    mutationFn: (mutationInput: {
      userId: string;
      identity: UpsertAdministeredUserIdentityRequest;
    }) =>
      input.client.users.identities.upsert({
        params: { userId: mutationInput.userId },
        body: mutationInput.identity
      }),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const deleteUserIdentity = useMutation({
    mutationFn: (mutationInput: { userId: string; identity: AdministeredUserIdentity }) =>
      input.client.users.identities.delete({
        params: {
          userId: mutationInput.userId,
          authSource: mutationInput.identity.authSource,
          externalUserId: mutationInput.identity.externalUserId
        }
      }),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const resetUserPassword = useMutation({
    mutationFn: (mutationInput: { userId: string; password: string }) =>
      input.client.users.password.reset({
        params: { userId: mutationInput.userId },
        body: { password: mutationInput.password }
      }),
    onSuccess: () => {
      invalidateAuditEvents();
    }
  });
  const sendUserInvitation = useMutation({
    mutationFn: (userId: string) => input.client.users.invitation.send({ params: { userId } }),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });

  return {
    createUser,
    updateUser,
    deleteUser,
    upsertUserIdentity,
    deleteUserIdentity,
    resetUserPassword,
    sendUserInvitation,
    isPending:
      createUser.isPending ||
      updateUser.isPending ||
      deleteUser.isPending ||
      upsertUserIdentity.isPending ||
      deleteUserIdentity.isPending ||
      resetUserPassword.isPending ||
      sendUserInvitation.isPending
  };
}

function markThreadRunCancelling(
  thread: ConversationThreadSnapshot | undefined,
  runId: string
): ConversationThreadSnapshot | undefined {
  if (!thread?.activeRun || thread.activeRun.run.id !== runId) {
    return thread;
  }
  return {
    ...thread,
    activeRun: {
      run: {
        ...thread.activeRun.run,
        status: "cancelling",
        updatedAt: new Date().toISOString()
      },
      projection: {
        ...thread.activeRun.projection,
        status: "cancelling"
      }
    }
  };
}
