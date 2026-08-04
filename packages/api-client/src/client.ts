import { createConversationsClient } from "./conversations-client";
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
    conversations: createConversationsClient(transport),
    runs: createRunsClient(transport)
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
