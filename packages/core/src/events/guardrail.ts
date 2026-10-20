import { LIVE_ONCE_AUDIT, type PlatformEventDefinition } from "./definition";

export const guardrailEvents = {
  // "Run live once" on an action or a step of a draft (ADR-0031). The subject is the App or
  // the Workflow; the metadata names its draft revision, the action or step and who set it.
  // A guardrail made to enforce at its scope, or taken back: who, which revision and where.
  "guardrail.published": { ...LIVE_ONCE_AUDIT, name: "guardrail.published" },
  "guardrail.unpublished": { ...LIVE_ONCE_AUDIT, name: "guardrail.unpublished" },
  // A guardrail the release ships switched off or on again by an instance admin.
  "guardrail.shipped_switched": { ...LIVE_ONCE_AUDIT, name: "guardrail.shipped_switched" }
} as const satisfies Record<string, PlatformEventDefinition>;
