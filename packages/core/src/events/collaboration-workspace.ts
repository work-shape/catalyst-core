import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const collaborationWorkspaceEvents = {
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
  }
} as const satisfies Record<string, PlatformEventDefinition>;
