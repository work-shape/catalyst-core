import {
  approvalRequestSchema,
  approvalRequestViewSchema,
  decideApprovalRequestSchema,
  pendingApprovalRequestCountSchema
} from "./approval-requests";
import { z } from "zod";
import { defineBlobApiOperation, defineJsonApiOperation } from "./http-operation";
import {
  administeredCollaborationWorkspaceSchema,
  agentAvailabilitySchema,
  clientBrandingSchema,
  collaborationWorkspaceAgentsSchema,
  configAssetBundleSchema,
  configAssetMutationVersionRequestSchema,
  configAssetMutationVersionResponseSchema,
  configAssetRevisionSchema,
  configAssetSchema,
  configAssetsOverviewSchema,
  exportConfigAssetsResponseSchema,
  putConfigAssetRequestSchema,
  putConfigAssetResponseSchema,
  replaceConfigAssetsRequestSchema,
  replaceConfigAssetsResponseSchema,
  revertConfigAssetRequestSchema,
  safeConfigSchema,
  setConfigAgentAvailabilityRequestSchema,
  setDefaultConfigAgentRequestSchema,
  userModelPreferenceSchema,
  validateConfigAssetsResponseSchema
} from "./configuration";
import {
  addWorkspaceMemberRequestSchema,
  collaborationWorkspaceDirectoryItemSchema,
  collaborationWorkspaceWithRoleSchema,
  createCollaborationWorkspaceRequestSchema,
  deleteCollaborationWorkspaceRequestSchema,
  collaborationWorkspaceDeletionImpactSchema,
  collaborationWorkspaceDeletionResultSchema,
  updateCollaborationWorkspaceRequestSchema,
  updateWorkspaceMemberRoleRequestSchema,
  workspaceAccessRequestItemSchema,
  workspaceAccessRequestSchema,
  workspaceMemberCandidateSchema,
  workspaceMemberSchema,
  workspaceMembershipSchema
} from "./collaboration-workspaces";
import {
  artifactPreviewResponseSchema,
  cancelRunRequestSchema,
  cancelRunResponseSchema,
  conversationListItemSchema,
  conversationResourceListResponseSchema,
  conversationSchema,
  conversationThreadSnapshotSchema,
  createConversationRequestSchema,
  createConversationRunRequestSchema,
  draftAttachmentSchema,
  draftAttachmentUploadResponseSchema,
  messageSchema,
  moveConversationRequestSchema,
  renameConversationRequestSchema,
  retryArtifactPreviewResponseSchema,
  retryDraftAttachmentResponseSchema,
  runCommandRequestSchema,
  runCommandResponseSchema,
  runObservationSchema,
  startConversationRunRequestSchema,
  startConversationRunResponseSchema,
  structuredDataResourceResponseSchema
} from "./conversations";
import {
  administeredUserSchema,
  apiCredentialSchema,
  apiUserSchema,
  changeCurrentUserPasswordRequestSchema,
  changeCurrentUserPasswordResponseSchema,
  completePasswordSetupRequestSchema,
  completePasswordSetupResponseSchema,
  createAdministeredUserRequestSchema,
  createApiCredentialRequestSchema,
  createApiCredentialResponseSchema,
  createServicePrincipalRequestSchema,
  deleteCurrentUserResponseSchema,
  exchangeApiKeyResponseSchema,
  issueSessionTokenRequestSchema,
  issueSessionTokenResponseSchema,
  requestPasswordResetRequestSchema,
  requestPasswordResetResponseSchema,
  resetAdministeredUserPasswordRequestSchema,
  resetAdministeredUserPasswordResponseSchema,
  sendAdministeredUserInvitationResponseSchema,
  servicePrincipalDetailSchema,
  updateAdministeredUserRequestSchema,
  updateCurrentUserRequestSchema,
  updateServicePrincipalRequestSchema,
  upsertAdministeredUserIdentityRequestSchema
} from "./identity";
import { auditActivitySchema, auditEventSchema, usageSummarySchema } from "./governance";

export const apiOperations = {
  getApprovalRequest: defineJsonApiOperation({
    operationId: "getApprovalRequest",
    method: "GET",
    path: "/api/approval-requests/:requestId",
    responseSchema: approvalRequestViewSchema
  }),
  listApprovalRequests: defineJsonApiOperation({
    operationId: "listApprovalRequests",
    method: "GET",
    path: "/api/approval-requests",
    queryParams: ["status"],
    responseSchema: z.array(approvalRequestViewSchema)
  }),
  countPendingApprovalRequests: defineJsonApiOperation({
    operationId: "countPendingApprovalRequests",
    method: "GET",
    path: "/api/approval-requests/pending-count",
    responseSchema: pendingApprovalRequestCountSchema
  }),
  decideApprovalRequest: defineJsonApiOperation({
    operationId: "decideApprovalRequest",
    method: "POST",
    path: "/api/approval-requests/:requestId/decide",
    requestSchema: decideApprovalRequestSchema,
    responseSchema: approvalRequestSchema
  }),
  withdrawApprovalRequest: defineJsonApiOperation({
    operationId: "withdrawApprovalRequest",
    method: "POST",
    path: "/api/approval-requests/:requestId/withdraw",
    responseSchema: approvalRequestSchema
  }),
  revertApprovalRequest: defineJsonApiOperation({
    operationId: "revertApprovalRequest",
    method: "POST",
    path: "/api/approval-requests/:requestId/revert",
    responseSchema: approvalRequestSchema
  }),
  getCurrentUser: defineJsonApiOperation({
    operationId: "getCurrentUser",
    method: "GET",
    path: "/api/me",
    responseSchema: apiUserSchema
  }),
  updateCurrentUser: defineJsonApiOperation({
    operationId: "updateCurrentUser",
    method: "PATCH",
    path: "/api/me",
    requestSchema: updateCurrentUserRequestSchema,
    responseSchema: apiUserSchema
  }),
  getCurrentUserModelPreference: defineJsonApiOperation({
    operationId: "getCurrentUserModelPreference",
    method: "GET",
    path: "/api/me/model-preference",
    responseSchema: userModelPreferenceSchema
  }),
  setCurrentUserModelPreference: defineJsonApiOperation({
    operationId: "setCurrentUserModelPreference",
    method: "PUT",
    path: "/api/me/model-preference",
    requestSchema: userModelPreferenceSchema,
    responseSchema: userModelPreferenceSchema
  }),
  changeCurrentUserPassword: defineJsonApiOperation({
    operationId: "changeCurrentUserPassword",
    method: "POST",
    path: "/api/me/password",
    requestSchema: changeCurrentUserPasswordRequestSchema,
    responseSchema: changeCurrentUserPasswordResponseSchema
  }),
  deleteCurrentUser: defineJsonApiOperation({
    operationId: "deleteCurrentUser",
    method: "DELETE",
    path: "/api/me",
    responseSchema: deleteCurrentUserResponseSchema
  }),
  requestPasswordReset: defineJsonApiOperation({
    operationId: "requestPasswordReset",
    method: "POST",
    path: "/api/password-reset",
    queryParams: ["locale"],
    requestSchema: requestPasswordResetRequestSchema,
    responseSchema: requestPasswordResetResponseSchema
  }),
  completePasswordSetup: defineJsonApiOperation({
    operationId: "completePasswordSetup",
    method: "POST",
    path: "/api/password-setup",
    requestSchema: completePasswordSetupRequestSchema,
    responseSchema: completePasswordSetupResponseSchema
  }),
  getBranding: defineJsonApiOperation({
    operationId: "getBranding",
    method: "GET",
    path: "/api/branding",
    queryParams: ["locale"],
    responseSchema: clientBrandingSchema
  }),
  getConfig: defineJsonApiOperation({
    operationId: "getConfig",
    method: "GET",
    path: "/api/config",
    queryParams: ["locale"],
    responseSchema: safeConfigSchema
  }),
  listCollaborationWorkspaces: defineJsonApiOperation({
    operationId: "listCollaborationWorkspaces",
    method: "GET",
    path: "/api/collaboration-workspaces",
    responseSchema: z.array(collaborationWorkspaceWithRoleSchema)
  }),
  createCollaborationWorkspace: defineJsonApiOperation({
    operationId: "createCollaborationWorkspace",
    method: "POST",
    path: "/api/collaboration-workspaces",
    requestSchema: createCollaborationWorkspaceRequestSchema,
    responseSchema: collaborationWorkspaceWithRoleSchema
  }),
  listCollaborationWorkspaceDirectory: defineJsonApiOperation({
    operationId: "listCollaborationWorkspaceDirectory",
    method: "GET",
    path: "/api/collaboration-workspaces/directory",
    responseSchema: z.array(collaborationWorkspaceDirectoryItemSchema)
  }),
  getCollaborationWorkspace: defineJsonApiOperation({
    operationId: "getCollaborationWorkspace",
    method: "GET",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId",
    responseSchema: collaborationWorkspaceWithRoleSchema
  }),
  listCollaborationWorkspaceAgents: defineJsonApiOperation({
    operationId: "listCollaborationWorkspaceAgents",
    method: "GET",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/agents",
    queryParams: ["locale"],
    responseSchema: collaborationWorkspaceAgentsSchema
  }),
  updateCollaborationWorkspace: defineJsonApiOperation({
    operationId: "updateCollaborationWorkspace",
    method: "PATCH",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId",
    requestSchema: updateCollaborationWorkspaceRequestSchema,
    responseSchema: collaborationWorkspaceWithRoleSchema
  }),
  getCollaborationWorkspaceDeletionImpact: defineJsonApiOperation({
    operationId: "getCollaborationWorkspaceDeletionImpact",
    method: "GET",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/deletion-impact",
    responseSchema: collaborationWorkspaceDeletionImpactSchema
  }),
  deleteCollaborationWorkspace: defineJsonApiOperation({
    operationId: "deleteCollaborationWorkspace",
    method: "DELETE",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId",
    requestSchema: deleteCollaborationWorkspaceRequestSchema,
    responseSchema: collaborationWorkspaceDeletionResultSchema
  }),
  listCollaborationWorkspaceMembers: defineJsonApiOperation({
    operationId: "listCollaborationWorkspaceMembers",
    method: "GET",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/members",
    responseSchema: z.array(workspaceMemberSchema)
  }),
  listCollaborationWorkspaceMemberCandidates: defineJsonApiOperation({
    operationId: "listCollaborationWorkspaceMemberCandidates",
    method: "GET",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/member-candidates",
    queryParams: ["q"],
    responseSchema: z.array(workspaceMemberCandidateSchema)
  }),
  addCollaborationWorkspaceMember: defineJsonApiOperation({
    operationId: "addCollaborationWorkspaceMember",
    method: "POST",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/members",
    requestSchema: addWorkspaceMemberRequestSchema,
    responseSchema: workspaceMemberSchema
  }),
  updateCollaborationWorkspaceMemberRole: defineJsonApiOperation({
    operationId: "updateCollaborationWorkspaceMemberRole",
    method: "PATCH",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/members/:userId",
    requestSchema: updateWorkspaceMemberRoleRequestSchema,
    responseSchema: workspaceMembershipSchema
  }),
  removeCollaborationWorkspaceMember: defineJsonApiOperation({
    operationId: "removeCollaborationWorkspaceMember",
    method: "DELETE",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/members/:userId",
    responseSchema: workspaceMembershipSchema
  }),
  leaveCollaborationWorkspace: defineJsonApiOperation({
    operationId: "leaveCollaborationWorkspace",
    method: "DELETE",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/members/me",
    responseSchema: workspaceMembershipSchema
  }),
  requestCollaborationWorkspaceAccess: defineJsonApiOperation({
    operationId: "requestCollaborationWorkspaceAccess",
    method: "POST",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/access-requests",
    responseSchema: workspaceAccessRequestSchema
  }),
  listCollaborationWorkspaceAccessRequests: defineJsonApiOperation({
    operationId: "listCollaborationWorkspaceAccessRequests",
    method: "GET",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/access-requests",
    responseSchema: z.array(workspaceAccessRequestItemSchema)
  }),
  approveCollaborationWorkspaceAccessRequest: defineJsonApiOperation({
    operationId: "approveCollaborationWorkspaceAccessRequest",
    method: "POST",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/access-requests/:userId/approve",
    responseSchema: workspaceMembershipSchema
  }),
  declineCollaborationWorkspaceAccessRequest: defineJsonApiOperation({
    operationId: "declineCollaborationWorkspaceAccessRequest",
    method: "DELETE",
    path: "/api/collaboration-workspaces/:collaborationWorkspaceId/access-requests/:userId",
    responseSchema: workspaceAccessRequestSchema
  }),
  listConversations: defineJsonApiOperation({
    operationId: "listConversations",
    method: "GET",
    path: "/api/conversations",
    queryParams: ["collaborationWorkspaceId"],
    responseSchema: z.array(conversationListItemSchema)
  }),
  createConversation: defineJsonApiOperation({
    operationId: "createConversation",
    method: "POST",
    path: "/api/conversations",
    requestSchema: createConversationRequestSchema,
    responseSchema: conversationSchema
  }),
  generateConversationTitle: defineJsonApiOperation({
    operationId: "generateConversationTitle",
    method: "POST",
    path: "/api/conversations/:conversationId/title",
    responseSchema: conversationSchema
  }),
  renameConversation: defineJsonApiOperation({
    operationId: "renameConversation",
    method: "PATCH",
    path: "/api/conversations/:conversationId/title",
    requestSchema: renameConversationRequestSchema,
    responseSchema: conversationSchema
  }),
  moveConversation: defineJsonApiOperation({
    operationId: "moveConversation",
    method: "POST",
    path: "/api/conversations/:conversationId/move",
    requestSchema: moveConversationRequestSchema,
    responseSchema: conversationSchema
  }),
  getConversationThread: defineJsonApiOperation({
    operationId: "getConversationThread",
    method: "GET",
    path: "/api/conversations/:conversationId/thread",
    responseSchema: conversationThreadSnapshotSchema
  }),
  listConversationMessages: defineJsonApiOperation({
    operationId: "listConversationMessages",
    method: "GET",
    path: "/api/conversations/:conversationId/messages",
    responseSchema: z.array(messageSchema)
  }),
  listConversationResources: defineJsonApiOperation({
    operationId: "listConversationResources",
    method: "GET",
    path: "/api/conversations/:conversationId/resources",
    responseSchema: conversationResourceListResponseSchema
  }),
  getStructuredDataResource: defineJsonApiOperation({
    operationId: "getStructuredDataResource",
    method: "GET",
    path: "/api/conversations/:conversationId/structured-data/:structuredDataResourceId",
    responseSchema: structuredDataResourceResponseSchema
  }),
  cancelConversationRun: defineJsonApiOperation({
    operationId: "cancelConversationRun",
    method: "POST",
    path: "/api/conversations/:conversationId/runs/:runId/cancel",
    requestSchema: cancelRunRequestSchema,
    responseSchema: cancelRunResponseSchema
  }),
  startConversationRun: defineJsonApiOperation({
    operationId: "startConversationRun",
    method: "POST",
    path: "/api/conversations/:conversationId/runs",
    requestSchema: startConversationRunRequestSchema,
    responseSchema: startConversationRunResponseSchema
  }),
  createConversationRun: defineJsonApiOperation({
    operationId: "createConversationRun",
    method: "POST",
    path: "/api/conversations/runs",
    requestSchema: createConversationRunRequestSchema,
    responseSchema: startConversationRunResponseSchema
  }),
  observeConversationRun: defineJsonApiOperation({
    operationId: "observeConversationRun",
    method: "GET",
    path: "/api/conversations/:conversationId/runs/:runId/events",
    queryParams: ["after"],
    responseSchema: runObservationSchema
  }),
  commandConversationRun: defineJsonApiOperation({
    operationId: "commandConversationRun",
    method: "POST",
    path: "/api/conversations/:conversationId/runs/:runId/commands",
    requestSchema: runCommandRequestSchema,
    responseSchema: runCommandResponseSchema
  }),
  deleteConversation: defineJsonApiOperation({
    operationId: "deleteConversation",
    method: "DELETE",
    path: "/api/conversations/:conversationId",
    responseSchema: conversationSchema
  }),
  listDraftAttachments: defineJsonApiOperation({
    operationId: "listDraftAttachments",
    method: "GET",
    path: "/api/conversations/:conversationId/draft-attachments",
    responseSchema: z.array(draftAttachmentSchema)
  }),
  uploadDraftAttachment: defineJsonApiOperation({
    operationId: "uploadDraftAttachment",
    method: "POST",
    path: "/api/conversations/:conversationId/draft-attachments",
    requestKind: "multipart",
    responseSchema: draftAttachmentUploadResponseSchema
  }),
  retryDraftAttachment: defineJsonApiOperation({
    operationId: "retryDraftAttachment",
    method: "POST",
    path: "/api/conversations/:conversationId/draft-attachments/:attachmentId/retry",
    responseSchema: retryDraftAttachmentResponseSchema
  }),
  deleteDraftAttachment: defineJsonApiOperation({
    operationId: "deleteDraftAttachment",
    method: "DELETE",
    path: "/api/conversations/:conversationId/draft-attachments/:attachmentId",
    responseSchema: draftAttachmentSchema
  }),
  getConversationFileContent: defineBlobApiOperation({
    operationId: "getConversationFileContent",
    method: "GET",
    path: "/api/conversations/:conversationId/files/:fileId/content",
    queryParams: ["download"]
  }),
  getConversationArtifactContent: defineBlobApiOperation({
    operationId: "getConversationArtifactContent",
    method: "GET",
    path: "/api/conversations/:conversationId/artifacts/:artifactId/content",
    queryParams: ["inline"]
  }),
  getConversationArtifactPreview: defineJsonApiOperation({
    operationId: "getConversationArtifactPreview",
    method: "GET",
    path: "/api/conversations/:conversationId/artifacts/:artifactId/preview",
    responseSchema: artifactPreviewResponseSchema
  }),
  getConversationAttachmentPreview: defineJsonApiOperation({
    operationId: "getConversationAttachmentPreview",
    method: "GET",
    path: "/api/conversations/:conversationId/attachments/:attachmentId/preview",
    responseSchema: artifactPreviewResponseSchema
  }),
  retryConversationArtifactPreview: defineJsonApiOperation({
    operationId: "retryConversationArtifactPreview",
    method: "POST",
    path: "/api/conversations/:conversationId/artifacts/:artifactId/preview/retry",
    responseSchema: retryArtifactPreviewResponseSchema
  }),
  listAuditEvents: defineJsonApiOperation({
    operationId: "listAuditEvents",
    method: "GET",
    path: "/api/audit-events",
    responseSchema: z.array(auditEventSchema)
  }),
  listAuditActivities: defineJsonApiOperation({
    operationId: "listAuditActivities",
    method: "GET",
    path: "/api/audit-activities",
    responseSchema: z.array(auditActivitySchema)
  }),
  getUsageSummary: defineJsonApiOperation({
    operationId: "getUsageSummary",
    method: "GET",
    path: "/api/superadmin/usage",
    responseSchema: usageSummarySchema
  }),
  getConfigAssetsOverview: defineJsonApiOperation({
    operationId: "getConfigAssetsOverview",
    method: "GET",
    path: "/api/admin/config/assets",
    responseSchema: configAssetsOverviewSchema
  }),
  getConfigAsset: defineJsonApiOperation({
    operationId: "getConfigAsset",
    method: "GET",
    path: "/api/admin/config/assets/:kind/:name",
    responseSchema: configAssetSchema
  }),
  putConfigAsset: defineJsonApiOperation({
    operationId: "putConfigAsset",
    method: "PUT",
    path: "/api/admin/config/assets/:kind/:name",
    requestSchema: putConfigAssetRequestSchema,
    responseSchema: putConfigAssetResponseSchema
  }),
  deleteConfigAsset: defineJsonApiOperation({
    operationId: "deleteConfigAsset",
    method: "POST",
    path: "/api/admin/config/assets/:kind/:name/delete",
    requestSchema: configAssetMutationVersionRequestSchema,
    responseSchema: configAssetMutationVersionResponseSchema
  }),
  setDefaultConfigAgent: defineJsonApiOperation({
    operationId: "setDefaultConfigAgent",
    method: "PUT",
    path: "/api/admin/config/default-agent",
    requestSchema: setDefaultConfigAgentRequestSchema,
    responseSchema: configAssetMutationVersionResponseSchema
  }),
  setConfigAgentAvailability: defineJsonApiOperation({
    operationId: "setConfigAgentAvailability",
    method: "PUT",
    path: "/api/admin/config/agents/:name/availability",
    requestSchema: setConfigAgentAvailabilityRequestSchema,
    responseSchema: agentAvailabilitySchema
  }),
  listAdministeredCollaborationWorkspaces: defineJsonApiOperation({
    operationId: "listAdministeredCollaborationWorkspaces",
    method: "GET",
    path: "/api/admin/collaboration-workspaces",
    responseSchema: z.array(administeredCollaborationWorkspaceSchema)
  }),
  listConfigAssetRevisions: defineJsonApiOperation({
    operationId: "listConfigAssetRevisions",
    method: "GET",
    path: "/api/admin/config/assets/:kind/:name/revisions",
    responseSchema: z.array(configAssetRevisionSchema)
  }),
  revertConfigAsset: defineJsonApiOperation({
    operationId: "revertConfigAsset",
    method: "POST",
    path: "/api/admin/config/assets/:kind/:name/revert",
    requestSchema: revertConfigAssetRequestSchema,
    responseSchema: putConfigAssetResponseSchema
  }),
  exportConfigAssets: defineJsonApiOperation({
    operationId: "exportConfigAssets",
    method: "GET",
    path: "/api/admin/config/export",
    responseSchema: exportConfigAssetsResponseSchema
  }),
  replaceConfigAssets: defineJsonApiOperation({
    operationId: "replaceConfigAssets",
    method: "POST",
    path: "/api/admin/config/import",
    requestSchema: replaceConfigAssetsRequestSchema,
    responseSchema: replaceConfigAssetsResponseSchema
  }),
  validateConfigAssets: defineJsonApiOperation({
    operationId: "validateConfigAssets",
    method: "POST",
    path: "/api/admin/config/validate",
    requestSchema: configAssetBundleSchema,
    responseSchema: validateConfigAssetsResponseSchema
  }),
  listAdministeredUsers: defineJsonApiOperation({
    operationId: "listAdministeredUsers",
    method: "GET",
    path: "/api/superadmin/users",
    responseSchema: z.array(administeredUserSchema)
  }),
  createAdministeredUser: defineJsonApiOperation({
    operationId: "createAdministeredUser",
    method: "POST",
    path: "/api/superadmin/users",
    requestSchema: createAdministeredUserRequestSchema,
    responseSchema: administeredUserSchema
  }),
  updateAdministeredUser: defineJsonApiOperation({
    operationId: "updateAdministeredUser",
    method: "PATCH",
    path: "/api/superadmin/users/:userId",
    requestSchema: updateAdministeredUserRequestSchema,
    responseSchema: administeredUserSchema
  }),
  deleteAdministeredUser: defineJsonApiOperation({
    operationId: "deleteAdministeredUser",
    method: "DELETE",
    path: "/api/superadmin/users/:userId",
    responseSchema: administeredUserSchema
  }),
  upsertAdministeredUserIdentity: defineJsonApiOperation({
    operationId: "upsertAdministeredUserIdentity",
    method: "PUT",
    path: "/api/superadmin/users/:userId/identities",
    requestSchema: upsertAdministeredUserIdentityRequestSchema,
    responseSchema: administeredUserSchema
  }),
  resetAdministeredUserPassword: defineJsonApiOperation({
    operationId: "resetAdministeredUserPassword",
    method: "POST",
    path: "/api/superadmin/users/:userId/password",
    requestSchema: resetAdministeredUserPasswordRequestSchema,
    responseSchema: resetAdministeredUserPasswordResponseSchema
  }),
  sendAdministeredUserInvitation: defineJsonApiOperation({
    operationId: "sendAdministeredUserInvitation",
    method: "POST",
    path: "/api/superadmin/users/:userId/invitation",
    responseSchema: sendAdministeredUserInvitationResponseSchema
  }),
  listServicePrincipals: defineJsonApiOperation({
    operationId: "listServicePrincipals",
    method: "GET",
    path: "/api/superadmin/api-access/service-principals",
    responseSchema: z.array(servicePrincipalDetailSchema)
  }),
  createServicePrincipal: defineJsonApiOperation({
    operationId: "createServicePrincipal",
    method: "POST",
    path: "/api/superadmin/api-access/service-principals",
    requestSchema: createServicePrincipalRequestSchema,
    responseSchema: servicePrincipalDetailSchema
  }),
  updateServicePrincipal: defineJsonApiOperation({
    operationId: "updateServicePrincipal",
    method: "PATCH",
    path: "/api/superadmin/api-access/service-principals/:servicePrincipalId",
    requestSchema: updateServicePrincipalRequestSchema,
    responseSchema: servicePrincipalDetailSchema
  }),
  createApiCredential: defineJsonApiOperation({
    operationId: "createApiCredential",
    method: "POST",
    path: "/api/superadmin/api-access/service-principals/:servicePrincipalId/credentials",
    requestSchema: createApiCredentialRequestSchema,
    responseSchema: createApiCredentialResponseSchema
  }),
  revokeApiCredential: defineJsonApiOperation({
    operationId: "revokeApiCredential",
    method: "POST",
    path: "/api/superadmin/api-access/credentials/:credentialId/revoke",
    responseSchema: apiCredentialSchema
  }),
  deleteAdministeredUserIdentity: defineJsonApiOperation({
    operationId: "deleteAdministeredUserIdentity",
    method: "DELETE",
    path: "/api/superadmin/users/:userId/identities/:authSource/:externalUserId",
    responseSchema: administeredUserSchema
  }),
  issueSessionToken: defineJsonApiOperation({
    operationId: "issueSessionToken",
    method: "POST",
    path: "/api/superadmin/session-tokens",
    requestSchema: issueSessionTokenRequestSchema,
    responseSchema: issueSessionTokenResponseSchema
  }),
  exchangeApiKey: defineJsonApiOperation({
    operationId: "exchangeApiKey",
    method: "POST",
    path: "/api/auth/access-token",
    responseSchema: exchangeApiKeyResponseSchema
  })
} as const;
