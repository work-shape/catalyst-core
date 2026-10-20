import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const auditEvents = {
  "audit.pruned": { ...LEGACY_AUDIT, name: "audit.pruned", subject: "audit" }
} as const satisfies Record<string, PlatformEventDefinition>;
