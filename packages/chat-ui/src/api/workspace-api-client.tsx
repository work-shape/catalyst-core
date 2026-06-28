import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createApiClient, type ApiClient } from "@vivd-catalyst/api-client";

interface WorkspaceApiClientContextValue {
  apiBaseUrl: string;
  client: ApiClient;
}

const WorkspaceApiClientContext = createContext<WorkspaceApiClientContextValue | undefined>(undefined);

export function WorkspaceApiClientProvider({
  apiBaseUrl,
  token,
  getToken,
  children
}: {
  apiBaseUrl: string;
  token?: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  children: ReactNode;
}) {
  const client = useMemo(
    () =>
      createApiClient({
        baseUrl: apiBaseUrl,
        getToken: getToken ?? (() => token)
      }),
    [apiBaseUrl, getToken, token]
  );
  const value = useMemo<WorkspaceApiClientContextValue>(
    () => ({
      apiBaseUrl,
      client
    }),
    [apiBaseUrl, client]
  );

  return (
    <WorkspaceApiClientContext.Provider value={value}>{children}</WorkspaceApiClientContext.Provider>
  );
}

export function useWorkspaceApiClient(): WorkspaceApiClientContextValue {
  const value = useContext(WorkspaceApiClientContext);
  if (!value) {
    throw new Error("useWorkspaceApiClient must be used within WorkspaceApiClientProvider");
  }
  return value;
}
