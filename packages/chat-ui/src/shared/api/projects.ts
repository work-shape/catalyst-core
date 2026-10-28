import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  completedOutput,
  type ApiClient,
  type ConversationListItem,
  type ProjectAudienceView,
  type ProjectView
} from "@work-shape/catalyst-api-client";
import { WORKSPACE_AUTH_SCOPE } from "../../chat/workspace/workspace-chat-state";
import { useWorkspaceApiClient } from "./workspace-api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";

// Projects (PRJ-1): the projects of a workspace, and of all the person's workspaces (PRJ-5), one
// project by its name with its conversations, and the writes that make a project and move a
// conversation in or out.

/** How many of a project's conversations its page shows. */
const PROJECT_CONVERSATIONS_LIMIT = 50;

function requireClient(client: ApiClient | undefined): ApiClient {
  if (!client) throw new Error("Projects are read and changed within a workspace");
  return client;
}

const projectQueryKeys = {
  all: (apiBaseUrl: string) => ["projects", apiBaseUrl] as const,
  list: (apiBaseUrl: string, workspaceId: string) =>
    ["projects", apiBaseUrl, "list", workspaceId] as const,
  mine: (apiBaseUrl: string) => ["projects", apiBaseUrl, "mine"] as const,
  one: (apiBaseUrl: string, name: string) => ["projects", apiBaseUrl, "one", name] as const,
  conversations: (apiBaseUrl: string, projectId: string) =>
    ["projects", apiBaseUrl, "conversations", projectId] as const
};

/** The projects of the workspace the person is in the audience of, newest change first. */
export function useProjectsQuery(workspaceId: string) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  return useQuery({
    queryKey: projectQueryKeys.list(apiBaseUrl, workspaceId),
    queryFn: async ({ signal }) =>
      (
        await requireClient(client).projects.list({
          params: { collaborationWorkspaceId: workspaceId },
          signal
        })
      ).items,
    enabled: client !== undefined && workspaceId !== ""
  });
}

/**
 * The projects of every workspace the person is a member of, in their audience, latest
 * activity first (PRJ-5).
 */
export function useMyProjectsQuery(enabled = true) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  return useQuery({
    queryKey: projectQueryKeys.mine(apiBaseUrl),
    queryFn: async ({ signal }) =>
      (await requireClient(client).projects.list_mine({ signal })).items,
    enabled: client !== undefined && enabled
  });
}

/** One project by its name. A project outside the person's audience answers as not found. */
export function useProjectQuery(name: string) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  return useQuery({
    queryKey: projectQueryKeys.one(apiBaseUrl, name),
    queryFn: ({ signal }) =>
      requireClient(client).projects.get({ params: { projectName: name }, signal }),
    enabled: client !== undefined,
    retry: false
  });
}

/** The conversations of a project, newest first. */
export function useProjectConversationsQuery(project: ProjectView | undefined) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  return useQuery({
    queryKey: projectQueryKeys.conversations(apiBaseUrl, project?.id ?? ""),
    queryFn: async ({ signal }): Promise<ConversationListItem[]> =>
      (
        await requireClient(client).conversations.list({
          query: {
            collaborationWorkspaceId: project?.collaborationWorkspaceId ?? "",
            projectId: project?.id ?? "",
            limit: PROJECT_CONVERSATIONS_LIMIT
          },
          signal
        })
      ).items,
    enabled: client !== undefined && project !== undefined
  });
}

interface NewProject {
  collaborationWorkspaceId: string;
  title: string;
  description?: string;
  /** Absent in a Personal Workspace, which has no choice. */
  audience?: ProjectAudienceView;
}

/** Makes a project; the workspace's list and the list across workspaces are read again after. */
export function useCreateProjectMutation(heldMessage: string) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (project: NewProject) =>
      completedOutput(await requireClient(client).projects.create({ body: project }), heldMessage),
    onSuccess: (project) => {
      queryClient
        .invalidateQueries({
          queryKey: projectQueryKeys.list(apiBaseUrl, project.collaborationWorkspaceId)
        })
        .catch(() => undefined);
      queryClient
        .invalidateQueries({ queryKey: projectQueryKeys.mine(apiBaseUrl) })
        .catch(() => undefined);
    }
  });
}

/**
 * Puts a conversation into a project of its workspace, or takes it out with `null`. The
 * projects' lists, the rail and the conversation are read again after: its visibility may
 * have changed with its project.
 */
export function useSetConversationProjectMutation(heldMessage: string) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { conversationId: string; projectId: string | null }) =>
      completedOutput(
        await requireClient(client).conversations.set_project({
          params: { conversationId: input.conversationId },
          body: { projectId: input.projectId }
        }),
        heldMessage
      ),
    onSuccess: (conversation) => {
      queryClient
        .invalidateQueries({ queryKey: projectQueryKeys.all(apiBaseUrl) })
        .catch(() => undefined);
      queryClient
        .invalidateQueries({
          queryKey: workspaceQueryKeys.conversations(
            apiBaseUrl,
            WORKSPACE_AUTH_SCOPE,
            conversation.collaborationWorkspaceId
          )
        })
        .catch(() => undefined);
      queryClient
        .invalidateQueries({
          queryKey: workspaceQueryKeys.thread(apiBaseUrl, WORKSPACE_AUTH_SCOPE, conversation.id)
        })
        .catch(() => undefined);
    }
  });
}
