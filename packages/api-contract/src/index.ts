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

export const authScopeSchema = z.enum([
  "*",
  "me:read",
  "me:delete",
  "config:read",
  "conversation:read",
  "conversation:write",
  "run:start",
  "run:observe",
  "run:cancel",
  "run:command",
  "me:write",
  "governance:read",
  "governance:write",
  "user_admin:read",
  "user_admin:write"
]);

export const chatSessionAuthScopeSchema = z.enum([
  "me:read",
  "me:delete",
  "config:read",
  "conversation:read",
  "conversation:write",
  "run:start",
  "run:observe",
  "run:cancel",
  "run:command"
]);

export const authPrincipalSchema = z.object({
  kind: z.enum(["user", "service"]),
  id: z.string(),
  displayLabel: z.string(),
  clientInstanceId: z.string(),
  authSource: z.string(),
  externalUserId: z.string().optional()
});

export const delegatedActorSchema = z.object({
  kind: z.literal("service_principal").default("service_principal"),
  id: z.string(),
  displayLabel: z.string().optional(),
  authSource: z.string()
});

export const apiUserSchema = z.object({
  id: z.string(),
  externalUserId: z.string(),
  displayLabel: z.string(),
  email: z.string().optional(),
  emailVerified: z.boolean().optional(),
  roles: z.array(z.string()),
  permissionRefs: z.array(z.string()),
  permissions: z.array(z.string()),
  clientInstanceId: z.string(),
  authSource: z.string(),
  principal: authPrincipalSchema.optional(),
  subjectUserId: z.string().optional(),
  delegatedActor: delegatedActorSchema.optional(),
  scopes: z.array(authScopeSchema).optional()
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

export const messageMetadataVersionSchema = z.literal(1);

export const storedReasoningSummarySchema = z.object({
  id: z.string(),
  text: z.string()
});

export const storedToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown()
});

export const webSourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().optional(),
  provider: z.enum(["openai-native", "serper", "tavily", "firecrawl", "browserbase", "direct"]),
  query: z.string().optional(),
  retrievedAt: z.string().optional(),
  snippet: z.string().optional(),
  contentHash: z.string().optional(),
  resultPosition: z.number().optional()
});

export const messageCitationSchema = z.object({
  sourceId: z.string(),
  label: z.string().optional(),
  quote: z.string().optional(),
  characterRange: z
    .object({
      start: z.number(),
      end: z.number()
    })
    .optional()
});

export const userMessageMetadataSchema = z.object({
  version: messageMetadataVersionSchema,
  kind: z.literal("user_message"),
  attachmentManifest: z.unknown()
});

export const assistantToolCallsMessageMetadataSchema = z.object({
  version: messageMetadataVersionSchema,
  kind: z.literal("assistant_tool_calls"),
  runId: z.string(),
  toolCalls: z.array(storedToolCallSchema),
  reasoning: z.array(storedReasoningSummarySchema).optional()
});

export const assistantFinalMessageMetadataSchema = z.object({
  version: messageMetadataVersionSchema,
  kind: z.literal("assistant_final"),
  runId: z.string(),
  finishStatus: z.enum(["completed", "cancelled"]),
  cancellationReason: z.string().optional(),
  reasoning: z.array(storedReasoningSummarySchema).optional(),
  sources: z.array(webSourceSchema).optional(),
  citations: z.array(messageCitationSchema).optional()
});

export const toolResultMessageMetadataSchema = z.object({
  version: messageMetadataVersionSchema,
  kind: z.literal("tool_result"),
  runId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  result: z.unknown(),
  modelOutput: z.string(),
  projectionNotice: z.record(z.string(), z.unknown()).optional()
});

export const agentRuntimeMessageMetadataSchema = z.discriminatedUnion("kind", [
  userMessageMetadataSchema,
  assistantToolCallsMessageMetadataSchema,
  assistantFinalMessageMetadataSchema,
  toolResultMessageMetadataSchema
]);

export const messageMetadataSchema = z
  .object({
    agentRuntime: z
      .union([agentRuntimeMessageMetadataSchema, z.record(z.string(), z.unknown())])
      .optional(),
    display: z.unknown().optional()
  })
  .catchall(z.unknown());

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  clientInstanceId: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  text: z.string(),
  createdAt: z.string(),
  metadata: messageMetadataSchema.optional()
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

export const artifactPreviewImagePageSchema = z.object({
  artifactId: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  filename: z.string().optional(),
  pageNumber: z.number().int().positive().optional(),
  slideNumber: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
});

export const artifactPreviewPendingResponseSchema = z.object({
  status: z.literal("pending"),
  artifactId: z.string(),
  queuedAt: z.string().optional()
});

export const artifactPreviewReadyResponseSchema = z.object({
  status: z.literal("ready"),
  artifactId: z.string(),
  type: z.literal("image_pages"),
  format: z.enum(["png", "webp", "jpeg"]),
  pages: z.array(artifactPreviewImagePageSchema)
});

export const artifactPreviewFailedResponseSchema = z.object({
  status: z.literal("failed"),
  artifactId: z.string(),
  errorCode: z.string().optional(),
  retryable: z.boolean().optional()
});

export const artifactPreviewUnsupportedResponseSchema = z.object({
  status: z.literal("unsupported"),
  artifactId: z.string(),
  errorCode: z.string().optional()
});

export const artifactPreviewResponseSchema = z.discriminatedUnion("status", [
  artifactPreviewPendingResponseSchema,
  artifactPreviewReadyResponseSchema,
  artifactPreviewFailedResponseSchema,
  artifactPreviewUnsupportedResponseSchema
]);

export type ArtifactPreviewResponse = z.infer<typeof artifactPreviewResponseSchema>;
export const retryArtifactPreviewResponseSchema = artifactPreviewResponseSchema;

const clientUiBrandingSchema = z.object({
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

export const clientBrandingSchema = clientUiBrandingSchema.extend({
  environment: z.string()
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
      welcomeSubtitle: z.string().optional(),
      initialPrompts: z.array(
        z.object({
          title: z.string(),
          prompt: z.string()
        })
      )
    })
  ),
  ui: clientUiBrandingSchema
});

export const createConversationRequestSchema = z.object({
  title: z.string().min(1).optional(),
  locale: localeCodeSchema.optional()
});

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
  category: z.enum([
    "app_error",
    "internal_error",
    "runtime_interrupted",
    "abort_error",
    "unknown_error"
  ])
});

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
      category: z.enum([
        "app_error",
        "internal_error",
        "runtime_interrupted",
        "abort_error",
        "unknown_error"
      ])
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
  status: agentRunStatusSchema,
  startedAt: z.string(),
  updatedAt: z.string(),
  lastSequence: z.number().int().nonnegative()
});

const agentRunProjectionToolCallStateSchema = z.enum([
  "input_available",
  "waiting_for_permission",
  "output_available",
  "output_error"
]);

export const agentRunProjectionPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string()
  }),
  z.object({
    type: z.literal("reasoning"),
    id: z.string(),
    text: z.string(),
    open: z.boolean()
  }),
  z.object({
    type: z.literal("tool_call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown().optional(),
    state: agentRunProjectionToolCallStateSchema,
    output: z.unknown().optional(),
    errorText: z.string().optional()
  })
]);

export const agentRunProjectionSchema = z.object({
  runId: z.string(),
  lastSequence: z.number().int().nonnegative(),
  status: agentRunStatusSchema,
  parts: z.array(agentRunProjectionPartSchema).default([]),
  text: z.string(),
  reasoning: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      open: z.boolean()
    })
  ),
  activeToolCalls: z.array(
    z.object({
      toolCallId: z.string(),
      toolName: z.string(),
      input: z.unknown().optional(),
      state: agentRunProjectionToolCallStateSchema,
      output: z.unknown().optional(),
      errorText: z.string().optional()
    })
  ),
  error: agentRunErrorSchema.optional()
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

export const startConversationRunRequestSchema = z.object({
  idempotencyKey: z.string().min(1),
  agentName: z.string().min(1).optional(),
  locale: localeCodeSchema.optional(),
  message: z.object({
    text: z.string().min(1)
  })
});

export const usageSafeguardsSchema = safeConfigSchema.shape.usage.shape.safeguards;

export const startConversationRunResponseSchema = z.object({
  conversation: conversationSchema,
  userMessage: messageSchema,
  run: agentRunSchema,
  thread: z.lazy(() => conversationThreadSnapshotSchema),
  eventsUrl: z.string()
});

export const createConversationRunRequestSchema = startConversationRunRequestSchema.extend({
  conversation: createConversationRequestSchema.optional()
});

export const runCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_permission_decision"),
    toolCallId: z.string().min(1),
    approved: z.boolean(),
    reason: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("continue")
  })
]);

export const runCommandRequestSchema = z.object({
  command: runCommandSchema
});

export const runCommandResponseSchema = z.object({
  run: agentRunSchema
});

export const conversationListItemSchema = conversationSchema.extend({
  latestMessageAt: z.string().optional(),
  activeRun: activeRunSummarySchema.optional(),
  unread: z.boolean().optional(),
  lastViewedAt: z.string().optional()
});

export const conversationUserStateSchema = z.object({
  clientInstanceId: z.string(),
  conversationId: z.string(),
  userId: z.string(),
  lastViewedAt: z.string().optional(),
  lastReadMessageId: z.string().optional(),
  lastReadRunId: z.string().optional(),
  lastReadRunSequence: z.number().int().nonnegative().optional(),
  updatedAt: z.string()
});

export const conversationThreadSnapshotSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(messageSchema),
  completedRunProjections: z.record(z.string(), agentRunProjectionSchema).optional(),
  activeRun: z
    .object({
      run: activeRunSummarySchema,
      projection: agentRunProjectionSchema
    })
    .optional(),
  userState: conversationUserStateSchema,
  serverTime: z.string()
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

export const issueSessionTokenRequestSchema = z.object({
  externalUserId: z.string().min(1),
  displayLabel: z.string().min(1),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
  roles: z.array(z.string()).optional(),
  permissionRefs: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  correlationId: z.string().optional(),
  scopes: z.array(chatSessionAuthScopeSchema).optional(),
  delegatedActor: delegatedActorSchema.optional()
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
  permissions: z.array(z.string()),
  status: userStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastAuthenticatedAt: z.string().optional(),
  identities: z.array(administeredUserIdentitySchema)
});

export const administeredUserPasswordSignInRequestSchema = z.object({
  password: z.string().min(8)
});

export const createAdministeredUserRequestSchema = z.object({
  displayLabel: z.string().min(1),
  email: z.string().email().optional(),
  roles: z.array(z.string()).optional(),
  permissionRefs: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  status: userStatusSchema.optional(),
  passwordSignIn: administeredUserPasswordSignInRequestSchema.optional()
});

export const updateAdministeredUserRequestSchema = z.object({
  displayLabel: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  roles: z.array(z.string()).optional(),
  permissionRefs: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
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

export const deleteCurrentUserResponseSchema = z.object({
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
  roles: z.array(z.string()),
  principalKind: z.enum(["user", "service"]).optional(),
  principalId: z.string().optional(),
  principalDisplayLabel: z.string().optional(),
  subjectUserId: z.string().optional(),
  delegatedActor: delegatedActorSchema.optional()
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

export const auditActivityActorSchema = z.object({
  kind: z.enum(["user", "assistant", "service", "system"]),
  label: z.string(),
  onBehalfOf: z.string().optional(),
  roles: z.array(z.string()).optional()
});

export const auditActivityTargetSchema = z.object({
  kind: z.string(),
  id: z.string(),
  label: z.string().optional()
});

export const auditActivitySchema = z.object({
  correlationId: z.string(),
  at: z.string(),
  label: z.string(),
  tier: z.enum(["governance", "workflow", "runtime", "telemetry"]),
  outcome: z.enum(["success", "failed", "denied", "warning"]),
  actor: auditActivityActorSchema,
  target: auditActivityTargetSchema.optional(),
  reason: z.string().optional(),
  eventCount: z.number().int().nonnegative(),
  repeatCount: z.number().int().nonnegative(),
  evidence: z.array(auditEventSchema)
});

export const modelUsageVolumeEventSchema = z.object({
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
  webSearchCallCount: z.number().int().nonnegative(),
  source: z.enum(["provider_reported", "not_reported", "estimated"]),
  correlationId: z.string(),
  createdAt: z.string()
});

export const modelUsageVolumeWindowSummarySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  modelCallCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  webSearchCallCount: z.number().int().nonnegative()
});

export const modelUsageBilledCostSchema = z.object({
  currency: z.string(),
  modelBilledCostMicros: z.number().int().nonnegative(),
  webSearchBilledCostMicros: z.number().int().nonnegative().optional(),
  billedCostMicros: z.number().int().nonnegative(),
  webSearchCostVisible: z.boolean(),
  pricingConfigured: z.boolean(),
  modelPricingConfigured: z.boolean(),
  webSearchPricingConfigured: z.boolean()
});

export const modelUsageBilledCostSummarySchema = modelUsageBilledCostSchema.extend({
  pricedModelCallCount: z.number().int().nonnegative(),
  unpricedModelCallCount: z.number().int().nonnegative(),
  pricedWebSearchCallCount: z.number().int().nonnegative(),
  unpricedWebSearchCallCount: z.number().int().nonnegative()
});

export const modelUsageEventSchema = modelUsageVolumeEventSchema.extend({
  cost: modelUsageBilledCostSchema
});

export const modelUsageWindowSummarySchema = modelUsageVolumeWindowSummarySchema.extend({
  cost: modelUsageBilledCostSummarySchema
});

export const modelUsageDailyBucketSchema = modelUsageWindowSummarySchema.extend({
  date: z.string()
});

export const modelUsageMonthlyBucketSchema = modelUsageWindowSummarySchema.extend({
  month: z.string()
});

export const usageSummarySchema = z.object({
  generatedAt: z.string(),
  safeguards: usageSafeguardsSchema,
  today: modelUsageWindowSummarySchema,
  currentMonth: modelUsageWindowSummarySchema,
  allTime: modelUsageWindowSummarySchema,
  dailyUsage: z.array(modelUsageDailyBucketSchema),
  monthlyUsage: z.array(modelUsageMonthlyBucketSchema),
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
    path: "/api/conversations/:conversationId/files/:fileId/content"
  }),
  getConversationArtifactContent: defineBlobApiOperation({
    operationId: "getConversationArtifactContent",
    method: "GET",
    path: "/api/conversations/:conversationId/artifacts/:artifactId/content"
  }),
  getConversationArtifactPreview: defineJsonApiOperation({
    operationId: "getConversationArtifactPreview",
    method: "GET",
    path: "/api/conversations/:conversationId/artifacts/:artifactId/preview",
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
export type AuthScope = z.infer<typeof authScopeSchema>;
export type ChatSessionAuthScope = z.infer<typeof chatSessionAuthScopeSchema>;
export type AuthPrincipal = z.infer<typeof authPrincipalSchema>;
export type DelegatedActor = z.infer<typeof delegatedActorSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessageMetadata = z.infer<typeof messageMetadataSchema>;
export type AgentRuntimeMessageMetadata = z.infer<typeof agentRuntimeMessageMetadataSchema>;
export type UserMessageMetadata = z.infer<typeof userMessageMetadataSchema>;
export type AssistantToolCallsMessageMetadata = z.infer<typeof assistantToolCallsMessageMetadataSchema>;
export type AssistantFinalMessageMetadata = z.infer<typeof assistantFinalMessageMetadataSchema>;
export type ToolResultMessageMetadata = z.infer<typeof toolResultMessageMetadataSchema>;
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
export type AgentRuntimeEvent = z.infer<typeof agentRuntimeEventSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
export type ActiveRunSummary = z.infer<typeof activeRunSummarySchema>;
export type AgentRunProjection = z.infer<typeof agentRunProjectionSchema>;
export type RunObservation = z.infer<typeof runObservationSchema>;
export type StartConversationRunRequest = z.infer<typeof startConversationRunRequestSchema>;
export type StartConversationRunResponse = z.infer<typeof startConversationRunResponseSchema>;
export type CreateConversationRunRequest = z.infer<typeof createConversationRunRequestSchema>;
export type RunCommand = z.infer<typeof runCommandSchema>;
export type RunCommandRequest = z.infer<typeof runCommandRequestSchema>;
export type RunCommandResponse = z.infer<typeof runCommandResponseSchema>;
export type ConversationUserState = z.infer<typeof conversationUserStateSchema>;
export type ConversationThreadSnapshot = z.infer<typeof conversationThreadSnapshotSchema>;
export type CancelRunRequest = z.infer<typeof cancelRunRequestSchema>;
export type CancelRunResponse = z.infer<typeof cancelRunResponseSchema>;
export type AuditActor = z.infer<typeof auditActorSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditActivity = z.infer<typeof auditActivitySchema>;
export type AuditActivityActor = z.infer<typeof auditActivityActorSchema>;
export type AuditActivityTarget = z.infer<typeof auditActivityTargetSchema>;
export type ModelUsageVolumeEvent = z.infer<typeof modelUsageVolumeEventSchema>;
export type ModelUsageBilledCost = z.infer<typeof modelUsageBilledCostSchema>;
export type ModelUsageBilledCostSummary = z.infer<typeof modelUsageBilledCostSummarySchema>;
export type ModelUsageEvent = z.infer<typeof modelUsageEventSchema>;
export type ModelUsageDailyBucket = z.infer<typeof modelUsageDailyBucketSchema>;
export type ModelUsageMonthlyBucket = z.infer<typeof modelUsageMonthlyBucketSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export type ApiOperationName = keyof typeof apiOperations;
