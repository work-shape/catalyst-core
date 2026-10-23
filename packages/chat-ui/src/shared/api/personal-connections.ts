import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@work-shape/catalyst-api-client";
import { retryUnlessRefused } from "./workspace-queries";

// The person's own sign-ins on personal Connections (`connections.mine`), read by You >
// Connections, the sign-in section of a personal Connection's page and the New connection
// dialog while it waits for the person's sign-in. One query key, so a sign-in or a disconnect
// anywhere shows everywhere.

interface PersonalConnectionsInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

function personalConnectionsKey(apiBaseUrl: string, authScope: string) {
  return ["personal-connections", apiBaseUrl, authScope] as const;
}

/** The personal Connections the person may use, each with only their own sign-in. */
export function usePersonalConnectionsQuery(
  input: PersonalConnectionsInput & { enabled?: boolean }
) {
  return useQuery({
    queryKey: personalConnectionsKey(input.apiBaseUrl, input.authScope),
    queryFn: ({ signal }) => input.client.connections.mine({ signal }),
    retry: retryUnlessRefused,
    enabled: input.enabled ?? true
  });
}

/** Reads the list again: after a sign-in, a disconnect or a revoke. */
export function useInvalidatePersonalConnections(input: PersonalConnectionsInput) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: personalConnectionsKey(input.apiBaseUrl, input.authScope)
    });
}
