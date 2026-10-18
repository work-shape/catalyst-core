import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { createApiClient, type ApiClient } from "@work-shape/catalyst-api-client";

interface WorkspaceApiClientContextValue {
  apiBaseUrl: string;
  client: ApiClient;
  /** Stops this session's HTTP requests; the returned callback resumes them if sign-out fails. */
  cancelRequests(): () => void;
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
  const requests = useMemo(
    () => ({ controller: new AbortController(), ended: false }),
    [apiBaseUrl, getToken, token]
  );
  useLayoutEffect(() => {
    requests.ended = false;
    // React StrictMode rehearses unmounting before it mounts the same provider again.
    if (requests.controller.signal.aborted) requests.controller = new AbortController();
    return () => {
      requests.ended = true;
      requests.controller.abort();
    };
  }, [requests]);
  const client = useMemo(() => {
    const resolvedGetToken = getToken ?? (token !== undefined ? () => token : undefined);
    return createApiClient({
      baseUrl: apiBaseUrl,
      get signal() {
        return requests.controller.signal;
      },
      onUnknownOperation: () => setInterfaceOutdated(true),
      onResponseMismatch: () => setInterfaceOutdated(true),
      ...(resolvedGetToken ? { getToken: resolvedGetToken } : {})
    });
  }, [apiBaseUrl, getToken, token, requests]);
  const value = useMemo<WorkspaceApiClientContextValue>(
    () => ({
      apiBaseUrl,
      client,
      cancelRequests: () => {
        requests.controller.abort();
        return () => {
          if (!requests.ended) requests.controller = new AbortController();
        };
      },
      interfaceOutdated
    }),
    [apiBaseUrl, client, interfaceOutdated, requests]
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
