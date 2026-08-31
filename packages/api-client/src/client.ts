import { createConversationsClient } from "./conversations-client";
import { createCollaborationWorkspacesClient } from "./collaboration-workspaces-client";
import { createInstanceClients } from "./instance-client";
import { createRunsClient, type ObserveRunEventsOptions } from "./runs-client";
import { createApiClientTransport, type ApiClientOptions } from "./transport";

export type { ApiClientOptions, ObserveRunEventsOptions };

export function createApiClient(options: ApiClientOptions) {
  const transport = createApiClientTransport(options);
  const instanceClients = createInstanceClients(transport);

  return {
    browserManagedDownloads: transport.browserManagedDownloads,
    ...instanceClients,
    collaborationWorkspaces: createCollaborationWorkspacesClient(transport),
    conversations: createConversationsClient(transport),
    runs: createRunsClient(transport)
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
