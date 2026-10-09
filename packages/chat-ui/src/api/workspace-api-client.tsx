import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createApiClient, type ApiClient } from "@vivd-catalyst/api-client";

interface WorkspaceApiClientContextValue {
  apiBaseUrl: string;
  client: ApiClient;
  /**
   * The server answered that it does not know an operation this interface called, or answered
   * one outside the schema this interface was built with: it runs another release.
   */
  interfaceOutdated: boolean;
}

const WorkspaceApiClientContext = createContext<WorkspaceApiClientContextValue | undefined>(
  undefined
);

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
  const [interfaceOutdated, setInterfaceOutdated] = useState(false);
  const client = useMemo(() => {
    const resolvedGetToken = getToken ?? (token !== undefined ? () => token : undefined);
    return createApiClient({
      baseUrl: apiBaseUrl,
      onUnknownOperation: () => setInterfaceOutdated(true),
      onResponseMismatch: () => setInterfaceOutdated(true),
      ...(resolvedGetToken ? { getToken: resolvedGetToken } : {})
    });
  }, [apiBaseUrl, getToken, token]);
  const value = useMemo<WorkspaceApiClientContextValue>(
    () => ({
      apiBaseUrl,
      client,
      interfaceOutdated
    }),
    [apiBaseUrl, client, interfaceOutdated]
  );

  return (
    <WorkspaceApiClientContext.Provider value={value}>
      {children}
    </WorkspaceApiClientContext.Provider>
  );
}

export function useWorkspaceApiClient(): WorkspaceApiClientContextValue {
  const value = useContext(WorkspaceApiClientContext);
  if (!value) {
    throw new Error("useWorkspaceApiClient must be used within WorkspaceApiClientProvider");
  }
  return value;
}
