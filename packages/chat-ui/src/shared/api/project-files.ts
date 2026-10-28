import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  completedOutput,
  type ApiClient,
  type DraftAttachmentUploadResponse,
  type ProjectFileChangeView
} from "@work-shape/catalyst-api-client";
import { WORKSPACE_AUTH_SCOPE } from "../../chat/workspace/workspace-chat-state";
import { useOptionalWorkspaceApiClient } from "./workspace-api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";

// Project files (PRJ-2): the files of a project with their versions, and the writes on them,
// from the project's page, a chat's contents and a turn's change line. Every write reads the
// files and the versions again.

function requireClient(client: ApiClient | undefined): ApiClient {
  if (!client) throw new Error("Project files are read and changed within a workspace");
  return client;
}

/**
 * The workspace's client where there is one. A turn's line about a project file can stand where
 * there is none, such as an embedded chat: it reads and changes nothing there.
 */
function useProjectFilesClient(): { apiBaseUrl: string; client: ApiClient | undefined } {
  return useOptionalWorkspaceApiClient() ?? { apiBaseUrl: "", client: undefined };
}

const projectFileQueryKeys = {
  all: (apiBaseUrl: string, projectId: string) => ["project-files", apiBaseUrl, projectId] as const,
  list: (apiBaseUrl: string, projectId: string) =>
    ["project-files", apiBaseUrl, projectId, "list"] as const,
  versions: (apiBaseUrl: string, projectId: string, path: string) =>
    ["project-files", apiBaseUrl, projectId, "versions", path] as const,
  text: (apiBaseUrl: string, projectId: string, path: string, version: number) =>
    ["project-files", apiBaseUrl, projectId, "text", path, version] as const
};

/** Reads a project's files again after a change made outside the page's own writes. */
export function invalidateProjectFiles(
  queryClient: QueryClient,
  apiBaseUrl: string,
  projectId: string
): void {
  queryClient
    .invalidateQueries({ queryKey: projectFileQueryKeys.all(apiBaseUrl, projectId) })
    .catch(() => undefined);
}

/**
 * The text of one version of a project file, such as the project's instructions (PRJ-3). A
 * version never changes, so it is read once.
 */
export function useProjectFileTextQuery(
  projectId: string | undefined,
  path: string,
  version: number | undefined
) {
  const { apiBaseUrl, client } = useProjectFilesClient();
  return useQuery({
    queryKey: projectFileQueryKeys.text(apiBaseUrl, projectId ?? "", path, version ?? 0),
    queryFn: async () =>
      (
        await loadProjectFileBlob(requireClient(client), projectId ?? "", path, {
          ...(version === undefined ? {} : { version })
        })
      ).text(),
    enabled: client !== undefined && Boolean(projectId) && version !== undefined,
    staleTime: Number.POSITIVE_INFINITY
  });
}

/**
 * Whether the instructions of a chat's project changed since the chat's last run took them
 * (PRJ-3), with the project's title and the two versions.
 */
export function useConversationProjectInstructionsQuery(conversationId: string | undefined) {
  const { apiBaseUrl, client } = useProjectFilesClient();
  return useQuery({
    queryKey: ["project-instructions", apiBaseUrl, conversationId ?? ""] as const,
    queryFn: ({ signal }) =>
      requireClient(client).conversations.project_instructions.get({
        params: { conversationId: conversationId ?? "" },
        signal
      }),
    enabled: client !== undefined && Boolean(conversationId)
  });
}

/** The files of a project as they are now, with what it holds and may hold. */
export function useProjectFilesQuery(projectId: string | undefined) {
  const { apiBaseUrl, client } = useProjectFilesClient();
  return useQuery({
    queryKey: projectFileQueryKeys.list(apiBaseUrl, projectId ?? ""),
    queryFn: ({ signal }) =>
      requireClient(client).projects.files.list({ params: { projectId: projectId ?? "" }, signal }),
    enabled: client !== undefined && Boolean(projectId)
  });
}

/** The kept versions of one file, newest first; a deleted file's too. */
export function useProjectFileVersionsQuery(projectId: string, path: string | undefined) {
  const { apiBaseUrl, client } = useProjectFilesClient();
  return useQuery({
    queryKey: projectFileQueryKeys.versions(apiBaseUrl, projectId, path ?? ""),
    queryFn: ({ signal }) =>
      requireClient(client).projects.files.versions({
        params: { projectId },
        query: { path: path ?? "" },
        signal
      }),
    enabled: client !== undefined && Boolean(path)
  });
}

/** A file's content, the current version's or an older one's. */
export function loadProjectFileBlob(
  client: ApiClient,
  projectId: string,
  path: string,
  options: { version?: number; download?: boolean } = {}
): Promise<Blob> {
  return client.projects.files.get_content({
    params: { projectId },
    query: {
      path,
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.download ? { download: "true" } : {})
    }
  });
}

/** Reads a project's files again, as after a change the page did not make itself. */
export function useInvalidateProjectFiles() {
  const { apiBaseUrl } = useProjectFilesClient();
  const queryClient = useQueryClient();
  return (projectId: string) => {
    queryClient
      .invalidateQueries({ queryKey: projectFileQueryKeys.all(apiBaseUrl, projectId) })
      .catch(() => undefined);
  };
}

/**
 * Writes on a project's files. Each answers the change the instance made; the files and every
 * version list of the project are read again after.
 */
export function useProjectFileWrites(projectId: string, heldMessage: string) {
  const { client } = useProjectFilesClient();
  const invalidate = useInvalidateProjectFiles();
  const done = <T>(output: Promise<T>) => output.finally(() => invalidate(projectId));
  return {
    /** Puts a file at `path`; over a taken path only with the version it replaces. */
    upload: (input: { file: File; path: string; replaces?: number }) =>
      done(
        requireClient(client)
          .projects.files.upload({
            params: { projectId },
            query: {
              path: input.path,
              ...(input.replaces === undefined ? {} : { replaces: input.replaces })
            },
            file: input.file
          })
          .then((result) => completedOutput(result, heldMessage))
      ),
    /** Renames or moves a file, or a folder with every file below it (`from` ending in `/`). */
    move: (input: { from: string; to: string }) =>
      done(
        requireClient(client)
          .projects.files.move({ params: { projectId }, body: input })
          .then((result) => completedOutput(result, heldMessage))
      ),
    /** Deletes a file as a new version. */
    remove: (input: { path: string; replaces?: number }): Promise<ProjectFileChangeView> =>
      done(
        requireClient(client)
          .projects.files.delete({ params: { projectId }, body: input })
          .then((result) => completedOutput(result, heldMessage))
      ),
    /** Deletes a file for good, with all its versions. */
    purge: (input: { path: string }) =>
      done(
        requireClient(client)
          .projects.files.purge({ params: { projectId }, body: input })
          .then((result) => completedOutput(result, heldMessage))
      ),
    /** Makes an older version the newest one. */
    restore: (input: {
      path: string;
      version: number;
      replaces?: number;
    }): Promise<ProjectFileChangeView> =>
      done(
        requireClient(client)
          .projects.files.restore({ params: { projectId }, body: input })
          .then((result) => completedOutput(result, heldMessage))
      )
  };
}

/** Keeps a file of a chat in its project: a file the chat was given, or one its agent made. */
export function useSaveToProjectMutation(conversationId: string, heldMessage: string) {
  const { client } = useProjectFilesClient();
  const invalidate = useInvalidateProjectFiles();
  return useMutation({
    mutationFn: async (input: {
      projectId: string;
      source: { fileId: string } | { artifactId: string };
      path?: string;
    }) =>
      completedOutput(
        await requireClient(client).conversations.project_files.save({
          params: { conversationId },
          body: { source: input.source, ...(input.path ? { path: input.path } : {}) }
        }),
        heldMessage
      ),
    onSettled: (_change, _error, input) => invalidate(input.projectId)
  });
}

/**
 * Attaches a project file to the next message of a chat. The chat's draft attachments are read
 * again after, as after an upload.
 */
export function useAddFromProjectMutation(conversationId: string, heldMessage: string) {
  const { apiBaseUrl, client } = useProjectFilesClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      projectId: string;
      path: string;
      agentName?: string;
    }): Promise<DraftAttachmentUploadResponse> =>
      completedOutput(
        await requireClient(client).conversations.draft_attachments.add_from_project({
          params: { conversationId },
          body: input
        }),
        heldMessage
      ),
    onSuccess: (response) => {
      const queryKey = workspaceQueryKeys.draftAttachments(
        apiBaseUrl,
        WORKSPACE_AUTH_SCOPE,
        conversationId
      );
      queryClient.setQueryData(queryKey, response.attachments);
      queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
    }
  });
}
