import { LEGACY_AUDIT, LIVE_ONCE_AUDIT, type PlatformEventDefinition } from "./definition";

export const appEvents = {
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
  // A person allowed an outside host for their own view of a draft (DRAFT-HOSTS-1): the host,
  // the App and the revision, or the Page and its conversation. No content of the draft.
  "app.draft_host_allowed": { ...LIVE_ONCE_AUDIT, name: "app.draft_host_allowed" },
  "app.page_draft_host_allowed": {
    ...LIVE_ONCE_AUDIT,
    name: "app.page_draft_host_allowed",
    subject: "conversation"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
