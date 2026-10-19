// Private chat-ui test seam. Folder moves change this file; tests keep their imports.
// Prefer existing public subpaths for new tests; add private exports here only when needed.
export {
  constrainCredentialScopes,
  copyStateFor,
  DEFAULT_SERVICE_PRINCIPAL_PERMISSIONS,
  expiryInputToIso,
  isCredentialActive,
  optionalTrimmedValue,
  scopesAllowedByPermissions
} from "../../packages/chat-ui/src/admin/control-plane/api-access-model";
export { ApiAccessPanel } from "../../packages/chat-ui/src/admin/control-plane/api-access-panel";
export {
  copySecretField,
  SecretFields
} from "../../packages/chat-ui/src/admin/control-plane/api-access-secret-fields";
export { PersonalApiKeysTable } from "../../packages/chat-ui/src/admin/control-plane/personal-api-keys-list";
export {
  buildPersonalKeyScopes,
  connectCodeAsksUseLevel,
  connectCodeOfSearch,
  formatConnectCode,
  initialPersonalKeyDraft,
  instanceUrl,
  isCompleteConnectCode,
  keysSharingAName,
  personalKeyActionOffer,
  personalKeyDraftProblem,
  personalKeyExpiryOf,
  personalKeyRequest,
  personalKeyScopeParts,
  personalKeyState,
  personalKeyUseOffer,
  setupKeyActions
} from "../../packages/chat-ui/src/admin/control-plane/personal-api-keys-model";
export {
  authSourceLabel,
  filterUsers,
  setUserPermission,
  USER_PERMISSIONS,
  userDisplayStatus,
  userPermissionCopy,
  userPermissionStates,
  userStatusFilterOf
} from "../../packages/chat-ui/src/admin/control-plane/user-administration-model";
export { UserPermissionOverview } from "../../packages/chat-ui/src/admin/control-plane/user-permission-overview";
export { UserPermissionsCard } from "../../packages/chat-ui/src/admin/control-plane/user-permissions-card";
export {
  type BuildAccess,
  firstAdministrationRoute,
  resolveSettingsRoute,
  settingsCatalog,
  settingsGoToTargets,
  visibleSettingsPages
} from "../../packages/chat-ui/src/admin/settings/catalog";
export { SettingsArea } from "../../packages/chat-ui/src/admin/settings/settings-area";
export {
  ApiKeysPage,
  ConnectCodeConfirm
} from "../../packages/chat-ui/src/admin/settings/pages/api-keys";
export {
  ConnectLocalAgentPage,
  ConnectLocalAgentView,
  LOCAL_AGENT_TOOLS,
  localAgentCommand,
  type LocalAgentCommandState,
  type LocalAgentTool
} from "../../packages/chat-ui/src/admin/settings/pages/connect-local-agent";
export { LanguageAppearanceView } from "../../packages/chat-ui/src/admin/settings/pages/language-appearance";
export { WorkspaceGeneralView } from "../../packages/chat-ui/src/admin/settings/pages/workspace-general";
export {
  WorkspaceMembersPage,
  WorkspaceMembersView
} from "../../packages/chat-ui/src/admin/settings/pages/workspace-members";
export { collaborationWorkspacesAvailableFor } from "../../packages/chat-ui/src/chat-workspace";
export { ApprovalDecisionLine } from "../../packages/chat-ui/src/chat/approvals/approval-decision-line";
export { ApprovalRequestCardView } from "../../packages/chat-ui/src/chat/approvals/approval-request-card";
export {
  APPROVAL_REQUEST_DISPLAY_KIND,
  type ApprovalDecisionStatus,
  approvalRevisionHintKey,
  approvalRevisionPlan,
  readApprovalRequestDisplay,
  shouldSendApprovalFollowUp
} from "../../packages/chat-ui/src/chat/approvals/approval-request-model";
export {
  type ApprovalRevisionRunInput,
  startApprovalRevision
} from "../../packages/chat-ui/src/chat/approvals/approval-revision-host";
export {
  buildApprovalRevisionMessage,
  changedLines
} from "../../packages/chat-ui/src/chat/approvals/approval-revision-message";
export { parseSkillChangePreview } from "../../packages/chat-ui/src/chat/approvals/skill-change-preview";
export { AssistantActivityStatus } from "../../packages/chat-ui/src/chat/assistant/assistant-activity-status";
export {
  AssistantComposer,
  shouldExpandComposer
} from "../../packages/chat-ui/src/chat/assistant/assistant-composer";
export {
  acknowledgeRecentlyActiveAssistantRunId,
  isRecentlyActiveAssistantRunId,
  rememberRecentlyActiveAssistantRunId
} from "../../packages/chat-ui/src/chat/assistant/recently-active-runs";
export { AssistantSourcePart } from "../../packages/chat-ui/src/chat/assistant/assistant-source-part";
export {
  AssistantThread,
  ThreadStartBlock,
  ThreadWelcomeHeading
} from "../../packages/chat-ui/src/chat/assistant/assistant-thread";
export {
  type AssistantUiApprovalDecision,
  type AssistantUiMessageMetadata,
  toAiSdkMessageRepository,
  toAttachmentFilePart,
  toUiMessages
} from "../../packages/chat-ui/src/chat/assistant/assistant-ui-adapter";
export {
  ASSISTANT_WORK_GROUP,
  countAssistantWorkTimelineSteps,
  createAssistantMessageGroupBy,
  createAssistantWorkTimelineItems,
  createCompletedAssistantWorkIndices,
  createRenderableAssistantToolGroupIndices,
  createVisibleFinalAssistantPartIndices,
  findFinalAssistantTextPartIndex
} from "../../packages/chat-ui/src/chat/assistant/assistant-work-grouping";
export { useComposerFocusRequest } from "../../packages/chat-ui/src/chat/assistant/composer-focus-request";
export { ContextIndicator } from "../../packages/chat-ui/src/chat/assistant/context-indicator";
export { QueuedSendBridge } from "../../packages/chat-ui/src/chat/assistant/queued-send-bridge";
export { resolveContextUsage } from "../../packages/chat-ui/src/chat/assistant/context-usage";
export { ModelCard, ModelPicker } from "../../packages/chat-ui/src/chat/assistant/model-picker";
export { DockedChat } from "../../packages/chat-ui/src/chat/dock/docked-chat";
export {
  ProductConversationRunTransport,
  startProductConversationRun
} from "../../packages/chat-ui/src/chat/assistant/product-run-transport";
export {
  createQueuedSendSettler,
  draftAttachmentsKey,
  type QueuedSendState,
  resolveSendBlock,
  type SendBlock,
  shouldQueueSend
} from "../../packages/chat-ui/src/chat/assistant/send-block";
export {
  composerActions,
  findRunActivity,
  isThreadBusy,
  shouldShowCancelAction,
  shouldShowRunActivity
} from "../../packages/chat-ui/src/chat/assistant/thread-activity";
export {
  calendarDay,
  createThreadTimes,
  dayMarkerLabel,
  dayOpeningMessages,
  formatElapsedSeconds,
  formatWorkHistoryLabel,
  msUntilNextMidnight,
  transcriptMessageTimes
} from "../../packages/chat-ui/src/chat/assistant/thread-time";
export { ToolActivityLabelsProvider } from "../../packages/chat-ui/src/chat/assistant/tool-activity";
export {
  retentionHintAfter,
  retentionHintClosed,
  type RetentionHintEvent,
  retentionHintOpen
} from "../../packages/chat-ui/src/chat/conversation/conversation-button";
export {
  applyRunObservationToControllerState,
  completeRunObservationStreamInControllerState,
  controllerStateForConversation,
  createControllerStateFromSnapshot,
  createInitialControllerState,
  resolveRunConnectionTarget,
  staleThreadReread
} from "../../packages/chat-ui/src/chat/conversation/conversation-controller-state";
export {
  draftAttachmentPolling,
  uploadErrorMessage,
  uploadFileWithRetry,
  useDraftAttachmentController,
  withoutDraftAttachment
} from "../../packages/chat-ui/src/chat/conversation/draft-attachment-controller";
export {
  type RunConnectionCompletion,
  type RunConnectionManager,
  type RunCursorStorage,
  startRunConnectionManager
} from "../../packages/chat-ui/src/chat/conversation/run-connection-manager";
export {
  ARTIFACT_PREVIEW_POLL_DELAYS_MS,
  ArtifactPreview,
  artifactPreviewPollDelayMs,
  createArtifactPreviewView,
  createImagePagesArtifactPreviewLoadPlan,
  getArtifactSourceFallbackKind,
  shouldUseLiveArtifactPreviewState
} from "../../packages/chat-ui/src/chat/files/artifact-preview";
export { ArtifactPreviewMessage } from "../../packages/chat-ui/src/chat/files/artifact-preview-shell";
export { managedFileIdFromAttachmentContent } from "../../packages/chat-ui/src/chat/files/attachment-preview";
export {
  ConversationFileDownloadButton,
  conversationFileFromArtifact,
  conversationFileFromResource,
  createConversationFilePanelEntry,
  findSourceFileResource,
  findSourceFileResourceByAttachmentId,
  getSourceFilePreviewKind,
  SourceFilePreview
} from "../../packages/chat-ui/src/chat/files/conversation-file-presentation";
export {
  partitionAttachments,
  planAttachmentGroup
} from "../../packages/chat-ui/src/chat/files/message-attachments";
export { ResourcesPanel } from "../../packages/chat-ui/src/chat/files/resources-panel";
export {
  groupConversationResources,
  isResourcesPanelAvailable,
  resolveResourcesPanelOpen,
  structuredDataToTsv
} from "../../packages/chat-ui/src/chat/files/resources-panel-model";
export { workbookToUniverSnapshot } from "../../packages/chat-ui/src/chat/files/spreadsheet-preview";
export { spreadsheetChartOption } from "../../packages/chat-ui/src/chat/files/spreadsheet-visual-layer";
export {
  extractSpreadsheetVisuals,
  type SpreadsheetVisual
} from "../../packages/chat-ui/src/chat/files/spreadsheet-visuals";
export { StructuredDataView } from "../../packages/chat-ui/src/chat/files/structured-data-view";
export {
  approvalActionFailure,
  formatInboxAge,
  InboxAreaView,
  type InboxCounts,
  type InboxItemActions,
  type InboxItemKind,
  inboxItemKinds,
  InboxItemKindsProvider,
  inboxItemSurface,
  InboxItemPanel,
  InboxItemView,
  InboxList,
  inboxListOutdatesItem,
  inboxRailEntry,
  type InboxTab,
  inboxTabCount,
  inboxTabOfItem,
  inboxTabs,
  orderInboxItems
} from "../../packages/chat-ui/src/chat/inbox";
export { WorkspaceDraftsProvider } from "../../packages/chat-ui/src/chat/workspace/workspace-drafts";
export {
  chosenLocale,
  latestSavingLocale,
  savingLocaleFilters
} from "../../packages/chat-ui/src/chat/workspace/account-locale";
export {
  currentUserUpdateOptions,
  useWorkspaceSignOutMutation
} from "../../packages/chat-ui/src/shared/api/workspace-mutations";
export {
  MarkdownArtifact,
  MarkdownLinkPolicyProvider
} from "../../packages/chat-ui/src/chat/markdown/markdown-text";
export {
  answeredSubagentState,
  groupSubagents,
  requestToolCallReveal,
  subagentState,
  takeToolCallReveal
} from "../../packages/chat-ui/src/chat/subagents/subagent-model";
export { SurfaceSlotFrame } from "../../packages/chat-ui/src/chat/surface/surface-slot";
export {
  artifactDisplayFilename,
  artifactDownloadFilename,
  getArtifactFileType,
  getArtifactPreviewKind,
  isWorkspacePromotedArtifactsData,
  readArtifactImagePagesPreview,
  readSurfacedToolArtifactRefs,
  readToolArtifactRefs,
  type ToolArtifactDownloadRef,
  WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE
} from "../../packages/chat-ui/src/chat/tools/tool-artifacts";
export { ToolSurfaceList } from "../../packages/chat-ui/src/chat/tools/tool-surface-card";
export {
  dedupeToolSurfaceRefs,
  readToolSurfaceRefs
} from "../../packages/chat-ui/src/chat/tools/tool-surfaces";
export {
  formatWorkspaceCommandActionLabel,
  projectWorkspaceToolDisplay
} from "../../packages/chat-ui/src/chat/tools/workspace-tool-display";
export {
  agentModelSelection,
  type AgentSelectableModel,
  conversationModelPicks,
  modelReasoningEffortSelection
} from "../../packages/chat-ui/src/chat/workspace/agent-model-selection";
export {
  agentChipDisplayFor,
  agentPickerOptions
} from "../../packages/chat-ui/src/chat/workspace/agent-selector";
export { ConversationPalette } from "../../packages/chat-ui/src/chat/workspace/conversation-palette";
export { ClientBrandingHeader } from "../../packages/chat-ui/src/chat/workspace/client-branding";
export {
  addressDockConversation,
  clampDockWidth,
  DOCK_DEFAULT_WIDTH,
  dockConversationOfSearch,
  dockMotion,
  dockPlacement,
  searchWithDock
} from "../../packages/chat-ui/src/chat/workspace/dock-state";
export {
  dockConversationToReuse,
  openConversationAbout
} from "../../packages/chat-ui/src/chat/workspace/open-conversation-about";
export { UserMenu } from "../../packages/chat-ui/src/chat/workspace/user-menu";
export {
  activeAgentNameFor,
  isAbandonedDraftConversation,
  terminalRunNotice,
  workspaceScopedConfigFor
} from "../../packages/chat-ui/src/chat/workspace/workspace-chat-model";
export {
  ConfigCheckPanel,
  OutdatedInterfaceBanner,
  SessionCheckPanel,
  StagingBanner,
  WorkspaceChrome
} from "../../packages/chat-ui/src/chat/workspace/workspace-chrome";
export {
  type RailSection,
  railSections,
  recentConversations,
  shownRailSections,
  WorkspaceRail
} from "../../packages/chat-ui/src/chat/workspace/workspace-rail";
export { workspaceSendBlock } from "../../packages/chat-ui/src/chat/workspace/workspace-send-block";
export { WorkspaceUiStateProvider } from "../../packages/chat-ui/src/chat/workspace/workspace-ui-state";
export {
  createApiAccessAuthorityKey,
  createApiAccessRevealController
} from "../../packages/chat-ui/src/shared/api/api-access-reveal-controller";
export { createAssetWrites } from "../../packages/chat-ui/src/shared/api/asset-writes";
export {
  loadOlderRailConversations,
  RAIL_PAGE_SIZE,
  type RailConversations,
  railConversationsQueryOptions,
  refreshRailConversations,
  updateRailConversations,
  withFirstPage,
  withOlderPage
} from "../../packages/chat-ui/src/shared/api/rail-conversations";
export {
  useWorkspaceApiClient,
  WorkspaceApiClientProvider
} from "@work-shape/catalyst-chat-ui/workspace-api-client";
export {
  cacheStartedRunThread,
  conversationListCacheKey,
  createWorkspaceQueryClient,
  getCurrentUserWithinDeadline,
  listCollaborationWorkspacesWithPersonal,
  readThreadAgain,
  threadQueryRetry,
  threadRetryDelay,
  workspaceConfigQueryOptions
} from "../../packages/chat-ui/src/shared/api/workspace-queries";
export { workspaceQueryKeys } from "../../packages/chat-ui/src/shared/api/workspace-query-keys";
export { BrowseCollaborationWorkspacesDialog } from "../../packages/chat-ui/src/shared/collaboration-workspace/browse-collaboration-workspaces-dialog";
export {
  collaborationWorkspaceAccentAttributes,
  collaborationWorkspaceAccentColors,
  collaborationWorkspaceAccentTokens,
  contrastRatio,
  defaultCollaborationWorkspaceAccentColor,
  randomCollaborationWorkspaceAccentColor,
  resolveCollaborationWorkspaceAccentColor
} from "../../packages/chat-ui/src/shared/collaboration-workspace/collaboration-workspace-accent";
export {
  collaborationWorkspaceEmojiChoices,
  collaborationWorkspaceEmojiSuggestions
} from "../../packages/chat-ui/src/shared/collaboration-workspace/collaboration-workspace-emoji";
export {
  CollaborationWorkspaceChangeHeldError,
  collaborationWorkspaceErrorKey
} from "../../packages/chat-ui/src/shared/collaboration-workspace/collaboration-workspace-errors";
export { CollaborationWorkspaceEmojiGrid } from "../../packages/chat-ui/src/shared/collaboration-workspace/collaboration-workspace-fields";
export {
  CollaborationWorkspaceAddMemberForm,
  CollaborationWorkspaceMemberCandidateList,
  nextCollaborationWorkspaceMemberCandidate
} from "../../packages/chat-ui/src/shared/collaboration-workspace/collaboration-workspace-member-search";
export {
  canonicalConversationRedirect,
  useCollaborationWorkspaceModel,
  type CollaborationWorkspaceModelInput
} from "../../packages/chat-ui/src/shared/collaboration-workspace/collaboration-workspace-model";
export { ClosedWorkspaceLinkBanner } from "../../packages/chat-ui/src/chat/workspace/workspace-chrome";
export {
  canChangeCollaborationWorkspaceRole,
  canDeleteCollaborationWorkspace,
  canRemoveCollaborationWorkspaceMember
} from "../../packages/chat-ui/src/shared/collaboration-workspace/collaboration-workspace-roles";
export {
  CollaborationWorkspaceSelector,
  CollaborationWorkspaceSelectorMenu
} from "../../packages/chat-ui/src/shared/collaboration-workspace/collaboration-workspace-selector";
export { CreateCollaborationWorkspaceDialog } from "../../packages/chat-ui/src/shared/collaboration-workspace/create-collaboration-workspace-dialog";
export {
  CollaborationWorkspaceDeletionConfirmStep,
  CollaborationWorkspaceDeletionImpactStep
} from "../../packages/chat-ui/src/shared/collaboration-workspace/delete-collaboration-workspace-dialog";
export {
  moveConversationDestinations,
  MoveConversationDialog,
  MoveConversationVisibility,
  movedConversationVisibility
} from "../../packages/chat-ui/src/shared/collaboration-workspace/move-conversation-dialog";
export {
  defineToolDisplayWidget,
  readToolDisplayPayloadFromToolResult,
  type StandardSchemaV1,
  type ToolDisplayRenderInput,
  toolDisplayWidgetRegistry
} from "../../packages/chat-ui/src/shared/domain-ui-widgets";
export {
  areaOfRoute,
  areaRoutePaths,
  areaRoutes,
  workspaceRouteFromPath,
  workspaceRouteNavigation,
  workspaceRoutePath
} from "../../packages/chat-ui/src/shared/routes";
export {
  installStaleChunkRecovery,
  STALE_CHUNK_RELOAD_COOLDOWN_MS
} from "../../packages/chat-ui/src/shared/stale-chunk-recovery";
export { resolveThemeModePreference } from "../../packages/chat-ui/src/shared/theme";
export {
  routeCollaborationWorkspaceId,
  routeConversationId,
  workspaceRouteView
} from "../../packages/chat-ui/src/shared/workspace-route";
export {
  createEnvironmentDocumentTitle,
  readStoredContextIndicatorPreference,
  writeStoredContextIndicatorPreference
} from "../../packages/chat-ui/src/shared/workspace-utils";

export { useDocumentLanguage } from "../../packages/chat-ui/src/shared/i18n";
export { rightSentenceKeys } from "../../packages/chat-ui/src/admin/access/grant-words";

// Source-reading contract tests share the same relocation seam as executable imports.
export const chatUiSources = {
  i18n: new URL("../../packages/chat-ui/src/shared/i18n", import.meta.url),
  toolCall: new URL("../../packages/chat-ui/src/chat/tools/tool-call.tsx", import.meta.url)
};

export {
  narrativeHolds,
  parsePublishNarrative,
  type PublishNarrativeRead
} from "../../packages/chat-ui/src/shared/publish-narrative";

export {
  runsReadable,
  workflowRightsOn
} from "../../packages/chat-ui/src/studio/workflows/workflow-model";

export {
  endShellSession,
  finishSessionChange,
  personIdIn,
  sessionMark,
  sessionStillOn,
  shellSessionFor,
  showsWorkspace,
  subscribeToShellCache,
  type ShellSession
} from "../../packages/chat-ui/src/shared/shell-session";
export { useDraftForNewConnection } from "../../packages/chat-ui/src/studio/build-area/connection-draft";
export {
  conversationStart,
  dockKindOfRoute,
  type ConversationStart
} from "../../packages/chat-ui/src/chat/dock/subject-starters";
export { useStartRun } from "../../packages/chat-ui/src/studio/workflows/start-run";
export {
  readsRecipientPeople,
  WorkflowsHostWithRecipients
} from "../../packages/chat-ui/src/studio/workflows/workflows-host";
export { attachedFilesTitle } from "../../packages/chat-ui/src/chat/workspace/workspace-conversation-actions";
export { ThreadMessage } from "../../packages/chat-ui/src/chat/assistant/assistant-message";
export { AssistantToolRegistry } from "../../packages/chat-ui/src/chat/assistant/assistant-tool-registry";
export { ToolDecisionsProvider } from "../../packages/chat-ui/src/chat/approvals/tool-decision-context";
