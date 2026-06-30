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
    queryFn: input.client.me,
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
    queryFn: () => input.client.config(input.localePreference),
    enabled: input.enabled
  });
}

export function useWorkspaceConversationsQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.conversations(input.apiBaseUrl, input.authScope),
    queryFn: input.client.conversations,
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
    queryFn: () => input.client.thread(input.conversationId ?? ""),
    enabled: input.enabled
  });
}

export function useWorkspaceUsageQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.usage(input.apiBaseUrl, input.authScope),
    queryFn: input.client.usageSummary,
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
    queryFn: input.client.auditActivities,
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
    queryFn: input.client.users,
    enabled: input.enabled
  });
}

export interface WorkspaceCacheActions {
  refreshThreadSnapshot(conversationId: string): Promise<ConversationThreadSnapshot>;
  invalidateCurrentUser(): void;
  invalidateConversations(): void;
  removeThreadSnapshot(conversationId: string): void;
  invalidateConversationStarted(conversationId: string): void;
  invalidateTerminalRunObservation(observation: RunObservation): void;
  clearDraftAttachments(conversationId: string): void;
  cacheRunStarted(response: StartConversationRunResponse): void;
  handleRunRequestAccepted(conversationId: string): void;
  invalidateStreamError(conversationId: string): void;
}

export function useWorkspaceCacheActions(
  input: WorkspaceQueryInput
): WorkspaceCacheActions {
  const queryClient = useQueryClient();
  const { apiBaseUrl, authScope, client } = input;

  const invalidateCurrentUser = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.me(apiBaseUrl) });
  }, [apiBaseUrl, queryClient]);

  const invalidateConversations = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.conversations(apiBaseUrl, authScope)
    });
  }, [apiBaseUrl, authScope, queryClient]);

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

  const invalidateUsage = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.usage(apiBaseUrl, authScope) });
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
        queryFn: () => client.thread(conversationId),
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
    (
      conversationId: string,
      options: { draftAttachmentsChanged?: boolean } = {}
    ) => {
      invalidateConversations();
      invalidateThread(conversationId);
      if (options.draftAttachmentsChanged) {
        invalidateDraftAttachmentsScope();
      }
      invalidateUsage();
      invalidateAuditEvents();
    },
    [
      invalidateAuditEvents,
      invalidateConversations,
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
        workspaceQueryKeys.conversations(apiBaseUrl, authScope),
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
    [apiBaseUrl, authScope, queryClient]
  );

  const handleRunRequestAccepted = useCallback(
    (conversationId: string) => {
      invalidateConversations();
      void client
        .generateConversationTitle(conversationId)
        .then((updatedConversation) => {
          queryClient.setQueryData<ConversationListItem[]>(
            workspaceQueryKeys.conversations(apiBaseUrl, authScope),
            (currentConversations = []) => {
              if (currentConversations.some((conversation) => conversation.id === updatedConversation.id)) {
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
    [apiBaseUrl, authScope, client, invalidateConversations, queryClient]
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
      invalidateConversations,
      invalidateCurrentUser,
      removeThreadSnapshot,
      invalidateStreamError,
      invalidateTerminalRunObservation,
      refreshThreadSnapshot
    ]
  );
}
