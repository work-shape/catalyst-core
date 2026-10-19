import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createApiClient, type ApiClient, type LocaleCode } from "@work-shape/catalyst-api-client";

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
  /** Sets the language every request asks the server to answer in: the interface's. */
  setLocale(locale: LocaleCode): void;
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
  // The interface's language, which the client reads at each request.
  const locale = useRef<LocaleCode | undefined>(undefined);
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
      get locale() {
        return locale.current;
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
      interfaceOutdated,
      setLocale: (next) => {
        locale.current = next;
      }
    }),
    [apiBaseUrl, client, interfaceOutdated, requests]
  );

  return (
    <WorkspaceApiClientContext.Provider value={value}>
      {children}
    </WorkspaceApiClientContext.Provider>
  );
}

/** Makes every request of the workspace's client ask for answers in `locale`. */
export function useRequestLocale(locale: LocaleCode): void {
  const setLocale = useContext(WorkspaceApiClientContext)?.setLocale;
  useLayoutEffect(() => setLocale?.(locale), [setLocale, locale]);
}

/** The client of the conversation's workspace, or undefined outside one. */
export function useOptionalWorkspaceApiClient(): WorkspaceApiClientContextValue | undefined {
  return useContext(WorkspaceApiClientContext);
}

export function useWorkspaceApiClient(): WorkspaceApiClientContextValue {
  const value = useContext(WorkspaceApiClientContext);
  if (!value) {
    throw new Error("useWorkspaceApiClient must be used within WorkspaceApiClientProvider");
  }
  return value;
}
