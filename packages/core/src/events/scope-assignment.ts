import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const scopeAssignmentEvents = {
  "scope_assignment.changed": {
    ...LEGACY_AUDIT,
    name: "scope_assignment.changed",
    subject: "scope_assignment"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
