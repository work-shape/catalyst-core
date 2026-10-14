import type { GuardrailAnswer, GuardrailFields } from "./guardrails";
import type { JsonObject } from "./json";
import type { OperationCall } from "./operations";

export type PlatformEventPhase = "before" | "after";

export interface PlatformEventDefinition {
  name: string;
  /** The kind of subject whose id is supplied when emitting. */
  subject: string;
  /** A reference-only JSON Schema. EW-1 supplies schemas for legacy metadata. */
  payload?: JsonObject;
  legacy: boolean;
  audited: boolean;
  phases: readonly PlatformEventPhase[];
}

const LEGACY_AUDIT = { legacy: true, audited: true, phases: ["after"] } as const;
const OPERATION_AUDIT = {
  subject: "operation",
  legacy: false,
  audited: true,
  phases: ["after"]
} as const;

const LIVE_ONCE_AUDIT = {
  subject: "config_asset",
  legacy: false,
  audited: true,
  phases: ["after"]
} as const;

// Run observations remain a separate stream from platform events and audit.
export const EVENTS = {
  "agent_run.recovered": { ...LEGACY_AUDIT, name: "agent_run.recovered", subject: "agent_run" },
  "api_access.credential_created": {
    ...LEGACY_AUDIT,
    name: "api_access.credential_created",
    subject: "api_access"
  },
  "api_access.credential_revoked": {
    ...LEGACY_AUDIT,
    name: "api_access.credential_revoked",
    subject: "api_access"
  },
  "api_access.service_principal_created": {
    ...LEGACY_AUDIT,
    name: "api_access.service_principal_created",
    subject: "api_access"
  },
  "api_access.service_principal_updated": {
    ...LEGACY_AUDIT,
    name: "api_access.service_principal_updated",
    subject: "api_access"
  },
  "api_access.service_principals_viewed": {
    ...LEGACY_AUDIT,
    name: "api_access.service_principals_viewed",
    subject: "api_access"
  },
  // Guardrails answer here before an App's revision goes live. The subject is the App.
  "app.before_publish": {
    name: "app.before_publish",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  "app.created": { ...LEGACY_AUDIT, name: "app.created", subject: "config_asset" },
  "app.published": { ...LEGACY_AUDIT, name: "app.published", subject: "config_asset" },
  // Guardrails bound to it answer before a request is filed. The subject is the request's kind.
  "approval_request.before_create": {
    name: "approval_request.before_create",
    subject: "approval_request",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  "approval_request.created": {
    ...LEGACY_AUDIT,
    name: "approval_request.created",
    subject: "approval_request"
  },
  "approval_request.decided": {
    ...LEGACY_AUDIT,
    name: "approval_request.decided",
    subject: "approval_request"
  },
  "approval_request.reverted": {
    ...LEGACY_AUDIT,
    name: "approval_request.reverted",
    subject: "approval_request"
  },
  "approval_request.withdrawn": {
    ...LEGACY_AUDIT,
    name: "approval_request.withdrawn",
    subject: "approval_request"
  },
  // Guardrails answer here before a revision of any asset kind is written. The subject is the
  // asset; its kind narrows the guardrails that apply.
  "asset.before_write": {
    name: "asset.before_write",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  "audit.pruned": { ...LEGACY_AUDIT, name: "audit.pruned", subject: "audit" },
  "auth.service_access_token_issued": {
    ...LEGACY_AUDIT,
    name: "auth.service_access_token_issued",
    subject: "auth"
  },
  "auth.session_token_issued": {
    ...LEGACY_AUDIT,
    name: "auth.session_token_issued",
    subject: "auth"
  },
  "collaboration_workspace.access_request_approved": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.access_request_approved",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.access_request_declined": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.access_request_declined",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.access_requested": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.access_requested",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.created": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.created",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.deleted": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.deleted",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.deletion_requested": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.deletion_requested",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.deletion_stalled": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.deletion_stalled",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.member_added": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.member_added",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.member_left": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.member_left",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.member_removed": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.member_removed",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.member_role_changed": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.member_role_changed",
    subject: "collaboration_workspace"
  },
  "collaboration_workspace.updated": {
    ...LEGACY_AUDIT,
    name: "collaboration_workspace.updated",
    subject: "collaboration_workspace"
  },
  "config_asset.availability_set": {
    ...LEGACY_AUDIT,
    name: "config_asset.availability_set",
    subject: "config_asset"
  },
  "config_asset.default_agent_set": {
    ...LEGACY_AUDIT,
    name: "config_asset.default_agent_set",
    subject: "config_asset"
  },
  "config_asset.deleted": {
    ...LEGACY_AUDIT,
    name: "config_asset.deleted",
    subject: "config_asset"
  },
  "config_asset.draft_discarded": {
    ...LEGACY_AUDIT,
    name: "config_asset.draft_discarded",
    subject: "config_asset"
  },
  "config_asset.published": {
    ...LEGACY_AUDIT,
    name: "config_asset.published",
    subject: "config_asset"
  },
  "config_asset.reverted": {
    ...LEGACY_AUDIT,
    name: "config_asset.reverted",
    subject: "config_asset"
  },
  "config_asset.updated": {
    ...LEGACY_AUDIT,
    name: "config_asset.updated",
    subject: "config_asset"
  },
  "connection.discovered": {
    ...LEGACY_AUDIT,
    name: "connection.discovered",
    subject: "connection"
  },
  "connection.discovery_failed": {
    ...LEGACY_AUDIT,
    name: "connection.discovery_failed",
    subject: "connection"
  },
  "conversation.cleanup_completed": {
    ...LEGACY_AUDIT,
    name: "conversation.cleanup_completed",
    subject: "conversation"
  },
  "conversation.cleanup_failed": {
    ...LEGACY_AUDIT,
    name: "conversation.cleanup_failed",
    subject: "conversation"
  },
  "conversation.created": {
    ...LEGACY_AUDIT,
    name: "conversation.created",
    subject: "conversation"
  },
  "conversation.deleted": {
    ...LEGACY_AUDIT,
    name: "conversation.deleted",
    subject: "conversation"
  },
  "conversation.moved": { ...LEGACY_AUDIT, name: "conversation.moved", subject: "conversation" },
  "conversation.renamed": {
    ...LEGACY_AUDIT,
    name: "conversation.renamed",
    subject: "conversation"
  },
  "conversation.retention_expiration_failed": {
    ...LEGACY_AUDIT,
    name: "conversation.retention_expiration_failed",
    subject: "conversation"
  },
  "conversation.retention_expired": {
    ...LEGACY_AUDIT,
    name: "conversation.retention_expired",
    subject: "conversation"
  },
  "conversation.title_generated": {
    ...LEGACY_AUDIT,
    name: "conversation.title_generated",
    subject: "conversation"
  },
  "conversation.title_generation_failed": {
    ...LEGACY_AUDIT,
    name: "conversation.title_generation_failed",
    subject: "conversation"
  },
  // Guardrails answer here before a Data Store's revision goes live, which applies its
  // migrations. The subject is the store.
  "data_store.before_publish": {
    name: "data_store.before_publish",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  "data_store.migrated": {
    ...LEGACY_AUDIT,
    name: "data_store.migrated",
    subject: "data_store"
  },
  "data_store.migration_failed": {
    ...LEGACY_AUDIT,
    name: "data_store.migration_failed",
    subject: "data_store"
  },
  "data_store.provisioned": {
    ...LEGACY_AUDIT,
    name: "data_store.provisioned",
    subject: "data_store"
  },
  "data_store.provisioning_failed": {
    ...LEGACY_AUDIT,
    name: "data_store.provisioning_failed",
    subject: "data_store"
  },
  "execution_workspace.cleaned_up": {
    ...LEGACY_AUDIT,
    name: "execution_workspace.cleaned_up",
    subject: "execution_workspace"
  },
  "execution_workspace.cleanup_failed": {
    ...LEGACY_AUDIT,
    name: "execution_workspace.cleanup_failed",
    subject: "execution_workspace"
  },
  "governance.audit_events_viewed": {
    ...LEGACY_AUDIT,
    name: "governance.audit_events_viewed",
    subject: "instance"
  },
  "governance.config_assets_viewed": {
    ...LEGACY_AUDIT,
    name: "governance.config_assets_viewed",
    subject: "instance"
  },
  "governance.config_assets_write_authorized": {
    ...LEGACY_AUDIT,
    name: "governance.config_assets_write_authorized",
    subject: "instance"
  },
  "governance.usage_viewed": {
    ...LEGACY_AUDIT,
    name: "governance.usage_viewed",
    subject: "instance"
  },
  "governance.users_viewed": {
    ...LEGACY_AUDIT,
    name: "governance.users_viewed",
    subject: "instance"
  },
  "job.retried": { ...LEGACY_AUDIT, name: "job.retried", subject: "job" },
  // "Run live once" on an action or a step of a draft (ADR-0031). The subject is the App or
  // the Workflow; the metadata names its draft revision, the action or step and who set it.
  "live_once.cleared": { ...LIVE_ONCE_AUDIT, name: "live_once.cleared" },
  "live_once.switched_on": { ...LIVE_ONCE_AUDIT, name: "live_once.switched_on" },
  "live_once.used": { ...LIVE_ONCE_AUDIT, name: "live_once.used" },
  "message.cancelled": { ...LEGACY_AUDIT, name: "message.cancelled", subject: "message" },
  "message.completed": { ...LEGACY_AUDIT, name: "message.completed", subject: "message" },
  "message.created": { ...LEGACY_AUDIT, name: "message.created", subject: "message" },
  "message.failed": { ...LEGACY_AUDIT, name: "message.failed", subject: "message" },
  "namespace.created": { ...LEGACY_AUDIT, name: "namespace.created", subject: "namespace" },
  "namespace.deleted": { ...LEGACY_AUDIT, name: "namespace.deleted", subject: "namespace" },
  "namespace.updated": { ...LEGACY_AUDIT, name: "namespace.updated", subject: "namespace" },
  "operation.authorization_checked": {
    ...OPERATION_AUDIT,
    name: "operation.authorization_checked"
  },
  // Guardrails answer here before anything runs.
  "operation.before_call": {
    name: "operation.before_call",
    subject: "operation",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  "operation.completed": { ...OPERATION_AUDIT, name: "operation.completed" },
  "operation.denied": { ...OPERATION_AUDIT, name: "operation.denied" },
  "operation.failed": { ...OPERATION_AUDIT, name: "operation.failed" },
  // A changing call of a draft that was not made and answered what it would have done.
  "operation.simulated": { ...OPERATION_AUDIT, name: "operation.simulated" },
  "operation.started": { ...OPERATION_AUDIT, name: "operation.started" },
  "permission.granted": {
    ...LEGACY_AUDIT,
    name: "permission.granted",
    subject: "permission_grant"
  },
  "permission.revoked": {
    ...LEGACY_AUDIT,
    name: "permission.revoked",
    subject: "permission_grant"
  },
  "storage.orphaned_file_cleanup_failed": {
    ...LEGACY_AUDIT,
    name: "storage.orphaned_file_cleanup_failed",
    subject: "storage"
  },
  "storage.orphaned_files_deleted": {
    ...LEGACY_AUDIT,
    name: "storage.orphaned_files_deleted",
    subject: "storage"
  },
  "user.created": { ...LEGACY_AUDIT, name: "user.created", subject: "user" },
  "user.deleted": { ...LEGACY_AUDIT, name: "user.deleted", subject: "user" },
  "user.deletion_requested": {
    ...LEGACY_AUDIT,
    name: "user.deletion_requested",
    subject: "user"
  },
  "user.deletion_stalled": { ...LEGACY_AUDIT, name: "user.deletion_stalled", subject: "user" },
  "user.identity_deleted": { ...LEGACY_AUDIT, name: "user.identity_deleted", subject: "user" },
  "user.identity_linked": { ...LEGACY_AUDIT, name: "user.identity_linked", subject: "user" },
  "user.identity_upserted": { ...LEGACY_AUDIT, name: "user.identity_upserted", subject: "user" },
  "user.invitation_sent": { ...LEGACY_AUDIT, name: "user.invitation_sent", subject: "user" },
  "user.password_changed": { ...LEGACY_AUDIT, name: "user.password_changed", subject: "user" },
  "user.password_reset": { ...LEGACY_AUDIT, name: "user.password_reset", subject: "user" },
  "user.password_reset_requested": {
    ...LEGACY_AUDIT,
    name: "user.password_reset_requested",
    subject: "user"
  },
  "user.password_sign_in_created": {
    ...LEGACY_AUDIT,
    name: "user.password_sign_in_created",
    subject: "user"
  },
  "user.profile_updated": { ...LEGACY_AUDIT, name: "user.profile_updated", subject: "user" },
  "user.updated": { ...LEGACY_AUDIT, name: "user.updated", subject: "user" },
  // Guardrails answer here before a Workflow's revision goes live. The subject is the Workflow.
  "workflow.before_publish": {
    name: "workflow.before_publish",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  "workflow_run.cancelled": {
    ...LEGACY_AUDIT,
    name: "workflow_run.cancelled",
    subject: "workflow_run"
  },
  "workflow_run.ended": { ...LEGACY_AUDIT, name: "workflow_run.ended", subject: "workflow_run" },
  "workflow_run.started": {
    ...LEGACY_AUDIT,
    name: "workflow_run.started",
    subject: "workflow_run"
  },
  // A due time of a schedule that started no run. The subject is the Workflow.
  "workflow_run.tick_skipped": {
    ...LEGACY_AUDIT,
    name: "workflow_run.tick_skipped",
    subject: "workflow"
  },
  "workspace_command.cancelled": {
    ...LEGACY_AUDIT,
    name: "workspace_command.cancelled",
    subject: "workspace_command"
  },
  "workspace_command.completed": {
    ...LEGACY_AUDIT,
    name: "workspace_command.completed",
    subject: "workspace_command"
  },
  "workspace_command.failed": {
    ...LEGACY_AUDIT,
    name: "workspace_command.failed",
    subject: "workspace_command"
  },
  "workspace_command.queued": {
    ...LEGACY_AUDIT,
    name: "workspace_command.queued",
    subject: "workspace_command"
  },
  "workspace_command.recovered_stale": {
    ...LEGACY_AUDIT,
    name: "workspace_command.recovered_stale",
    subject: "workspace_command"
  },
  "workspace_command.running": {
    ...LEGACY_AUDIT,
    name: "workspace_command.running",
    subject: "workspace_command"
  },
  "workspace_command.timed_out": {
    ...LEGACY_AUDIT,
    name: "workspace_command.timed_out",
    subject: "workspace_command"
  }
} as const satisfies Record<string, PlatformEventDefinition>;

export type PlatformEventName = keyof typeof EVENTS;
export type AuditEventName = PlatformEventName;

export interface PlatformEventContext extends Pick<
  OperationCall,
  "actor" | "origin" | "workspaceId" | "correlationId"
> {
  /** What the event is about. A before-event of an asset not written yet has its name only. */
  subject: { kind: string; id?: string; name?: string };
  phase: PlatformEventPhase;
  /**
   * The fields a guardrail at a before-event reads, by the names the event declares checkable:
   * an asset's text, a call's input. Asked only where a guardrail applies, and never stored:
   * the payload holds references only.
   */
  checkable?(): GuardrailFields | Promise<GuardrailFields>;
  /** What a filter narrows by beside the origin: the asset kind or the operation's name. */
  filterBy?: { kind?: string; operation?: string };
  /** For the deadline and the stop of a guardrail's model call, where the caller has them. */
  runtime?: { deadline?: Date; signal?: AbortSignal };
  /**
   * Set where the event is asked again for the same action, as before a call that waited for
   * an approval is executed. The guardrails answer again; their hits were kept the first time.
   */
  repeated?: true;
}

export type PlatformEventOutcome = "allow" | "warn" | "block" | "require_approval";

/**
 * What a before-event answered: the strictest outcome of every guardrail that applies, and
 * those that warned, held or blocked, with their reasons. An after-event answers `allow`.
 */
export interface PlatformEventAnswer {
  outcome: PlatformEventOutcome;
  guardrails: readonly GuardrailAnswer[];
}

export const PLATFORM_EVENT_ALLOW: PlatformEventAnswer = { outcome: "allow", guardrails: [] };

const OUTCOME_ORDER: readonly PlatformEventOutcome[] = [
  "allow",
  "warn",
  "require_approval",
  "block"
];

/** The strictest of several outcomes: an `allow` never overrides a `warn` or a `block`. */
export function strictestOutcome(outcomes: readonly PlatformEventOutcome[]): PlatformEventOutcome {
  return outcomes.reduce(
    (left, right) => (OUTCOME_ORDER.indexOf(left) >= OUTCOME_ORDER.indexOf(right) ? left : right),
    "allow"
  );
}

/**
 * The one way an event is raised. At `before` the guardrails bound to the name run, and the
 * caller acts on the answer; at `after` an audited event becomes an audit row.
 */
export interface PlatformEventEmitter {
  emit(
    name: PlatformEventName,
    payload: JsonObject,
    context: PlatformEventContext
  ): Promise<PlatformEventAnswer>;
}
