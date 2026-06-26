import { z } from "zod";
import { defineBlobApiOperation, defineJsonApiOperation } from "./http-operation";
import { createOpenApiDocumentFromOperations } from "./openapi";

export * from "./http-operation";
export * from "./openapi";

export const localeCodeSchema = z.enum(["en", "de"]);

export const localizationSchema = z.object({
  locale: localeCodeSchema,
  defaultLocale: localeCodeSchema,
  supportedLocales: z.array(localeCodeSchema)
});

export const apiUserSchema = z.object({
  id: z.string(),
  externalUserId: z.string(),
  displayLabel: z.string(),
  email: z.string().optional(),
  emailVerified: z.boolean().optional(),
  roles: z.array(z.string()),
  permissionRefs: z.array(z.string()),
  clientInstanceId: z.string(),
  authSource: z.string()
});

export const conversationSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  ownerUserId: z.string(),
  ownerExternalUserId: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  retainedUntil: z.string(),
  deletedAt: z.string().optional()
});

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  clientInstanceId: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  text: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const draftAttachmentStatusSchema = z.enum([
  "queued",
  "preprocessing",
  "ready",
  "failed",
  "unsupported",
  "deleted"
]);

export const draftAttachmentSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  fileId: z.string(),
  filename: z.string(),
  mimeType: z.string().optional(),
  byteSize: z.number(),
  status: draftAttachmentStatusSchema,
  format: z.string().optional(),
  artifactRefs: z.record(z.string(), z.string()),
  processingMetadata: z.record(z.string(), z.unknown()),
  warnings: z.array(
    z.object({
      code: z.string(),
      message: z.string()
    })
  ),
  error: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const draftAttachmentUploadResponseSchema = z.object({
  attachment: draftAttachmentSchema,
  attachments: z.array(draftAttachmentSchema)
});

export const retryDraftAttachmentResponseSchema = draftAttachmentUploadResponseSchema;

export type DraftAttachment = z.infer<typeof draftAttachmentSchema>;
export type DraftAttachmentUploadResponse = z.infer<typeof draftAttachmentUploadResponseSchema>;

export const clientBrandingSchema = z.object({
  localization: localizationSchema,
  clientName: z.string(),
  logoUrl: z.string().optional(),
  logoUrlDark: z.string().optional(),
  logoInvertOnDark: z.boolean(),
  faviconUrl: z.string().optional(),
  title: z.string(),
  welcomeMessage: z.string(),
  accentColor: z.string(),
  theme: z.object({
    accentColor: z.string(),
    accentStrongColor: z.string(),
    backgroundColor: z.string(),
    surfaceColor: z.string(),
    textColor: z.string(),
    mutedTextColor: z.string(),
    borderColor: z.string()
  }),
  darkTheme: z.object({
    accentColor: z.string(),
    accentStrongColor: z.string(),
    backgroundColor: z.string(),
    surfaceColor: z.string(),
    textColor: z.string(),
    mutedTextColor: z.string(),
    borderColor: z.string()
  }),
  defaultThemeMode: z.enum(["light", "dark", "system"])
});

export const safeConfigSchema = z.object({
  clientInstance: z.object({
    id: z.string(),
    displayName: z.string(),
    environment: z.string()
  }),
  localization: localizationSchema,
  retention: z.object({
    conversationDays: z.number(),
    auditDays: z.number(),
    allowUserDelete: z.boolean()
  }),
  usage: z.object({
    budget: z.object({
      monthlySpendLimit: z.number().optional(),
      costSafetyMultiplier: z.number()
    }),
    safeguards: z.object({
      modelCallsPerDay: z.number().optional(),
      tokensPerDay: z.number().optional(),
      tokensPerMonth: z.number().optional()
    })
  }),
  features: z.object({
    attachments: z.object({
      enabled: z.boolean(),
      accept: z.string()
    })
  }),
  defaultAgentName: z.string(),
  agents: z.array(
    z.object({
      name: z.string(),
      displayName: z.string(),
      welcomeMessage: z.string().optional(),
      initialPrompts: z.array(
        z.object({
          title: z.string(),
          prompt: z.string()
        })
      )
    })
  ),
  ui: clientBrandingSchema
});

export const createConversationRequestSchema = z.object({
  title: z.string().min(1).optional(),
  locale: localeCodeSchema.optional()
});

const uiMessagePartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional()
  })
  .passthrough();

const uiMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["system", "user", "assistant"]),
    parts: z.array(uiMessagePartSchema)
  })
  .passthrough();

export const chatStreamRequestSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
    locale: localeCodeSchema.optional(),
    messages: z.array(uiMessageSchema).min(1)
  })
  .passthrough();

export const chatStreamRoutePath = "/api/chat";

const chatStreamMessageMetadataSchema = z.record(z.string(), z.unknown());

export const agentRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_for_permission",
  "cancelling",
  "completed",
  "cancelled",
  "failed"
]);

export const agentRunErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  category: z.enum(["app_error", "internal_error", "abort_error", "unknown_error"])
});

export const chatStreamStartChunkSchema = z.object({
  type: z.literal("start"),
  messageId: z.string(),
  messageMetadata: chatStreamMessageMetadataSchema
});

export const chatStreamStartStepChunkSchema = z.object({
  type: z.literal("start-step")
});

export const chatStreamTextStartChunkSchema = z.object({
  type: z.literal("text-start"),
  id: z.string()
});

export const chatStreamTextDeltaChunkSchema = z.object({
  type: z.literal("text-delta"),
  id: z.string(),
  delta: z.string()
});

export const chatStreamMessageMetadataChunkSchema = z.object({
  type: z.literal("message-metadata"),
  messageMetadata: chatStreamMessageMetadataSchema
});

export const chatStreamTextEndChunkSchema = z.object({
  type: z.literal("text-end"),
  id: z.string()
});

export const chatStreamReasoningStartChunkSchema = z.object({
  type: z.literal("reasoning-start"),
  id: z.string()
});

export const chatStreamReasoningDeltaChunkSchema = z.object({
  type: z.literal("reasoning-delta"),
  id: z.string(),
  delta: z.string()
});

export const chatStreamReasoningEndChunkSchema = z.object({
  type: z.literal("reasoning-end"),
  id: z.string()
});

export const chatStreamToolInputAvailableChunkSchema = z.object({
  type: z.literal("tool-input-available"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  dynamic: z.boolean().optional(),
  title: z.string().optional()
});

export const chatStreamToolApprovalRequestChunkSchema = z.object({
  type: z.literal("tool-approval-request"),
  approvalId: z.string(),
  toolCallId: z.string()
});

export const chatStreamToolOutputAvailableChunkSchema = z.object({
  type: z.literal("tool-output-available"),
  toolCallId: z.string(),
  output: z.unknown(),
  dynamic: z.boolean().optional()
});

export const chatStreamToolOutputErrorChunkSchema = z.object({
  type: z.literal("tool-output-error"),
  toolCallId: z.string(),
  errorText: z.string(),
  dynamic: z.boolean().optional()
});

export const chatStreamFinishStepChunkSchema = z.object({
  type: z.literal("finish-step")
});

export const chatStreamFinishChunkSchema = z.object({
  type: z.literal("finish"),
  finishReason: z.string(),
  messageMetadata: chatStreamMessageMetadataSchema.optional()
});

export const chatStreamErrorChunkSchema = z.object({
  type: z.literal("error"),
  errorText: z.string()
});

export const chatStreamChunkSchema = z.discriminatedUnion("type", [
  chatStreamStartChunkSchema,
  chatStreamStartStepChunkSchema,
  chatStreamTextStartChunkSchema,
  chatStreamTextDeltaChunkSchema,
  chatStreamMessageMetadataChunkSchema,
  chatStreamTextEndChunkSchema,
  chatStreamReasoningStartChunkSchema,
  chatStreamReasoningDeltaChunkSchema,
  chatStreamReasoningEndChunkSchema,
  chatStreamToolInputAvailableChunkSchema,
  chatStreamToolApprovalRequestChunkSchema,
  chatStreamToolOutputAvailableChunkSchema,
  chatStreamToolOutputErrorChunkSchema,
  chatStreamFinishStepChunkSchema,
  chatStreamFinishChunkSchema,
  chatStreamErrorChunkSchema
]);

export const agentRuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_delta"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    delta: z.string()
  }),
  z.object({
    type: z.literal("reasoning_delta"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    id: z.string(),
    delta: z.string()
  }),
  z.object({
    type: z.literal("message_completed"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    message: z.object({
      id: z.string(),
      role: z.literal("assistant"),
      text: z.string(),
      metadata: z.record(z.string(), z.unknown()).optional()
    })
  }),
  z.object({
    type: z.literal("tool_call_started"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown()
  }),
  z.object({
    type: z.literal("tool_permission_requested"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    reason: z.string(),
    preview: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    type: z.literal("tool_call_completed"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.unknown(),
    modelOutput: z.string(),
    projectionNotice: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    type: z.literal("tool_call_failed"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.unknown(),
    modelOutput: z.string(),
    projectionNotice: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    type: z.literal("run_completed"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string()
  }),
  z.object({
    type: z.literal("run_cancelled"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    reason: z.string().optional()
  }),
  z.object({
    type: z.literal("run_failed"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      category: z.enum(["app_error", "internal_error", "abort_error", "unknown_error"])
    })
  })
]);

export const agentRunSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  conversationId: z.string(),
  ownerUserId: z.string(),
  inputMessageId: z.string(),
  agentName: z.string(),
  status: agentRunStatusSchema,
  idempotencyKey: z.string().optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  cancelledAt: z.string().optional(),
  failedAt: z.string().optional(),
  lastSequence: z.number().int().nonnegative(),
  error: agentRunErrorSchema.optional(),
  correlationId: z.string(),
  leaseOwner: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  heartbeatAt: z.string().optional()
});

export const activeRunSummarySchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  agentName: z.string(),
  status: z.enum(["queued", "running", "waiting_for_permission", "cancelling"]),
  startedAt: z.string(),
  updatedAt: z.string(),
  lastSequence: z.number().int().nonnegative()
});

export const runObservationSchema = z.object({
  clientInstanceId: z.string(),
  runId: z.string(),
  conversationId: z.string(),
  ownerUserId: z.string(),
  sequence: z.number().int().positive(),
  type: z.string(),
  payload: agentRuntimeEventSchema,
  createdAt: z.string()
});

export const cancelRunRequestSchema = z
  .object({
    reason: z.string().min(1).optional()
  })
  .optional()
  .default({});

export const cancelRunResponseSchema = z.object({
  run: agentRunSchema
});

export const chatStreamErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string()
  })
});

export const issueSessionTokenRequestSchema = z.object({
  externalUserId: z.string().min(1),
  displayLabel: z.string().min(1),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
  roles: z.array(z.string()).optional(),
  permissionRefs: z.array(z.string()).optional(),
  correlationId: z.string().optional()
});

export const issueSessionTokenResponseSchema = z.object({
  chatSessionToken: z.string(),
  expiresAt: z.string()
});

export const userStatusSchema = z.enum(["active", "disabled"]);

export const administeredUserIdentitySchema = z.object({
  clientInstanceId: z.string(),
  userId: z.string(),
  authSource: z.string(),
  externalUserId: z.string(),
  displayLabel: z.string().optional(),
  email: z.string().optional(),
  emailVerified: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastAuthenticatedAt: z.string().optional()
});

export const administeredUserSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  displayLabel: z.string(),
  email: z.string().optional(),
  roles: z.array(z.string()),
  permissionRefs: z.array(z.string()),
  status: userStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastAuthenticatedAt: z.string().optional(),
  identities: z.array(administeredUserIdentitySchema)
});

export const createAdministeredUserRequestSchema = z.object({
  displayLabel: z.string().min(1),
  email: z.string().email().optional(),
  roles: z.array(z.string()).optional(),
  permissionRefs: z.array(z.string()).optional(),
  status: userStatusSchema.optional()
});

export const updateAdministeredUserRequestSchema = z.object({
  displayLabel: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  roles: z.array(z.string()).optional(),
  permissionRefs: z.array(z.string()).optional(),
  status: userStatusSchema.optional()
});

export const updateCurrentUserRequestSchema = z.object({
  displayLabel: z.string().min(1)
});

export const changeCurrentUserPasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

export const changeCurrentUserPasswordResponseSchema = z.object({
  ok: z.literal(true)
});

export const upsertAdministeredUserIdentityRequestSchema = z.object({
  authSource: z.string().min(1),
  externalUserId: z.string().min(1),
  displayLabel: z.string().min(1).optional(),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional()
});

export const resetAdministeredUserPasswordRequestSchema = z.object({
  password: z.string().min(8)
});

export const resetAdministeredUserPasswordResponseSchema = z.object({
  ok: z.literal(true)
});

export const auditActorSchema = z.object({
  userId: z.string(),
  externalUserId: z.string(),
  displayLabel: z.string(),
  roles: z.array(z.string())
});

export const auditEventSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  type: z.string(),
  status: z.string(),
  actor: auditActorSchema.optional(),
  subject: z.string().optional(),
  reason: z.string().optional(),
  correlationId: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const modelUsageCostSchema = z.object({
  currency: z.string(),
  inputCostMicros: z.number().int().nonnegative(),
  outputCostMicros: z.number().int().nonnegative(),
  totalCostMicros: z.number().int().nonnegative(),
  budgetedCostMicros: z.number().int().nonnegative(),
  costSafetyMultiplier: z.number(),
  pricingConfigured: z.boolean()
});

export const modelUsageCostSummarySchema = modelUsageCostSchema.extend({
  pricedModelCallCount: z.number().int().nonnegative(),
  unpricedModelCallCount: z.number().int().nonnegative()
});

export const modelUsageEventSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  conversationId: z.string(),
  agentRunId: z.string(),
  agentName: z.string(),
  providerId: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  source: z.enum(["provider_reported", "not_reported", "estimated"]),
  cost: modelUsageCostSchema,
  correlationId: z.string(),
  createdAt: z.string()
});

export const modelUsageWindowSummarySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  modelCallCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  cost: modelUsageCostSummarySchema
});

export const usagePricingSchema = z.object({
  currency: z.string(),
  models: z.array(
    z.object({
      providerId: z.string(),
      model: z.string(),
      inputPricePerMillionTokens: z.number(),
      outputPricePerMillionTokens: z.number()
    })
  )
});

export const usageSummarySchema = z.object({
  generatedAt: z.string(),
  budget: safeConfigSchema.shape.usage.shape.budget,
  safeguards: safeConfigSchema.shape.usage.shape.safeguards,
  pricing: usagePricingSchema,
  today: modelUsageWindowSummarySchema,
  currentMonth: modelUsageWindowSummarySchema,
  allTime: modelUsageWindowSummarySchema,
  recentEvents: z.array(modelUsageEventSchema)
});

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
    responseSchema: z.array(conversationSchema)
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
  listConversationMessages: defineJsonApiOperation({
    operationId: "listConversationMessages",
    method: "GET",
    path: "/api/conversations/:conversationId/messages",
    responseSchema: z.array(messageSchema)
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
    path: "/api/conversations/:conversationId/files/:fileId/content"
  }),
  listAuditEvents: defineJsonApiOperation({
    operationId: "listAuditEvents",
    method: "GET",
    path: "/api/audit-events",
    responseSchema: z.array(auditEventSchema)
  }),
  getUsageSummary: defineJsonApiOperation({
    operationId: "getUsageSummary",
    method: "GET",
    path: "/api/superadmin/usage",
    responseSchema: usageSummarySchema
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
  deleteAdministeredUserIdentity: defineJsonApiOperation({
    operationId: "deleteAdministeredUserIdentity",
    method: "DELETE",
    path: "/api/superadmin/users/:userId/identities/:authSource/:externalUserId",
    responseSchema: administeredUserSchema
  }),
  issueSessionToken: defineJsonApiOperation({
    operationId: "issueSessionToken",
    method: "POST",
    path: "/auth/session-token",
    requestSchema: issueSessionTokenRequestSchema,
    responseSchema: issueSessionTokenResponseSchema
  })
} as const;

export function createOpenApiDocument() {
  return createOpenApiDocumentFromOperations(apiOperations);
}

export const openApiDocument = createOpenApiDocument();

export type ApiUser = z.infer<typeof apiUserSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export type ClientBranding = z.infer<typeof clientBrandingSchema>;
export type SafeConfig = z.infer<typeof safeConfigSchema>;
export type LocaleCode = z.infer<typeof localeCodeSchema>;
export type AdministeredUser = z.infer<typeof administeredUserSchema>;
export type AdministeredUserIdentity = z.infer<typeof administeredUserIdentitySchema>;
export type CreateAdministeredUserRequest = z.infer<typeof createAdministeredUserRequestSchema>;
export type UpdateAdministeredUserRequest = z.infer<typeof updateAdministeredUserRequestSchema>;
export type UpdateCurrentUserRequest = z.infer<typeof updateCurrentUserRequestSchema>;
export type ChangeCurrentUserPasswordRequest = z.infer<
  typeof changeCurrentUserPasswordRequestSchema
>;
export type UpsertAdministeredUserIdentityRequest = z.infer<
  typeof upsertAdministeredUserIdentityRequestSchema
>;
export type ResetAdministeredUserPasswordRequest = z.infer<
  typeof resetAdministeredUserPasswordRequestSchema
>;
export type ChatStreamRequest = z.infer<typeof chatStreamRequestSchema>;
export type ChatStreamChunk = z.infer<typeof chatStreamChunkSchema>;
export type AgentRuntimeEvent = z.infer<typeof agentRuntimeEventSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type ActiveRunSummary = z.infer<typeof activeRunSummarySchema>;
export type RunObservation = z.infer<typeof runObservationSchema>;
export type CancelRunRequest = z.infer<typeof cancelRunRequestSchema>;
export type CancelRunResponse = z.infer<typeof cancelRunResponseSchema>;
export type AuditActor = z.infer<typeof auditActorSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type ModelUsageEvent = z.infer<typeof modelUsageEventSchema>;
export type ModelUsageCost = z.infer<typeof modelUsageCostSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export type ApiOperationName = keyof typeof apiOperations;
