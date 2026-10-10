import { useCallback, useMemo } from "react";
import {
  isCancelledError,
  QueryClient,
  useQuery,
  useQueryClient,
  type QueryKey
} from "@tanstack/react-query";
import {
  ApiError,
  ApiResponseShapeError,
  listAll,
  type ApiClient,
  type Conversation,
  type ConversationThreadSnapshot,
  type DraftAttachment,
  type LocaleCode,
  type RunObservation,
  type StartConversationRunResponse
} from "@vivd-catalyst/api-client";
import { approvalRequestQueryKeys } from "../approvals/approval-request-api";
import { refreshRailConversations, updateRailConversations } from "./rail-conversations";
import { PERSONAL_DEFAULT_CONVERSATION_LIST, workspaceQueryKeys } from "./workspace-query-keys";

interface WorkspaceQueryInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

const CURRENT_USER_DEADLINE_MS = 15_000;

export function useWorkspaceMeQuery(input: Pick<WorkspaceQueryInput, "apiBaseUrl" | "client">) {
  return useQuery({
    queryKey: workspaceQueryKeys.me(input.apiBaseUrl),
    queryFn: ({ signal }) => getCurrentUserWithinDeadline(input.client, signal),
    retry: false
  });
}

export function useWorkspaceModelPreferenceQuery(
  input: Pick<WorkspaceQueryInput, "apiBaseUrl" | "client"> & { enabled: boolean }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.modelPreference(input.apiBaseUrl),
    queryFn: () => input.client.me.model_preference.get(),
    enabled: input.enabled,
    staleTime: Infinity
  });
}

export async function getCurrentUserWithinDeadline(
  client: { me: Pick<ApiClient["me"], "get"> },
  querySignal: AbortSignal,
  deadlineMs = CURRENT_USER_DEADLINE_MS
) {
  const controller = new AbortController();
  const abortRequest = () => controller.abort(querySignal.reason);
  const timeout = globalThis.setTimeout(() => controller.abort(), deadlineMs);

  if (querySignal.aborted) {
    abortRequest();
  } else {
    querySignal.addEventListener("abort", abortRequest, { once: true });
  }

  try {
    return await client.me.get({ signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
    querySignal.removeEventListener("abort", abortRequest);
  }
}

const CONFIG_LOAD_RETRIES = 3;

/**
 * The instance configuration the whole interface waits for. A failure that may pass by itself
 * (no answer, or a 5xx) is tried again a few times before it shows; a refusal or an answer of
 * another shape is not, because asking again changes nothing.
 */
export function workspaceConfigQueryOptions(
  input: Pick<WorkspaceQueryInput, "apiBaseUrl" | "authScope"> & {
    client: { config: Pick<ApiClient["config"], "get"> };
    localePreference: LocaleCode | undefined;
    enabled: boolean;
  }
) {
  return {
    queryKey: workspaceQueryKeys.config(input.apiBaseUrl, input.authScope, input.localePreference),
    queryFn: async () => {
      try {
        return await input.client.config.get({ query: { locale: input.localePreference } });
      } catch (error) {
        if (error instanceof ApiResponseShapeError) {
          // Paths only: the values of an instance configuration do not belong in a console.
          console.error(
            `The instance configuration does not fit this interface at: ${error.paths.join(", ")}`
          );
        }
        throw error;
      }
    },
    retry: (failureCount: number, error: unknown) =>
      failureCount < CONFIG_LOAD_RETRIES && isTransientFailure(error),
    enabled: input.enabled
  };
}

function isTransientFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

export function useWorkspaceConfigQuery(input: Parameters<typeof workspaceConfigQueryOptions>[0]) {
  return useQuery(workspaceConfigQueryOptions(input));
}

export function useCollaborationWorkspacesQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.collaborationWorkspaces(input.apiBaseUrl, input.authScope),
    queryFn: () => listCollaborationWorkspacesWithPersonal(input.client.workspaces),
    enabled: input.enabled
  });
}

/**
 * Reading the list creates nothing, so a person's first visit finds no Personal Workspace.
 * Only then is it created; every later load is the one reading request.
 */
export async function listCollaborationWorkspacesWithPersonal<
  Workspace extends { kind: string }
>(workspaces: {
  list(input: {
    query: { limit: number; cursor?: string };
  }): Promise<{ items: Workspace[]; nextCursor?: string }>;
  ensure_personal(): Promise<unknown>;
}): Promise<Workspace[]> {
  const list = () => listAll((paging) => workspaces.list({ query: paging }));
  const listed = await list();
  if (listed.some((workspace) => workspace.kind === "personal")) {
    return listed;
  }
  await workspaces.ensure_personal();
  return list();
}

/**
 * The agents one Collaboration Workspace offers, with that workspace's default.
 * `placeholderData` keeps the previous workspace's agents on screen while the
 * next workspace loads, so switching does not blank the picker.
 */
export function useCollaborationWorkspaceAgentsQuery(
  input: WorkspaceQueryInput & {
    collaborationWorkspaceId: string | undefined;
    localePreference: LocaleCode | undefined;
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.collaborationWorkspaceAgents(
      input.apiBaseUrl,
      input.authScope,
      input.collaborationWorkspaceId,
      input.localePreference
    ),
    queryFn: async () => {
      let defaultAgentName: string | undefined;
      const items = await listAll(async (paging) => {
        const page = await input.client.workspaces.agents.list({
          params: { collaborationWorkspaceId: input.collaborationWorkspaceId ?? "" },
          query: { locale: input.localePreference, ...paging }
        });
        defaultAgentName = page.defaultAgentName;
        return page;
      });
      return { defaultAgentName, items };
    },
    placeholderData: (previousData) => previousData,
    enabled: input.enabled && Boolean(input.collaborationWorkspaceId)
  });
}

export function useCollaborationWorkspaceDirectoryQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.collaborationWorkspaceDirectory(input.apiBaseUrl, input.authScope),
    queryFn: () => listAll((paging) => input.client.workspaces.directory.list({ query: paging })),
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
      listAll((paging) =>
        input.client.workspaces.members.list({
          params: { collaborationWorkspaceId: input.collaborationWorkspaceId },
          query: paging
        })
      ),
    enabled: input.enabled
  });
}

/**
 * Typeahead over the people an owner/admin can add. `placeholderData` keeps the
 * previous matches on screen while the next query is in flight, so the dropdown
 * does not blink shut between keystrokes.
 */
export function useCollaborationWorkspaceMemberCandidatesQuery(
  input: WorkspaceQueryInput & {
    collaborationWorkspaceId: string;
    query: string;
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.collaborationWorkspaceMemberCandidates(
      input.apiBaseUrl,
      input.authScope,
      input.collaborationWorkspaceId,
      input.query
    ),
    queryFn: () =>
      listAll((paging) =>
        input.client.workspaces.member_candidates.list({
          params: { collaborationWorkspaceId: input.collaborationWorkspaceId },
          query: { q: input.query, ...paging }
        })
      ),
    placeholderData: (previousData) => previousData,
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
      listAll((paging) =>
        input.client.workspaces.access_requests.list({
          params: { collaborationWorkspaceId: input.collaborationWorkspaceId },
          query: paging
        })
      ),
    enabled: input.enabled
  });
}

export function useCollaborationWorkspaceDeletionImpactQuery(
  input: WorkspaceQueryInput & {
    collaborationWorkspaceId: string;
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.collaborationWorkspaceDeletionImpact(
      input.apiBaseUrl,
      input.authScope,
      input.collaborationWorkspaceId
    ),
    queryFn: () =>
      input.client.workspaces.deletion_impact.get({
        params: { collaborationWorkspaceId: input.collaborationWorkspaceId }
      }),
    // The counts are only meaningful at the moment the owner reads them.
    staleTime: 0,
    gcTime: 0,
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
    queryFn: () =>
      input.client.conversations.thread.get({
        params: { conversationId: input.conversationId ?? "" }
      }),
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
    queryFn: () =>
      listAll((paging) =>
        input.client.conversations.resources.list({
          params: { conversationId: input.conversationId ?? "" },
          query: paging
        })
      ),
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
      input.client.conversations.structured_data.get({
        params: {
          conversationId: input.conversationId,
          structuredDataResourceId: input.structuredDataResourceId
        }
      })
  });
}

export function useWorkspaceUsageQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.usage(input.apiBaseUrl, input.authScope),
    queryFn: () => input.client.usage.get_summary(),
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
    // projected activity timeline served from /api/v1/instance/audit-activities.
    queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope),
    queryFn: async () => (await input.client.audit_activities.list()).items,
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
    queryFn: () => listAll((paging) => input.client.users.list({ query: paging })),
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
    queryFn: () => listAll((paging) => input.client.service_principals.list({ query: paging })),
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
    queryFn: () => input.client.config_assets.get_overview(),
    enabled: input.enabled
  });
}

export function useAdministeredCollaborationWorkspacesQuery(
  input: WorkspaceQueryInput & {
    enabled: boolean;
  }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.administeredCollaborationWorkspaces(
      input.apiBaseUrl,
      input.authScope
    ),
    queryFn: () => listAll((paging) => input.client.instance.workspaces.list({ query: paging })),
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
    queryFn: () => input.client.config_assets.export(),
    enabled: input.enabled
  });
}

/** The cache of everything the interface has read from the instance. */
export function createWorkspaceQueryClient(): QueryClient {
  return new QueryClient();
}

/** Reads a thread from the instance again, whatever the cache holds. */
export async function readThreadAgain<Thread>(
  queryClient: QueryClient,
  threadKey: QueryKey,
  read: () => Promise<Thread>
): Promise<Thread> {
  try {
    return await queryClient.fetchQuery({ queryKey: threadKey, queryFn: read, staleTime: 0 });
  } catch (error) {
    // A run that started meanwhile has put its own, newer thread in the cache.
    const overtaking = isCancelledError(error)
      ? queryClient.getQueryData<Thread>(threadKey)
      : undefined;
    if (overtaking === undefined) {
      throw error;
    }
    return overtaking;
  }
}

/**
 * Puts the thread a run start answered with in the cache. A read of the thread still on its way
 * was asked before the run existed, so its answer is dropped instead of overwriting the run.
 */
export function cacheStartedRunThread<Thread>(
  queryClient: QueryClient,
  threadKey: QueryKey,
  thread: Thread
): void {
  // The read is dropped at once; the promise only tells when, and it never fails.
  queryClient
    .cancelQueries({ queryKey: threadKey, exact: true }, { silent: true })
    .catch(() => undefined);
  queryClient.setQueryData(threadKey, thread);
}

/**
 * Conversation-list writes follow the conversation's own workspace, never the
 * routed one: a stale `/w/:other/c/:id` link must not splice the conversation
 * into a list it does not belong to.
 */
export function conversationListCacheKey(
  apiBaseUrl: string,
  authScope: string,
  conversation: Pick<Conversation, "collaborationWorkspaceId">,
  collaborationWorkspacesAvailable = true
) {
  return workspaceQueryKeys.conversations(
    apiBaseUrl,
    authScope,
    collaborationWorkspacesAvailable
      ? conversation.collaborationWorkspaceId
      : PERSONAL_DEFAULT_CONVERSATION_LIST
  );
}

export interface WorkspaceCacheActions {
  refreshThreadSnapshot(conversationId: string): Promise<ConversationThreadSnapshot>;
  invalidateCurrentUser(): void;
  invalidateConversations(): void;
  /** Reads the rail's first page again: one request, whatever the rail has loaded. */
  refreshRailConversations(): void;
  removeThreadSnapshot(conversationId: string): void;
  invalidateConversationStarted(conversationId: string): void;
  invalidateConversationResources(conversationId: string): void;
  invalidateTerminalRunObservation(observation: RunObservation): void;
  clearDraftAttachments(conversationId: string): void;
  cacheRunStarted(response: StartConversationRunResponse): void;
  invalidateStreamError(conversationId: string): void;
}

export function useWorkspaceCacheActions(
  input: WorkspaceQueryInput & {
    collaborationWorkspaceId: string | undefined;
    collaborationWorkspacesAvailable: boolean;
  }
): WorkspaceCacheActions {
  const queryClient = useQueryClient();
  const {
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    collaborationWorkspacesAvailable
  } = input;
  const conversationListWorkspaceId = collaborationWorkspacesAvailable
    ? collaborationWorkspaceId
    : PERSONAL_DEFAULT_CONVERSATION_LIST;

  const invalidateCurrentUser = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.me(apiBaseUrl) });
  }, [apiBaseUrl, queryClient]);

  const invalidateConversations = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.conversations(apiBaseUrl, authScope, conversationListWorkspaceId)
    });
  }, [apiBaseUrl, authScope, conversationListWorkspaceId, queryClient]);

  const refreshRail = useCallback(() => {
    refreshRailConversations(
      queryClient,
      workspaceQueryKeys.conversations(apiBaseUrl, authScope, conversationListWorkspaceId)
    ).catch(() => undefined);
  }, [apiBaseUrl, authScope, conversationListWorkspaceId, queryClient]);

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
      readThreadAgain(
        queryClient,
        workspaceQueryKeys.thread(apiBaseUrl, authScope, conversationId),
        () => client.conversations.thread.get({ params: { conversationId } })
      ),
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
      // A run can submit an Approval Request or supersede an earlier one, which
      // the cards and the pending count only learn from their own queries.
      void queryClient.invalidateQueries({
        queryKey: approvalRequestQueryKeys.all(apiBaseUrl, authScope)
      });
    },
    [
      apiBaseUrl,
      authScope,
      invalidateAuditEvents,
      invalidateConversations,
      invalidateConversationResources,
      invalidateDraftAttachmentsScope,
      invalidateThread,
      invalidateUsage,
      queryClient
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
      cacheStartedRunThread(
        queryClient,
        workspaceQueryKeys.thread(apiBaseUrl, authScope, response.conversation.id),
        response.thread
      );
      updateRailConversations(
        queryClient,
        conversationListCacheKey(
          apiBaseUrl,
          authScope,
          response.conversation,
          collaborationWorkspacesAvailable
        ),
        (conversations) => [
          {
            ...response.conversation,
            activeRun: response.thread.activeRun?.run,
            latestMessageAt: response.userMessage.createdAt
          },
          ...conversations.filter((conversation) => conversation.id !== response.conversation.id)
        ]
      );
    },
    [apiBaseUrl, authScope, collaborationWorkspacesAvailable, queryClient]
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
      refreshRailConversations: refreshRail,
      removeThreadSnapshot,
      invalidateConversationStarted,
      invalidateConversationResources,
      invalidateTerminalRunObservation,
      clearDraftAttachments,
      cacheRunStarted,
      invalidateStreamError
    }),
    [
      cacheRunStarted,
      clearDraftAttachments,
      invalidateConversationStarted,
      invalidateConversationResources,
      invalidateConversations,
      invalidateCurrentUser,
      refreshRail,
      removeThreadSnapshot,
      invalidateStreamError,
      invalidateTerminalRunObservation,
      refreshThreadSnapshot
    ]
  );
}
