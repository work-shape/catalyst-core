import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const jobEvents = {
  "job.retried": { ...LEGACY_AUDIT, name: "job.retried", subject: "job" }
} as const satisfies Record<string, PlatformEventDefinition>;
