import type { AppErrorCode, OperationEffect } from "@work-shape/catalyst-asset-schemas";
import type {
  AccessSource,
  AgentAvailabilityMode,
  AgentRunFailureCategory,
  AgentRunStatus,
  ApprovalRequestStatus,
  ArtifactPreviewImageFormat,
  ArtifactPreviewPageImageMimeType,
  ArtifactPreviewStatus,
  AssetLifecycle,
  AssetRepresentation,
  AuditActivityActorKind,
  AuditActivityOutcome,
  AuditActivityTier,
  AuditEventStatus,
  AuthPrincipalKind,
  ChatMessageRole,
  CollaborationWorkspaceKind,
  ConnectionOperationEffect,
  ConnectionOperationPolicy,
  ConnectionOperationStatus,
  ConnectionOrigin,
  ConnectorTestStatus,
  ConversationAttachmentStatus,
  ConversationVisibility,
  DataStoreStatus,
  JobStatus,
  ModelProviderAuthModeConfig,
  ModelUsageEventStatus,
  ModelUsageSource,
  OpenAiCompatibleModelProviderApiConfig,
  OperationRunDecisionReason,
  PlatformEventOutcome,
  SecretState,
  ServicePrincipalStatus,
  SupportedImageMimeType,
  ToolDisplayMode,
  UsageCostRecordStatus,
  UserStatus,
  WebSourceProvider,
  WorkspaceCommandStatus,
  WorkspaceMembershipRole,
  WorkspaceVisibility
} from "@work-shape/catalyst-core";
import { expectTypeOf, it } from "vitest";

it("preserves the exported unions when contract lists become shared", () => {
  expectTypeOf<AppErrorCode>().toEqualTypeOf<
    | "BAD_REQUEST"
    | "UNAUTHENTICATED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "REVISION_CONFLICT"
    | "PRECONDITION_REQUIRED"
    | "TIMEOUT"
    | "VALIDATION_FAILED"
    | "RATE_LIMITED"
    | "POLICY_DENIED"
    | "GUARDRAIL_BLOCKED"
    | "DECLINED"
    | "IDEMPOTENCY_KEY_REUSED"
    | "OPERATION_IN_PROGRESS"
    | "OPERATION_EXPIRED"
    | "OUTPUT_NOT_RETAINED"
    | "INTERNAL"
  >();
  expectTypeOf<OperationEffect>().toEqualTypeOf<"reading" | "changing">();
  expectTypeOf<AgentRunStatus>().toEqualTypeOf<
    | "queued"
    | "running"
    | "waiting_for_permission"
    | "cancelling"
    | "completed"
    | "cancelled"
    | "failed"
  >();
  expectTypeOf<AgentRunFailureCategory>().toEqualTypeOf<
    "app_error" | "internal_error" | "runtime_interrupted" | "abort_error" | "unknown_error"
  >();
  expectTypeOf<ServicePrincipalStatus>().toEqualTypeOf<"active" | "disabled">();
  expectTypeOf<ApprovalRequestStatus>().toEqualTypeOf<
    | "pending"
    | "approved"
    | "rejected"
    | "changes_requested"
    | "superseded"
    | "withdrawn"
    | "reverted"
  >();
  expectTypeOf<ArtifactPreviewPageImageMimeType>().toEqualTypeOf<
    "image/png" | "image/jpeg" | "image/webp"
  >();
  expectTypeOf<AssetLifecycle>().toEqualTypeOf<"active" | "draft_published">();
  expectTypeOf<AssetRepresentation>().toEqualTypeOf<"config" | "files">();
  expectTypeOf<AuditActivityActorKind>().toEqualTypeOf<
    "user" | "assistant" | "service" | "system"
  >();
  expectTypeOf<AuditActivityTier>().toEqualTypeOf<
    "governance" | "workflow" | "runtime" | "telemetry"
  >();
  expectTypeOf<AuditActivityOutcome>().toEqualTypeOf<"success" | "failed" | "denied" | "warning">();
  expectTypeOf<AuditEventStatus>().toEqualTypeOf<"success" | "failed" | "denied">();
  expectTypeOf<CollaborationWorkspaceKind>().toEqualTypeOf<"personal" | "shared">();
  expectTypeOf<WorkspaceVisibility>().toEqualTypeOf<"discoverable" | "private">();
  expectTypeOf<WorkspaceMembershipRole>().toEqualTypeOf<"owner" | "admin" | "member">();
  expectTypeOf<AgentAvailabilityMode>().toEqualTypeOf<"all" | "selected">();
  expectTypeOf<ModelProviderAuthModeConfig>().toEqualTypeOf<"bearer" | "api-key">();
  expectTypeOf<OpenAiCompatibleModelProviderApiConfig>().toEqualTypeOf<
    "chat_completions" | "responses"
  >();
  expectTypeOf<ConnectionOperationStatus>().toEqualTypeOf<
    "ready" | "awaiting_discovery" | "needs_review" | "unknown" | "disabled"
  >();
  expectTypeOf<ConnectionOperationEffect>().toEqualTypeOf<"reading" | "changing">();
  expectTypeOf<ConnectionOperationPolicy>().toEqualTypeOf<"deny" | "approval">();
  expectTypeOf<ConnectionOrigin>().toEqualTypeOf<"release" | "runtime">();
  expectTypeOf<SecretState>().toEqualTypeOf<"set" | "not_set" | "unreadable">();
  expectTypeOf<ConnectorTestStatus>().toEqualTypeOf<
    "ready" | "unauthorized" | "network_denied" | "unavailable"
  >();
  expectTypeOf<ConversationVisibility>().toEqualTypeOf<"workspace" | "private">();
  expectTypeOf<ChatMessageRole>().toEqualTypeOf<"user" | "assistant" | "system" | "tool">();
  expectTypeOf<DataStoreStatus>().toEqualTypeOf<"provisioning" | "ready" | "retired">();
  expectTypeOf<PlatformEventOutcome>().toEqualTypeOf<
    "allow" | "warn" | "block" | "require_approval"
  >();
  expectTypeOf<WorkspaceCommandStatus>().toEqualTypeOf<
    "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled"
  >();
  expectTypeOf<SupportedImageMimeType>().toEqualTypeOf<
    "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  >();
  expectTypeOf<ArtifactPreviewImageFormat>().toEqualTypeOf<"png" | "jpeg" | "webp">();
  expectTypeOf<ArtifactPreviewStatus>().toEqualTypeOf<
    "pending" | "ready" | "failed" | "unsupported"
  >();
  expectTypeOf<ToolDisplayMode>().toEqualTypeOf<"inline" | "side_panel" | "fullscreen">();
  expectTypeOf<ConversationAttachmentStatus>().toEqualTypeOf<
    "queued" | "preprocessing" | "ready" | "failed" | "unsupported" | "deleted"
  >();
  expectTypeOf<AuthPrincipalKind>().toEqualTypeOf<"user" | "service">();
  expectTypeOf<JobStatus>().toEqualTypeOf<
    "queued" | "running" | "succeeded" | "failed" | "dead" | "cancelled"
  >();
  expectTypeOf<OperationRunDecisionReason>().toEqualTypeOf<
    "inherited_approval_not_applied" | "workflow_publish" | "approved_by_caller"
  >();
  expectTypeOf<AccessSource>().toEqualTypeOf<"role" | "legacy_ref" | "grant" | "membership">();
  expectTypeOf<ModelUsageSource>().toEqualTypeOf<
    "provider_reported" | "not_reported" | "estimated"
  >();
  expectTypeOf<UsageCostRecordStatus>().toEqualTypeOf<"settled" | "incomplete" | "unpriced">();
  expectTypeOf<ModelUsageEventStatus>().toEqualTypeOf<
    "pending" | "settled" | "failed" | "abandoned"
  >();
  expectTypeOf<UserStatus>().toEqualTypeOf<"active" | "disabled">();
  expectTypeOf<WebSourceProvider>().toEqualTypeOf<
    "openai-native" | "serper" | "tavily" | "firecrawl" | "browserbase" | "direct"
  >();
});
