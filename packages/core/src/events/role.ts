import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const roleEvents = {
  // Roles as data (ADR-0028): the actor, the role, and the grants added and removed with
  // action and scope. `role.reconciled` is the migration step's: what a release changed.
  "role.created": { ...LEGACY_AUDIT, name: "role.created", subject: "role" },
  "role.updated": { ...LEGACY_AUDIT, name: "role.updated", subject: "role" },
  "role.reset": { ...LEGACY_AUDIT, name: "role.reset", subject: "role" },
  "role.deleted": { ...LEGACY_AUDIT, name: "role.deleted", subject: "role" },
  "role.pending_decided": { ...LEGACY_AUDIT, name: "role.pending_decided", subject: "role" },
  "role.reconciled": { ...LEGACY_AUDIT, name: "role.reconciled", subject: "role" }
} as const satisfies Record<string, PlatformEventDefinition>;
