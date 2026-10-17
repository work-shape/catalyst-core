import type { LocaleCode } from "@work-shape/catalyst-api-client";

/** The cache name of the one conversation list a session without workspaces has. */
export const PERSONAL_DEFAULT_CONVERSATION_LIST = "personal-default";

export const workspaceQueryKeys = {
  me: (apiBaseUrl: string) => ["me", apiBaseUrl] as const,
  modelPreference: (apiBaseUrl: string) => ["me", apiBaseUrl, "model-preference"] as const,
  branding: (apiBaseUrl: string, localePreference: LocaleCode | undefined) =>
    ["branding", apiBaseUrl, localePreference ?? "auto"] as const,
  config: (apiBaseUrl: string, authScope: string, localePreference: LocaleCode | undefined) =>
    ["config", apiBaseUrl, authScope, localePreference ?? "auto"] as const,
  conversationsScope: (apiBaseUrl: string, authScope: string) =>
    ["conversations", apiBaseUrl, authScope] as const,
  conversations: (
    apiBaseUrl: string,
    authScope: string,
    collaborationWorkspaceId: string | undefined
  ) => ["conversations", apiBaseUrl, authScope, collaborationWorkspaceId] as const,
  conversationSearch: (
    apiBaseUrl: string,
    authScope: string,
    collaborationWorkspaceId: string | undefined,
    titleQuery: string
  ) =>
    ["conversation-search", apiBaseUrl, authScope, collaborationWorkspaceId, titleQuery] as const,
  collaborationWorkspaces: (apiBaseUrl: string, authScope: string) =>
    ["collaboration-workspaces", apiBaseUrl, authScope] as const,
  collaborationWorkspaceAgentsScope: (apiBaseUrl: string, authScope: string) =>
    ["collaboration-workspace-agents", apiBaseUrl, authScope] as const,
  collaborationWorkspaceAgents: (
    apiBaseUrl: string,
    authScope: string,
    collaborationWorkspaceId: string | undefined,
    localePreference: LocaleCode | undefined
  ) =>
    [
      "collaboration-workspace-agents",
      apiBaseUrl,
      authScope,
      collaborationWorkspaceId,
      localePreference ?? "auto"
    ] as const,
  collaborationWorkspaceDirectory: (apiBaseUrl: string, authScope: string) =>
    ["collaboration-workspace-directory", apiBaseUrl, authScope] as const,
  collaborationWorkspaceMembers: (
    apiBaseUrl: string,
    authScope: string,
    collaborationWorkspaceId: string
  ) =>
    ["collaboration-workspace-members", apiBaseUrl, authScope, collaborationWorkspaceId] as const,
  collaborationWorkspaceMemberCandidates: (
    apiBaseUrl: string,
    authScope: string,
    collaborationWorkspaceId: string,
    query: string
  ) =>
    [
      "collaboration-workspace-member-candidates",
      apiBaseUrl,
      authScope,
      collaborationWorkspaceId,
      query
    ] as const,
  collaborationWorkspaceDeletionImpact: (
    apiBaseUrl: string,
    authScope: string,
    collaborationWorkspaceId: string
  ) =>
    [
      "collaboration-workspace-deletion-impact",
      apiBaseUrl,
      authScope,
      collaborationWorkspaceId
    ] as const,
  collaborationWorkspaceAccessRequests: (
    apiBaseUrl: string,
    authScope: string,
    collaborationWorkspaceId: string
  ) =>
    [
      "collaboration-workspace-access-requests",
      apiBaseUrl,
      authScope,
      collaborationWorkspaceId
    ] as const,
  thread: (apiBaseUrl: string, authScope: string, conversationId: string | undefined) =>
    ["thread", apiBaseUrl, authScope, conversationId] as const,
  conversationResources: (
    apiBaseUrl: string,
    authScope: string,
    conversationId: string | undefined
  ) => ["conversation-resources", apiBaseUrl, authScope, conversationId] as const,
  /** Under the conversation's Resources: whatever refreshes them refreshes its subagents too. */
  conversationSubagents: (
    apiBaseUrl: string,
    authScope: string,
    conversationId: string | undefined
  ) => ["conversation-resources", apiBaseUrl, authScope, conversationId, "subagents"] as const,
  structuredDataResourcesScope: (apiBaseUrl: string, authScope: string, conversationId: string) =>
    ["structured-data-resource", apiBaseUrl, authScope, conversationId] as const,
  structuredDataResource: (
    apiBaseUrl: string,
    authScope: string,
    conversationId: string,
    structuredDataResourceId: string
  ) =>
    [
      "structured-data-resource",
      apiBaseUrl,
      authScope,
      conversationId,
      structuredDataResourceId
    ] as const,
  draftAttachmentsScope: (apiBaseUrl: string, authScope: string) =>
    ["draft-attachments", apiBaseUrl, authScope] as const,
  draftAttachments: (apiBaseUrl: string, authScope: string, conversationId: string | undefined) =>
    ["draft-attachments", apiBaseUrl, authScope, conversationId] as const,
  usage: (apiBaseUrl: string, authScope: string) => ["usage", apiBaseUrl, authScope] as const,
  auditEvents: (apiBaseUrl: string, authScope: string) =>
    ["audit-events", apiBaseUrl, authScope] as const,
  superadminUsers: (apiBaseUrl: string, authScope: string) =>
    ["superadmin-users", apiBaseUrl, authScope] as const,
  servicePrincipals: (apiBaseUrl: string, authScope: string) =>
    ["service-principals", apiBaseUrl, authScope] as const,
  /** The signed-in person's own API keys. */
  ownApiKeys: (apiBaseUrl: string, authScope: string) =>
    ["own-api-keys", apiBaseUrl, authScope] as const,
  /** Every person's API keys, as the instance's API access page lists them. */
  personalApiKeys: (apiBaseUrl: string, authScope: string) =>
    ["personal-api-keys", apiBaseUrl, authScope] as const,
  /** The connect code a CLI shows, read before it is confirmed. */
  connectCode: (apiBaseUrl: string, authScope: string, userCode: string) =>
    ["connect-code", apiBaseUrl, authScope, userCode] as const,
  configAssetsOverview: (apiBaseUrl: string, authScope: string) =>
    ["config-assets-overview", apiBaseUrl, authScope] as const,
  /** Where the caller is and what it may do there. */
  platformContext: (apiBaseUrl: string, authScope: string) =>
    ["platform-context", apiBaseUrl, authScope] as const,
  /** What a definition may refer to on this instance. */
  platformReferences: (apiBaseUrl: string, authScope: string) =>
    ["platform-references", apiBaseUrl, authScope] as const,
  /** Every read of the asset operations: the lists and the single assets. */
  assets: (apiBaseUrl: string, authScope: string) => ["assets", apiBaseUrl, authScope] as const,
  /**
   * The one draft of an agent. It stands below the assets, so every write of an asset reads it
   * again, also a save of the agent in the dock beside its page.
   */
  agentDraft: (apiBaseUrl: string, authScope: string, agent: string, workspaceId = "") =>
    ["assets", apiBaseUrl, authScope, "agent-draft", agent, workspaceId] as const,
  administeredCollaborationWorkspaces: (apiBaseUrl: string, authScope: string) =>
    ["administered-collaboration-workspaces", apiBaseUrl, authScope] as const
};
