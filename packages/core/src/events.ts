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

// Run observations remain a separate stream from platform events and audit.
export const EVENTS = {
  "agent_run.recovered": { ...LEGACY_AUDIT, name: "agent_run.recovered", subject: "agent_run" },
  "api_access.credential_create_authorized": {
    ...LEGACY_AUDIT,
    name: "api_access.credential_create_authorized",
    subject: "api_access"
  },
  "api_access.credential_created": {
    ...LEGACY_AUDIT,
    name: "api_access.credential_created",
    subject: "api_access"
  },
  "api_access.credential_revoke_authorized": {
    ...LEGACY_AUDIT,
    name: "api_access.credential_revoke_authorized",
    subject: "api_access"
  },
  "api_access.credential_revoked": {
    ...LEGACY_AUDIT,
    name: "api_access.credential_revoked",
    subject: "api_access"
  },
  "api_access.service_principal_create_authorized": {
    ...LEGACY_AUDIT,
    name: "api_access.service_principal_create_authorized",
    subject: "api_access"
  },
  "api_access.service_principal_created": {
    ...LEGACY_AUDIT,
    name: "api_access.service_principal_created",
    subject: "api_access"
  },
  "api_access.service_principal_update_authorized": {
    ...LEGACY_AUDIT,
    name: "api_access.service_principal_update_authorized",
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
  "config_assets.replaced": {
    ...LEGACY_AUDIT,
    name: "config_assets.replaced",
    subject: "config_assets"
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
  "governance.config_assets_release_authorized": {
    ...LEGACY_AUDIT,
    name: "governance.config_assets_release_authorized",
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
  "governance.user_create_authorized": {
    ...LEGACY_AUDIT,
    name: "governance.user_create_authorized",
    subject: "instance"
  },
  "governance.user_delete_authorized": {
    ...LEGACY_AUDIT,
    name: "governance.user_delete_authorized",
    subject: "instance"
  },
  "governance.user_identity_delete_authorized": {
    ...LEGACY_AUDIT,
    name: "governance.user_identity_delete_authorized",
    subject: "instance"
  },
  "governance.user_identity_upsert_authorized": {
    ...LEGACY_AUDIT,
    name: "governance.user_identity_upsert_authorized",
    subject: "instance"
  },
  "governance.user_invitation_authorized": {
    ...LEGACY_AUDIT,
    name: "governance.user_invitation_authorized",
    subject: "instance"
  },
  "governance.user_password_reset_authorized": {
    ...LEGACY_AUDIT,
    name: "governance.user_password_reset_authorized",
    subject: "instance"
  },
  "governance.user_update_authorized": {
    ...LEGACY_AUDIT,
    name: "governance.user_update_authorized",
    subject: "instance"
  },
  "governance.users_viewed": {
    ...LEGACY_AUDIT,
    name: "governance.users_viewed",
    subject: "instance"
  },
  "message.cancelled": { ...LEGACY_AUDIT, name: "message.cancelled", subject: "message" },
  "message.completed": { ...LEGACY_AUDIT, name: "message.completed", subject: "message" },
  "message.created": { ...LEGACY_AUDIT, name: "message.created", subject: "message" },
  "message.failed": { ...LEGACY_AUDIT, name: "message.failed", subject: "message" },
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
  "tool.authorization_checked": {
    ...LEGACY_AUDIT,
    name: "tool.authorization_checked",
    subject: "tool"
  },
  "tool.completed": { ...LEGACY_AUDIT, name: "tool.completed", subject: "tool" },
  "tool.failed": { ...LEGACY_AUDIT, name: "tool.failed", subject: "tool" },
  "tool.started": { ...LEGACY_AUDIT, name: "tool.started", subject: "tool" },
  "user.created": { ...LEGACY_AUDIT, name: "user.created", subject: "user" },
  "user.deleted": { ...LEGACY_AUDIT, name: "user.deleted", subject: "user" },
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
  subject: { kind: string; id: string };
  phase: PlatformEventPhase;
}

export type PlatformEventOutcome = "allow" | "warn" | "block" | "require_approval";

// EW-1 implements emission, guardrails and persistence.
export interface PlatformEventEmitter {
  emit(
    name: PlatformEventName,
    payload: JsonObject,
    context: PlatformEventContext
  ): Promise<PlatformEventOutcome>;
}
