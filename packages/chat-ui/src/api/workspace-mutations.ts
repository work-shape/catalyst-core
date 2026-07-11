import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AdministeredUser,
  ConfigAssetKind,
  AdministeredUserIdentity,
  ApiClient,
  ChangeCurrentUserPasswordRequest,
  ConversationListItem,
  ConversationThreadSnapshot,
  CreateAdministeredUserRequest,
  UpdateAdministeredUserRequest,
  UpdateCurrentUserRequest,
  UpsertAdministeredUserIdentityRequest
} from "@vivd-catalyst/api-client";
import { signOut } from "../auth-client";
import { apiErrorMessage } from "../workspace-utils";
import { workspaceQueryKeys } from "./workspace-query-keys";

interface WorkspaceMutationInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

export function useDeleteConversationMutation(
  input: WorkspaceMutationInput & {
    selectedConversationId: string | undefined;
    clearConversationUploads(conversationId: string): void;
    onDeletedActiveConversation(nextSelectedConversationId: string | undefined): void;
    onDeletedConversation(): void;
    onErrorMessage(message: string | undefined): void;
  }
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (conversationId: string) => input.client.deleteConversation(conversationId),
    onSuccess: (deletedConversation) => {
      let nextSelectedConversationId: string | undefined;
      const deletedActiveConversation = input.selectedConversationId === deletedConversation.id;
      queryClient.setQueryData<ConversationListItem[]>(
        workspaceQueryKeys.conversations(input.apiBaseUrl, input.authScope),
        (currentConversations = []) => {
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
        queryKey: workspaceQueryKeys.thread(input.apiBaseUrl, input.authScope, deletedConversation.id)
      });
      queryClient.removeQueries({
        queryKey: workspaceQueryKeys.draftAttachments(input.apiBaseUrl, input.authScope, deletedConversation.id)
      });
      input.clearConversationUploads(deletedConversation.id);
      if (deletedActiveConversation) {
        input.onDeletedActiveConversation(nextSelectedConversationId);
      }
      input.onDeletedConversation();
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.conversations(input.apiBaseUrl, input.authScope)
      });
    },
    onError: (error) => {
      input.onErrorMessage(apiErrorMessage(error, "Delete failed"));
    }
  });
}

export function useWorkspaceSignOutMutation(input: {
  apiBaseUrl: string;
  onSignedOut(): void;
}) {
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
  input: WorkspaceMutationInput & {
    onErrorMessage(message: string | undefined): void;
  }
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mutationInput: { conversationId: string; runId: string }) =>
      input.client.cancelRun(mutationInput.conversationId, mutationInput.runId, {
        reason: "user_requested"
      }),
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
        queryKey: workspaceQueryKeys.conversations(input.apiBaseUrl, input.authScope)
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
    mutationFn: (mutationInput: UpdateCurrentUserRequest) => input.client.updateMe(mutationInput),
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
      input.client.changeMyPassword(mutationInput),
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
    mutationFn: () => input.client.deleteMe(),
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

  const putAsset = useMutation({
    mutationFn: (mutationInput: {
      kind: ConfigAssetKind;
      name: string;
      config: Record<string, unknown>;
      baseVersion?: number;
    }) =>
      input.client.putConfigAsset(mutationInput.kind, mutationInput.name, {
        config: mutationInput.config,
        baseVersion: mutationInput.baseVersion
      }),
    onSuccess: invalidateConfigAssets
  });
  const deleteAsset = useMutation({
    mutationFn: (mutationInput: { kind: ConfigAssetKind; name: string; baseVersion?: number }) =>
      input.client.deleteConfigAsset(mutationInput.kind, mutationInput.name, {
        baseVersion: mutationInput.baseVersion
      }),
    onSuccess: invalidateConfigAssets
  });
  const setDefaultAgent = useMutation({
    mutationFn: (mutationInput: { agentName?: string; baseVersion?: number }) =>
      input.client.setDefaultConfigAgent(mutationInput),
    onSuccess: () => invalidateConfigAssets()
  });
  const revertAsset = useMutation({
    mutationFn: (mutationInput: {
      kind: ConfigAssetKind;
      name: string;
      revision: number;
      baseVersion?: number;
    }) =>
      input.client.revertConfigAsset(mutationInput.kind, mutationInput.name, {
        revision: mutationInput.revision,
        baseVersion: mutationInput.baseVersion
      }),
    onSuccess: invalidateConfigAssets
  });

  return {
    putAsset,
    deleteAsset,
    setDefaultAgent,
    revertAsset,
    isPending:
      putAsset.isPending || deleteAsset.isPending || setDefaultAgent.isPending || revertAsset.isPending
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
    mutationFn: (mutationInput: CreateAdministeredUserRequest) => input.client.createUser(mutationInput),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const updateUser = useMutation({
    mutationFn: (mutationInput: { userId: string; update: UpdateAdministeredUserRequest }) =>
      input.client.updateUser(mutationInput.userId, mutationInput.update),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const deleteUser = useMutation({
    mutationFn: (userId: string) => input.client.deleteUser(userId),
    onSuccess: (deletedUser) => {
      queryClient.setQueryData<AdministeredUser[]>(
        workspaceQueryKeys.superadminUsers(input.apiBaseUrl, input.authScope),
        (currentUsers = []) => currentUsers.filter((user) => user.id !== deletedUser.id)
      );
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const upsertUserIdentity = useMutation({
    mutationFn: (mutationInput: {
      userId: string;
      identity: UpsertAdministeredUserIdentityRequest;
    }) => input.client.upsertUserIdentity(mutationInput.userId, mutationInput.identity),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const deleteUserIdentity = useMutation({
    mutationFn: (mutationInput: { userId: string; identity: AdministeredUserIdentity }) =>
      input.client.deleteUserIdentity(
        mutationInput.userId,
        mutationInput.identity.authSource,
        mutationInput.identity.externalUserId
      ),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const resetUserPassword = useMutation({
    mutationFn: (mutationInput: { userId: string; password: string }) =>
      input.client.resetUserPassword(mutationInput.userId, { password: mutationInput.password }),
    onSuccess: () => {
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
    isPending:
      createUser.isPending ||
      updateUser.isPending ||
      deleteUser.isPending ||
      upsertUserIdentity.isPending ||
      deleteUserIdentity.isPending ||
      resetUserPassword.isPending
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
