import { useQuery } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@work-shape/catalyst-api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";

/**
 * Whom to ask for a place in a workspace a link led to and the person is no member of. The
 * instance refuses the read and names the workspace's owners and admins under
 * `details.administrators`, and nothing else of it. A workspace that does not exist, or a
 * personal one, names nobody.
 */
export function useClosedWorkspaceLinkQuery(input: {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  /** The workspace the link named. Absent while no link was closed. */
  collaborationWorkspaceId: string | undefined;
}) {
  const { client, collaborationWorkspaceId } = input;
  return useQuery({
    queryKey: workspaceQueryKeys.closedWorkspaceLink(
      input.apiBaseUrl,
      input.authScope,
      collaborationWorkspaceId ?? ""
    ),
    queryFn: async ({ signal }): Promise<readonly string[]> => {
      if (collaborationWorkspaceId === undefined) return [];
      try {
        await client.workspaces.get({ params: { collaborationWorkspaceId }, signal });
        // The read let the person in after all: nobody needs to be asked.
        return [];
      } catch (error) {
        return refusalAdministrators(error);
      }
    },
    enabled: collaborationWorkspaceId !== undefined,
    retry: false
  });
}

/** The names a refused read of a workspace gives. Any other failure names nobody. */
function refusalAdministrators(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.code !== "NOT_FOUND") return [];
  const envelope = error.payload;
  const refusal = isRecord(envelope) ? envelope.error : undefined;
  const details = isRecord(refusal) ? refusal.details : undefined;
  const named = isRecord(details) ? details.administrators : undefined;
  return Array.isArray(named)
    ? named.filter((name): name is string => typeof name === "string" && name.trim() !== "")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
