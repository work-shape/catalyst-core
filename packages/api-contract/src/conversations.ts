import { z } from "zod";
import { localeCodeSchema } from "./configuration";

export const conversationVisibilitySchema = z.enum(["workspace", "private"]);

export const conversationSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  collaborationWorkspaceId: z.string(),
  createdByUserId: z.string(),
  createdByExternalUserId: z.string(),
  visibility: conversationVisibilitySchema,
  title: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  retainedUntil: z.string(),
  deletedAt: z.string().optional()
});

export const moveConversationRequestSchema = z.object({
  collaborationWorkspaceId: z.string().min(1),
  visibility: conversationVisibilitySchema.optional()
});

export const messageMetadataVersionSchema = z.literal(1);

export const storedReasoningSummarySchema = z.object({
  id: z.string(),
  text: z.string()
});

export const storedModelContextSnapshotSchema = z.object({
  inputTokens: z.number(),
  compactThresholdTokens: z.number(),
  compacted: z.boolean()
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
  reasoning: z.array(storedReasoningSummarySchema).optional(),
  modelContext: storedModelContextSnapshotSchema.optional()
});

export const assistantFinalMessageMetadataSchema = z.object({
  version: messageMetadataVersionSchema,
  kind: z.literal("assistant_final"),
  runId: z.string(),
  finishStatus: z.enum(["completed", "cancelled"]),
  cancellationReason: z.string().optional(),
  reasoning: z.array(storedReasoningSummarySchema).optional(),
  sources: z.array(webSourceSchema).optional(),
  citations: z.array(messageCitationSchema).optional(),
  modelContext: storedModelContextSnapshotSchema.optional()
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

export const approvalDecisionMessageMetadataSchema = z.object({
  version: messageMetadataVersionSchema,
  kind: z.literal("approval_decision"),
  requestId: z.string(),
  requestKind: z.string(),
  status: z.enum([
    "approved",
    "rejected",
    "changes_requested",
    "superseded",
    "withdrawn",
    "reverted"
  ]),
  decidedBy: z.string(),
  decidedByLabel: z.string(),
  decidedAt: z.string(),
  summary: z.string(),
  comment: z.string().optional(),
  requestedBy: z.string().optional()
});

export const agentRuntimeMessageMetadataSchema = z.discriminatedUnion("kind", [
  approvalDecisionMessageMetadataSchema,
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
  attachments: z.array(draftAttachmentSchema),
  outcome: z.enum(["created", "already_available"]).optional()
});

export const retryDraftAttachmentResponseSchema = draftAttachmentUploadResponseSchema;

export type DraftAttachment = z.infer<typeof draftAttachmentSchema>;
export type DraftAttachmentUploadResponse = z.infer<typeof draftAttachmentUploadResponseSchema>;

export const conversationResourceBaseSchema = z.object({
  resourceId: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const conversationResourceListItemSchema = z.discriminatedUnion("resourceType", [
  conversationResourceBaseSchema.extend({
    resourceType: z.literal("source_file"),
    attachmentId: z.string(),
    mimeType: z.string().optional(),
    preview: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("source_file"), fileId: z.string() }),
      z.object({
        kind: z.literal("artifact"),
        artifactId: z.string(),
        mimeType: z.string().optional()
      })
    ]),
    download: z.object({
      kind: z.literal("source_file"),
      fileId: z.string(),
      filename: z.string()
    })
  }),
  conversationResourceBaseSchema.extend({
    resourceType: z.literal("generated_file"),
    preview: z.object({ kind: z.literal("artifact"), artifactId: z.string() }),
    download: z.object({
      kind: z.literal("artifact"),
      artifactId: z.string(),
      filename: z.string()
    })
  }),
  conversationResourceBaseSchema.extend({
    resourceType: z.literal("analysis"),
    preview: z.object({
      kind: z.literal("typed_display"),
      display: z.record(z.string(), z.unknown())
    })
  }),
  conversationResourceBaseSchema.extend({
    resourceType: z.literal("structured_result"),
    key: z.string(),
    kind: z.string(),
    schemaVersion: z.number().int().positive(),
    revision: z.number().int().positive(),
    preview: z.object({
      kind: z.literal("typed_display"),
      display: z.record(z.string(), z.unknown())
    })
  }),
  conversationResourceBaseSchema.extend({
    resourceType: z.literal("structured_data"),
    preview: z.object({
      kind: z.literal("structured_data"),
      structuredDataResourceId: z.string()
    })
  })
]);

export const conversationResourceListResponseSchema = z.object({
  resources: z.array(conversationResourceListItemSchema)
});

const structuredDataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const structuredDataResourceResponseSchema = z.object({
  id: z.string(),
  resourceKey: z.string(),
  title: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sections: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      fields: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          value: structuredDataValueSchema,
          attention: z
            .object({
              reason: z.enum(["uncertain", "conflicting"]),
              message: z.string().optional()
            })
            .optional(),
          sources: z
            .array(
              z.object({
                attachmentId: z.string(),
                page: z.number().int().positive().optional(),
                filename: z.string()
              })
            )
            .optional()
        })
      )
    })
  )
});

export type StructuredDataResourceResponse = z.infer<typeof structuredDataResourceResponseSchema>;

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
  pageCount: z.number().int().positive().optional(),
  truncated: z.boolean().optional(),
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

export const createConversationRequestSchema = z.object({
  title: z.string().min(1).optional(),
  collaborationWorkspaceId: z.string().min(1).optional(),
  locale: localeCodeSchema.optional()
});

export const renameConversationRequestSchema = z.object({
  title: z.string().trim().min(1).max(120)
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
    type: z.literal("tool_call_preparing"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    toolCallId: z.string(),
    toolName: z.string()
  }),
  z.object({
    type: z.literal("tool_call_preparation_cancelled"),
    runId: z.string(),
    sequence: z.number(),
    createdAt: z.string(),
    toolCallId: z.string()
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
  durationMs: z.number().int().nonnegative().optional(),
  parts: z.array(agentRunProjectionPartSchema).default([]),
  text: z.string(),
  reasoning: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      open: z.boolean()
    })
  ),
  preparingTool: z
    .object({
      toolCallId: z.string(),
      toolName: z.string()
    })
    .optional(),
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
  modelBindingId: z.string().min(1).optional(),
  locale: localeCodeSchema.optional(),
  message: z.object({
    text: z.string().min(1)
  })
});

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

export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationVisibility = z.infer<typeof conversationVisibilitySchema>;
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;
export type RenameConversationRequest = z.infer<typeof renameConversationRequestSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessageMetadata = z.infer<typeof messageMetadataSchema>;
export type ConversationResourceBase = z.infer<typeof conversationResourceBaseSchema>;
export type ConversationResourceListItem = z.infer<typeof conversationResourceListItemSchema>;
export type ConversationResourceListResponse = z.infer<
  typeof conversationResourceListResponseSchema
>;
export type AgentRuntimeMessageMetadata = z.infer<typeof agentRuntimeMessageMetadataSchema>;
export type UserMessageMetadata = z.infer<typeof userMessageMetadataSchema>;
export type AssistantToolCallsMessageMetadata = z.infer<
  typeof assistantToolCallsMessageMetadataSchema
>;
export type AssistantFinalMessageMetadata = z.infer<typeof assistantFinalMessageMetadataSchema>;
export type ToolResultMessageMetadata = z.infer<typeof toolResultMessageMetadataSchema>;
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
