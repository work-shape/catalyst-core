import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
  ApiClient,
  ApiUser,
  ChangeCurrentUserPasswordRequest,
  ConversationListItem,
  ConversationThreadSnapshot,
  CreateApiCredentialRequest,
  CreateAdministeredUserRequest,
  CreateServicePrincipalRequest,
  UpdateAdministeredUserRequest,
  UpdateServicePrincipalRequest,
  UpdateCurrentUserRequest,
  UpsertAdministeredUserIdentityRequest
} from "@work-shape/catalyst-api-client";
import { completedOutput, signOut } from "@work-shape/catalyst-api-client";
import { apiErrorMessage } from "../workspace-utils";
import { updateRailConversations } from "./rail-conversations";
import { workspaceQueryKeys } from "./workspace-query-keys";
import { useWorkspaceApiClient } from "./workspace-api-client";
import {
  createApiAccessRevealController,
  type RevealedApiCredential
} from "./api-access-reveal-controller";

interface WorkspaceMutationInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

interface CollaborationWorkspaceScopedMutationInput extends WorkspaceMutationInput {
  collaborationWorkspaceId: string | undefined;
}

/**
 * The four changes of API access. Each is an Operation Run and answers its output once it ran.
 * A change that waits for somebody else's approval changed nothing, and is reported to the
 * screen as a failure with `heldMessage`.
 */
export function useApiAccessMutations(
  input: WorkspaceMutationInput & { authorityKey: string | undefined; heldMessage: string }
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
    mutationFn: async (mutationInput: CreateServicePrincipalRequest) =>
      completedOutput(
        await input.client.service_principals.create({ body: mutationInput }),
        input.heldMessage
      ),
    onSuccess: invalidateApiAccess
  });
  const updatePrincipal = useMutation({
    mutationFn: async (mutationInput: {
      principalId: string;
      update: UpdateServicePrincipalRequest;
    }) =>
      completedOutput(
        await input.client.service_principals.update({
          params: { servicePrincipalId: mutationInput.principalId },
          body: mutationInput.update
        }),
        input.heldMessage
      ),
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
        // This call is never held for an approval: its answer is the key, shown once.
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
    mutationFn: async (credentialId: string) =>
      completedOutput(
        await input.client.api_credentials.revoke({ params: { credentialId } }),
        input.heldMessage
      ),
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

export function useWorkspaceSignOutMutation(input: { apiBaseUrl: string; onSignedOut(): void }) {
  const queryClient = useQueryClient();
  const { cancelRequests } = useWorkspaceApiClient();

  return useMutation({
    onMutate: async () => {
      // Stop HTTP requests and query retries before the server revokes the session cookie.
      const resumeRequests = cancelRequests();
      await queryClient.cancelQueries();
      return resumeRequests;
    },
    mutationFn: () => signOut(input.apiBaseUrl),
    onSuccess: () => {
      // Let the shell unmount the old observers before it clears their cache. Clearing it
      // here lets those observers recreate queries with the previous person's workspace.
      queryClient.setQueryData(workspaceQueryKeys.me(input.apiBaseUrl), null);
      input.onSignedOut();
    },
    onError: async (_error, _variables, resumeRequests) => {
      resumeRequests?.();
      await queryClient.invalidateQueries();
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

/**
 * A save of the signed-in account's own record. Saves of one account go one after the other,
 * so the last one sent is the one kept, and an answer for an account that is no longer the
 * signed-in one leaves the record of the next one alone.
 */
export function currentUserUpdateOptions(
  input: WorkspaceMutationInput & { userId: string },
  queryClient: QueryClient
) {
  const meKey = workspaceQueryKeys.me(input.apiBaseUrl);
  return {
    mutationKey: workspaceQueryKeys.meUpdate(input.apiBaseUrl, input.userId),
    scope: { id: `me-update:${input.apiBaseUrl}:${input.userId}` },
    mutationFn: (mutationInput: UpdateCurrentUserRequest) => {
      // A save waits for the earlier ones of its account. Whoever signed in meanwhile holds the
      // session now, so a save of the account before is never sent: it would change theirs.
      // No message of its own: the caller's general one says that it was not saved.
      if (queryClient.getQueryData<ApiUser>(meKey)?.id !== input.userId) {
        return Promise.reject(new Error());
      }
      return input.client.me.update({ body: mutationInput });
    },
    onSuccess: (updatedUser: ApiUser) => {
      queryClient.setQueryData<ApiUser>(meKey, (current) =>
        current?.id === updatedUser.id ? updatedUser : current
      );
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
      });
    }
  };
}

export function useUpdateCurrentUserMutation(input: WorkspaceMutationInput & { userId: string }) {
  return useMutation(currentUserUpdateOptions(input, useQueryClient()));
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

export function useSuperadminUserMutations(
  input: WorkspaceMutationInput & { heldMessage: string }
) {
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
    mutationFn: async (mutationInput: CreateAdministeredUserRequest) =>
      completedOutput(await input.client.users.create({ body: mutationInput }), input.heldMessage),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const updateUser = useMutation({
    mutationFn: async (mutationInput: { userId: string; update: UpdateAdministeredUserRequest }) =>
      completedOutput(
        await input.client.users.update({
          params: { userId: mutationInput.userId },
          body: mutationInput.update
        }),
        input.heldMessage
      ),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const deleteUser = useMutation({
    mutationFn: async (userId: string) =>
      completedOutput(await input.client.users.delete({ params: { userId } }), input.heldMessage),
    onSuccess: (answer, userId) => {
      // A deleted account leaves the cache; a deleting account stays until the list refreshes.
      if (answer.state === "deleted") {
        queryClient.setQueryData<AdministeredUser[]>(
          workspaceQueryKeys.superadminUsers(input.apiBaseUrl, input.authScope),
          (currentUsers = []) => currentUsers.filter((user) => user.id !== userId)
        );
      }
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const upsertUserIdentity = useMutation({
    mutationFn: async (mutationInput: {
      userId: string;
      identity: UpsertAdministeredUserIdentityRequest;
    }) =>
      completedOutput(
        await input.client.users.identities.upsert({
          params: { userId: mutationInput.userId },
          body: mutationInput.identity
        }),
        input.heldMessage
      ),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const deleteUserIdentity = useMutation({
    mutationFn: async (mutationInput: { userId: string; identity: AdministeredUserIdentity }) =>
      completedOutput(
        await input.client.users.identities.delete({
          params: {
            userId: mutationInput.userId,
            authSource: mutationInput.identity.authSource,
            externalUserId: mutationInput.identity.externalUserId
          }
        }),
        input.heldMessage
      ),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const resetUserPassword = useMutation({
    // This call is never held for an approval: it sets a password and keeps no answer.
    mutationFn: (mutationInput: { userId: string; password: string }) =>
      input.client.users.password.reset({
        params: { userId: mutationInput.userId },
        body: { password: mutationInput.password }
      }),
    onSuccess: () => {
      invalidateAuditEvents();
    }
  });
  const resetUserTwoFactor = useMutation({
    mutationFn: async (userId: string) =>
      completedOutput(
        await input.client.users.two_factor.reset({ params: { userId } }),
        input.heldMessage
      ),
    onSuccess: () => {
      invalidateSuperadminUsers();
      invalidateAuditEvents();
    }
  });
  const sendUserInvitation = useMutation({
    mutationFn: async (userId: string) =>
      completedOutput(
        await input.client.users.invitation.send({ params: { userId } }),
        input.heldMessage
      ),
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
    resetUserTwoFactor,
    sendUserInvitation,
    isPending:
      createUser.isPending ||
      updateUser.isPending ||
      deleteUser.isPending ||
      upsertUserIdentity.isPending ||
      deleteUserIdentity.isPending ||
      resetUserPassword.isPending ||
      resetUserTwoFactor.isPending ||
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
