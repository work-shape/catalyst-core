import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useWorkspaceApiClient } from "./api/workspace-api-client";
import { viewRuntimeAddress, viewShellUrl, type ViewRuntimeAddress } from "./view-document";

/**
 * What a generated view may load, the instance's view runtime and the hosts its config names,
 * and the shell document of the instance that every view is framed in.
 */
interface ViewPolicy {
  shellUrl: string;
  runtime: ViewRuntimeAddress;
  allowedScriptSrc: readonly string[];
}

const ViewPolicyContext = createContext<ViewPolicy | undefined>(undefined);

export function ViewPolicyProvider({
  allowedScriptSrc,
  children
}: {
  /** `views.allowedScriptSrc` of the instance config. */
  allowedScriptSrc: readonly string[];
  children: ReactNode;
}) {
  const { apiBaseUrl } = useWorkspaceApiClient();
  // The config is fetched again from time to time; the list is compared by content so that a
  // shown view is not composed and loaded again for an equal one.
  const sourcesKey = allowedScriptSrc.join(" ");
  const value = useMemo<ViewPolicy>(
    () => ({
      shellUrl: viewShellUrl(apiBaseUrl, window.location.href),
      runtime: viewRuntimeAddress(apiBaseUrl, window.location.href),
      allowedScriptSrc: sourcesKey ? sourcesKey.split(" ") : []
    }),
    [apiBaseUrl, sourcesKey]
  );
  return <ViewPolicyContext.Provider value={value}>{children}</ViewPolicyContext.Provider>;
}

export function useViewPolicy(): ViewPolicy {
  const value = useContext(ViewPolicyContext);
  if (!value) {
    throw new Error("useViewPolicy must be used within ViewPolicyProvider");
  }
  return value;
}
