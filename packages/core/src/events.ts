import { GUARDRAIL_OUTCOMES } from "@work-shape/catalyst-asset-schemas";
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

// Counts of the physical cleanup, shared by document removal and Knowledge Base deletion.
const KNOWLEDGE_PURGE_AUDIT: Omit<PlatformEventDefinition, "name"> = {
  subject: "config_asset",
  legacy: false,
  audited: true,
  phases: ["after"],
  payload: {
    type: "object",
    additionalProperties: false,
    required: ["documents", "chunks", "contents", "files", "objects", "extractionResults"],
    properties: {
      documents: { type: "integer", minimum: 0 },
      chunks: { type: "integer", minimum: 0 },
      contents: { type: "integer", minimum: 0 },
      files: { type: "integer", minimum: 0 },
      objects: { type: "integer", minimum: 0 },
      extractionResults: { type: "integer", minimum: 0 }
    }
  }
};

// Run observations remain a separate stream from platform events and audit.
export const EVENTS = {
  "agent_run.recovered": { ...LEGACY_AUDIT, name: "agent_run.recovered", subject: "agent_run" },
  "api_access.connect_code_confirmed": {
    ...LEGACY_AUDIT,
    name: "api_access.connect_code_confirmed",
    subject: "api_access"
  },
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
  "api_access.personal_key_created": {
    ...LEGACY_AUDIT,
    name: "api_access.personal_key_created",
    subject: "api_access"
  },
  "api_access.personal_key_revoked": {
    ...LEGACY_AUDIT,
    name: "api_access.personal_key_revoked",
    subject: "api_access"
  },
  "api_access.personal_keys_viewed": {
    ...LEGACY_AUDIT,
    name: "api_access.personal_keys_viewed",
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
  "auth.personal_access_token_issued": {
    ...LEGACY_AUDIT,
    name: "auth.personal_access_token_issued",
    subject: "auth"
  },
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
  "config_asset.shipped_skill_unlisted": {
    ...LEGACY_AUDIT,
    name: "config_asset.shipped_skill_unlisted",
    subject: "config_asset"
  },
  "config_asset.updated": {
    ...LEGACY_AUDIT,
    name: "config_asset.updated",
    subject: "config_asset"
  },
  // A sign-in at the outside system was completed for a Connection (CS-4b). The subject is the
  // Connection's name. The metadata names granted scopes, never a token, a code or an account.
  "connection.binding_connected": {
    name: "connection.binding_connected",
    subject: "connection",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["connectionName", "connectionRevision", "subjectKind", "scopes"],
      properties: {
        connectionName: { type: "string" },
        connectionRevision: { type: "integer" },
        subjectKind: { type: "string", enum: ["shared"] },
        scopes: { type: "array", items: { type: "string" } },
        accountChanged: { type: "boolean" },
        operationRunId: { type: "string" }
      }
    }
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
  // The platform registered an OAuth client for a Connection at its authorization server by
  // Dynamic Client Registration. The metadata names the issuer's host, never a client secret.
  "connection.oauth_client_registered": {
    name: "connection.oauth_client_registered",
    subject: "connection",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["connectionName", "connectionRevision", "issuerHost", "method"],
      properties: {
        connectionName: { type: "string" },
        connectionRevision: { type: "integer" },
        issuerHost: { type: "string" },
        method: { type: "string", enum: ["dcr"] },
        operationRunId: { type: "string" }
      }
    }
  },
  // The start or the callback of a sign-in was refused. The reason is the event's reason; the
  // metadata names the stage, never a state, a code or the authorization address.
  "connection.oauth_refused": {
    name: "connection.oauth_refused",
    subject: "connection",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["stage", "subjectKind"],
      properties: {
        connectionName: { type: "string" },
        connectionRevision: { type: "integer" },
        stage: { type: "string", enum: ["start", "callback"] },
        subjectKind: { type: "string", enum: ["shared"] },
        operationRunId: { type: "string" }
      }
    }
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
  "conversation.subject_opened": {
    ...LEGACY_AUDIT,
    name: "conversation.subject_opened",
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
  // The database of a store a Knowledge Base owned is dropped, once that Knowledge Base was
  // deleted. The subject is the store.
  // The store a Knowledge Base owned, dropped with its rows and roles after the Knowledge Base
  // was deleted. Its metadata names the store; it holds nothing the store held.
  "data_store.dropped": {
    name: "data_store.dropped",
    subject: "data_store",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string" } }
    }
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
  // Files added to a Knowledge Base: the copies it now owns, by id, how many and their bytes.
  // The subject is the Knowledge Base's asset. It names no file name, because the names of
  // personal documents name people, and nothing a file holds.
  "knowledge_base.files_added": {
    name: "knowledge_base.files_added",
    subject: "config_asset",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["knowledgeBase", "fileIds", "count", "bytes"],
      properties: {
        knowledgeBase: { type: "string" },
        fileIds: { type: "array", items: { type: "string" } },
        count: { type: "integer", minimum: 1 },
        bytes: { type: "integer", minimum: 0 }
      }
    }
  },
  // Removal records ids and counts; content, titles and file names stay in the store.
  "knowledge_base.documents_removed": {
    name: "knowledge_base.documents_removed",
    subject: "config_asset",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["documentIds", "documents"],
      properties: {
        documentIds: { type: "array", items: { type: "string" } },
        documents: { type: "integer", minimum: 0 }
      }
    }
  },
  "knowledge_base.documents_purged": {
    ...KNOWLEDGE_PURGE_AUDIT,
    name: "knowledge_base.documents_purged"
  },
  "knowledge_base.deleted": { ...KNOWLEDGE_PURGE_AUDIT, name: "knowledge_base.deleted" },
  // One content indexed or failed: ids, counts and a failure code, never its text or file name.
  // For files added by hand only: a content of a synced source emits none, and its sync is
  // audited per run with counts (SRC-0).
  "knowledge_base.content_indexed": {
    name: "knowledge_base.content_indexed",
    subject: "config_asset",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["knowledgeBase", "fileId"],
      properties: {
        knowledgeBase: { type: "string" },
        fileId: { type: "string" },
        chunks: { type: "integer", minimum: 1 },
        pages: { type: "integer", minimum: 1 }
      }
    }
  },
  // "Run live once" on an action or a step of a draft (ADR-0031). The subject is the App or
  // the Workflow; the metadata names its draft revision, the action or step and who set it.
  // A guardrail made to enforce at its scope, or taken back: who, which revision and where.
  "guardrail.published": { ...LIVE_ONCE_AUDIT, name: "guardrail.published" },
  "guardrail.unpublished": { ...LIVE_ONCE_AUDIT, name: "guardrail.unpublished" },
  // A guardrail the release ships switched off or on again by an instance admin.
  "guardrail.shipped_switched": { ...LIVE_ONCE_AUDIT, name: "guardrail.shipped_switched" },
  "live_once.cleared": { ...LIVE_ONCE_AUDIT, name: "live_once.cleared" },
  "live_once.switched_on": { ...LIVE_ONCE_AUDIT, name: "live_once.switched_on" },
  "live_once.used": { ...LIVE_ONCE_AUDIT, name: "live_once.used" },
  "message.cancelled": { ...LEGACY_AUDIT, name: "message.cancelled", subject: "message" },
  "message.completed": { ...LEGACY_AUDIT, name: "message.completed", subject: "message" },
  "message.created": {
    ...LEGACY_AUDIT,
    name: "message.created",
    subject: "message",
    payload: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        attachmentCount: { type: "integer" },
        delivery: { const: "queued" }
      }
    }
  },
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
  /**
   * Set where the action writes, publishes, deletes or tests guardrails: only the release floor
   * answers its before-events, so no published guardrail stops the change of guardrails.
   */
  aboutGuardrails?: true;
  /** For the deadline and the stop of a guardrail's model call, where the caller has them. */
  runtime?: { deadline?: Date; signal?: AbortSignal };
  /**
   * Set where the event is asked again for the same action, as before a call that waited for
   * an approval is executed. The guardrails answer again; their hits were kept the first time.
   */
  repeated?: true;
  /**
   * Set where the action cannot wait for an approval and no request is filed for it, as the
   * App draft a save of a Page writes once the Page is stored: a guardrail's
   * `require_approval` answers and is kept as a `block`, so no hit waits for an approval
   * nobody can give.
   */
  cannotWait?: true;
}

export type PlatformEventOutcome = (typeof GUARDRAIL_OUTCOMES)[number];

/**
 * What a before-event answered: the strictest outcome of every guardrail that applies, and
 * those that warned, held or blocked, with their reasons. An after-event answers `allow`.
 */
export interface PlatformEventAnswer {
  outcome: PlatformEventOutcome;
  guardrails: readonly GuardrailAnswer[];
}

export const PLATFORM_EVENT_ALLOW: PlatformEventAnswer = { outcome: "allow", guardrails: [] };

const OUTCOME_ORDER: readonly PlatformEventOutcome[] = [...GUARDRAIL_OUTCOMES];

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
