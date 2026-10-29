import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { AppBridgeContext } from "@work-shape/catalyst-api-client";

/**
 * What the interface tells a Page about where it runs, apart from the Page itself: who looks at
 * it, in which workspace, and how the interface looks. The workspace shell provides it around
 * the conversation and the surface slot.
 */
export type PageHost = Pick<AppBridgeContext, "viewer" | "workspace" | "theme" | "mode"> & {
  /** The instance has the feedback module on: a published App may offer feedback (LU-6). */
  feedbackModule?: boolean;
};

const PageHostContext = createContext<PageHost | undefined>(undefined);
const PageConversationContext = createContext<string | undefined>(undefined);

export function PageHostProvider({
  conversationId,
  viewer,
  workspace,
  theme,
  mode,
  feedbackModule = false,
  children
}: PageHost & {
  /** The conversation that is open: the one a Page card in the thread belongs to. */
  conversationId: string | undefined;
  children: ReactNode;
}) {
  const viewerId = viewer.id;
  const viewerName = viewer.displayName;
  const workspaceId = workspace?.id;
  const workspaceName = workspace?.name;
  const value = useMemo<PageHost>(
    () => ({
      viewer: { kind: "member", id: viewerId, displayName: viewerName },
      workspace:
        workspaceId === undefined || workspaceName === undefined
          ? null
          : { id: workspaceId, name: workspaceName },
      theme,
      mode,
      feedbackModule
    }),
    [feedbackModule, mode, theme, viewerId, viewerName, workspaceId, workspaceName]
  );
  return (
    <PageHostContext.Provider value={value}>
      <PageConversationContext.Provider value={conversationId}>
        {children}
      </PageConversationContext.Provider>
    </PageHostContext.Provider>
  );
}

/** The host a Page is shown by, or nothing where the surface stands outside a workspace shell. */
export function usePageHost(): PageHost | undefined {
  return useContext(PageHostContext);
}

/** The conversation a Page card stands in, or nothing outside a workspace shell. */
export function usePageConversationId(): string | undefined {
  return useContext(PageConversationContext);
}
