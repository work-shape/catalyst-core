import { z } from "zod";
import { defineBlobApiOperation, defineJsonApiOperation } from "./http-operation";
import {
  clientBrandingSchema,
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
  revertConfigAssetRequestSchema,
  safeConfigSchema,
  setDefaultConfigAgentRequestSchema,
  validateConfigAssetsResponseSchema
} from "./configuration";
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
  createAdministeredUserRequestSchema,
  createApiCredentialRequestSchema,
  createApiCredentialResponseSchema,
  createServicePrincipalRequestSchema,
  deleteCurrentUserResponseSchema,
  exchangeApiKeyResponseSchema,
  issueSessionTokenRequestSchema,
  issueSessionTokenResponseSchema,
  resetAdministeredUserPasswordRequestSchema,
  resetAdministeredUserPasswordResponseSchema,
  servicePrincipalDetailSchema,
  updateAdministeredUserRequestSchema,
  updateCurrentUserRequestSchema,
  updateServicePrincipalRequestSchema,
  upsertAdministeredUserIdentityRequestSchema
} from "./identity";
import { auditActivitySchema, auditEventSchema, usageSummarySchema } from "./governance";

export const apiOperations = {
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
  listConversations: defineJsonApiOperation({
    operationId: "listConversations",
    method: "GET",
    path: "/api/conversations",
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
    responseSchema: configAssetMutationVersionResponseSchema
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
