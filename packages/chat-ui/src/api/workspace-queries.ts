import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ApiClient,
  ConversationListItem,
  ConversationThreadSnapshot,
  DraftAttachment,
  LocaleCode,
  RunObservation,
  StartConversationRunResponse
} from "@vivd-catalyst/api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";

interface WorkspaceQueryInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

export function useWorkspaceMeQuery(input: Pick<WorkspaceQueryInput, "apiBaseUrl" | "client">) {
  return useQuery({
    queryKey: workspaceQueryKeys.me(input.apiBaseUrl),
    queryFn: input.client.account.get,
    retry: false
  });
}

export function useWorkspaceConfigQuery(
  input: WorkspaceQueryInput & {
    localePreference: LocaleCode | undefined;
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.config(input.apiBaseUrl, input.authScope, input.localePreference),
    queryFn: () => input.client.configuration.get(input.localePreference),
    enabled: input.enabled
  });
}

export function useWorkspaceConversationsQuery(
  input: WorkspaceQueryInput & {
    collaborationWorkspaceId: string | undefined;
    enabled: boolean;
  }
) {
  const collaborationWorkspaceId = input.collaborationWorkspaceId;
  return useQuery({
    queryKey: workspaceQueryKeys.conversations(
      input.apiBaseUrl,
      input.authScope,
      collaborationWorkspaceId
    ),
    queryFn: () => input.client.conversations.list(collaborationWorkspaceId ?? ""),
    enabled: input.enabled && Boolean(collaborationWorkspaceId)
  });
}

export function useCollaborationWorkspacesQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.collaborationWorkspaces(input.apiBaseUrl, input.authScope),
    queryFn: () => input.client.collaborationWorkspaces.list(),
    enabled: input.enabled
  });
}

export function useCollaborationWorkspaceDirectoryQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.collaborationWorkspaceDirectory(input.apiBaseUrl, input.authScope),
    queryFn: () => input.client.collaborationWorkspaces.browseDirectory(),
    enabled: input.enabled
  });
}

export function useCollaborationWorkspaceMembersQuery(
  input: WorkspaceQueryInput & {
    collaborationWorkspaceId: string;
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.collaborationWorkspaceMembers(
      input.apiBaseUrl,
      input.authScope,
      input.collaborationWorkspaceId
    ),
    queryFn: () =>
      input.client.collaborationWorkspaces.members.list(input.collaborationWorkspaceId),
    enabled: input.enabled
  });
}

export function useCollaborationWorkspaceAccessRequestsQuery(
  input: WorkspaceQueryInput & {
    collaborationWorkspaceId: string;
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.collaborationWorkspaceAccessRequests(
      input.apiBaseUrl,
      input.authScope,
      input.collaborationWorkspaceId
    ),
    queryFn: () =>
      input.client.collaborationWorkspaces.accessRequests.list(input.collaborationWorkspaceId),
    enabled: input.enabled
  });
}

export function useWorkspaceThreadQuery(
  input: WorkspaceQueryInput & {
    conversationId: string | undefined;
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.thread(input.apiBaseUrl, input.authScope, input.conversationId),
    queryFn: () => input.client.conversations.getThread(input.conversationId ?? ""),
    enabled: input.enabled
  });
}

export function useConversationResourcesQuery(
  input: WorkspaceQueryInput & {
    conversationId: string | undefined;
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.conversationResources(
      input.apiBaseUrl,
      input.authScope,
      input.conversationId
    ),
    queryFn: () => input.client.conversations.resources.list(input.conversationId ?? ""),
    enabled: input.enabled
  });
}

export function useStructuredDataResourceQuery(
  input: WorkspaceQueryInput & {
    conversationId: string;
    structuredDataResourceId: string;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.structuredDataResource(
      input.apiBaseUrl,
      input.authScope,
      input.conversationId,
      input.structuredDataResourceId
    ),
    queryFn: () =>
      input.client.conversations.resources.getStructuredData(
        input.conversationId,
        input.structuredDataResourceId
      )
  });
}

export function useWorkspaceUsageQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.usage(input.apiBaseUrl, input.authScope),
    queryFn: input.client.governance.getUsageSummary,
    enabled: input.enabled
  });
}

export function useWorkspaceAuditActivitiesQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    // `auditEvents` is the historical cache namespace; it now holds the
    // projected activity timeline served from /api/audit-activities.
    queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope),
    queryFn: input.client.governance.listAuditActivities,
    enabled: input.enabled
  });
}

export function useWorkspaceUsersQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.superadminUsers(input.apiBaseUrl, input.authScope),
    queryFn: input.client.users.list,
    enabled: input.enabled
  });
}

export function useServicePrincipalsQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.servicePrincipals(input.apiBaseUrl, input.authScope),
    queryFn: input.client.apiAccess.listServicePrincipals,
    enabled: input.enabled
  });
}

export function useConfigAssetsOverviewQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.configAssetsOverview(input.apiBaseUrl, input.authScope),
    queryFn: input.client.configAssets.getOverview,
    enabled: input.enabled
  });
}

export function useConfigAssetsExportQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: [
      ...workspaceQueryKeys.configAssetsOverview(input.apiBaseUrl, input.authScope),
      "export"
    ] as const,
    queryFn: input.client.configAssets.export,
    enabled: input.enabled
  });
}

export interface WorkspaceCacheActions {
  refreshThreadSnapshot(conversationId: string): Promise<ConversationThreadSnapshot>;
  invalidateCurrentUser(): void;
  invalidateConversations(): void;
  removeThreadSnapshot(conversationId: string): void;
  invalidateConversationStarted(conversationId: string): void;
  invalidateConversationResources(conversationId: string): void;
  invalidateTerminalRunObservation(observation: RunObservation): void;
  clearDraftAttachments(conversationId: string): void;
  cacheRunStarted(response: StartConversationRunResponse): void;
  handleRunRequestAccepted(conversationId: string): void;
  invalidateStreamError(conversationId: string): void;
}

export function useWorkspaceCacheActions(
  input: WorkspaceQueryInput & { collaborationWorkspaceId: string | undefined }
): WorkspaceCacheActions {
  const queryClient = useQueryClient();
  const { apiBaseUrl, authScope, client, collaborationWorkspaceId } = input;

  const invalidateCurrentUser = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.me(apiBaseUrl) });
  }, [apiBaseUrl, queryClient]);

  const invalidateConversations = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.conversations(apiBaseUrl, authScope, collaborationWorkspaceId)
    });
  }, [apiBaseUrl, authScope, collaborationWorkspaceId, queryClient]);

  const removeThreadSnapshot = useCallback(
    (conversationId: string) => {
      queryClient.removeQueries({
        queryKey: workspaceQueryKeys.thread(apiBaseUrl, authScope, conversationId)
      });
    },
    [apiBaseUrl, authScope, queryClient]
  );

  const invalidateThread = useCallback(
    (conversationId: string) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.thread(apiBaseUrl, authScope, conversationId)
      });
    },
    [apiBaseUrl, authScope, queryClient]
  );

  const invalidateConversationResources = useCallback(
    (conversationId: string) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.conversationResources(apiBaseUrl, authScope, conversationId)
      });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.structuredDataResourcesScope(
          apiBaseUrl,
          authScope,
          conversationId
        )
      });
    },
    [apiBaseUrl, authScope, queryClient]
  );

  const invalidateUsage = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.usage(apiBaseUrl, authScope)
    });
  }, [apiBaseUrl, authScope, queryClient]);

  const invalidateAuditEvents = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.auditEvents(apiBaseUrl, authScope)
    });
  }, [apiBaseUrl, authScope, queryClient]);

  const invalidateDraftAttachmentsScope = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.draftAttachmentsScope(apiBaseUrl, authScope)
    });
  }, [apiBaseUrl, authScope, queryClient]);

  const refreshThreadSnapshot = useCallback(
    (conversationId: string) =>
      queryClient.fetchQuery({
        queryKey: workspaceQueryKeys.thread(apiBaseUrl, authScope, conversationId),
        queryFn: () => client.conversations.getThread(conversationId),
        staleTime: 0
      }),
    [apiBaseUrl, authScope, client, queryClient]
  );

  const invalidateConversationStarted = useCallback(
    (conversationId: string) => {
      invalidateConversations();
      invalidateThread(conversationId);
    },
    [invalidateConversations, invalidateThread]
  );

  const invalidateRunCompletion = useCallback(
    (conversationId: string, options: { draftAttachmentsChanged?: boolean } = {}) => {
      invalidateConversations();
      invalidateThread(conversationId);
      invalidateConversationResources(conversationId);
      if (options.draftAttachmentsChanged) {
        invalidateDraftAttachmentsScope();
      }
      invalidateUsage();
      invalidateAuditEvents();
    },
    [
      invalidateAuditEvents,
      invalidateConversations,
      invalidateConversationResources,
      invalidateDraftAttachmentsScope,
      invalidateThread,
      invalidateUsage
    ]
  );

  const invalidateTerminalRunObservation = useCallback(
    (observation: RunObservation) => {
      invalidateRunCompletion(observation.conversationId);
    },
    [invalidateRunCompletion]
  );

  const clearDraftAttachments = useCallback(
    (conversationId: string) => {
      queryClient.setQueryData<DraftAttachment[]>(
        workspaceQueryKeys.draftAttachments(apiBaseUrl, authScope, conversationId),
        []
      );
    },
    [apiBaseUrl, authScope, queryClient]
  );

  const cacheRunStarted = useCallback(
    (response: StartConversationRunResponse) => {
      queryClient.setQueryData(
        workspaceQueryKeys.thread(apiBaseUrl, authScope, response.conversation.id),
        response.thread
      );
      queryClient.setQueryData<ConversationListItem[]>(
        workspaceQueryKeys.conversations(apiBaseUrl, authScope, collaborationWorkspaceId),
        (currentConversations = []) => {
          const existing = currentConversations.filter(
            (conversation) => conversation.id !== response.conversation.id
          );
          return [
            {
              ...response.conversation,
              activeRun: response.thread.activeRun?.run,
              latestMessageAt: response.userMessage.createdAt
            },
            ...existing
          ];
        }
      );
    },
    [apiBaseUrl, authScope, collaborationWorkspaceId, queryClient]
  );

  const handleRunRequestAccepted = useCallback(
    (conversationId: string) => {
      invalidateConversations();
      void client.conversations
        .generateTitle(conversationId)
        .then((updatedConversation) => {
          queryClient.setQueryData<ConversationListItem[]>(
            workspaceQueryKeys.conversations(apiBaseUrl, authScope, collaborationWorkspaceId),
            (currentConversations = []) => {
              if (
                currentConversations.some(
                  (conversation) => conversation.id === updatedConversation.id
                )
              ) {
                return currentConversations.map((conversation) =>
                  conversation.id === updatedConversation.id
                    ? { ...conversation, ...updatedConversation }
                    : conversation
                );
              }
              return [updatedConversation, ...currentConversations];
            }
          );
        })
        .catch(() => {
          invalidateConversations();
        });
    },
    [apiBaseUrl, authScope, client, collaborationWorkspaceId, invalidateConversations, queryClient]
  );

  const invalidateStreamError = useCallback(
    (conversationId: string) => {
      invalidateConversations();
      invalidateThread(conversationId);
      invalidateDraftAttachmentsScope();
    },
    [invalidateConversations, invalidateDraftAttachmentsScope, invalidateThread]
  );

  return useMemo(
    () => ({
      refreshThreadSnapshot,
      invalidateCurrentUser,
      invalidateConversations,
      removeThreadSnapshot,
      invalidateConversationStarted,
      invalidateConversationResources,
      invalidateTerminalRunObservation,
      clearDraftAttachments,
      cacheRunStarted,
      handleRunRequestAccepted,
      invalidateStreamError
    }),
    [
      cacheRunStarted,
      clearDraftAttachments,
      handleRunRequestAccepted,
      invalidateConversationStarted,
      invalidateConversationResources,
      invalidateConversations,
      invalidateCurrentUser,
      removeThreadSnapshot,
      invalidateStreamError,
      invalidateTerminalRunObservation,
      refreshThreadSnapshot
    ]
  );
}
