import { LIVE_ONCE_AUDIT, type PlatformEventDefinition } from "./definition";

export const workflowEvents = {
  "workflow.unpublished": { ...LIVE_ONCE_AUDIT, name: "workflow.unpublished" },
  // A publisher made the Workflow's webhook secret anew (EW-4): the version, never the secret.
  "workflow.webhook_secret_rotated": {
    ...LIVE_ONCE_AUDIT,
    name: "workflow.webhook_secret_rotated"
  },
  // A call of the Workflow's webhook that started no run: the reason, never the body.
  "workflow.webhook_refused": { ...LIVE_ONCE_AUDIT, name: "workflow.webhook_refused" },
  // A platform event a `platform_event` trigger names that started no run of the Workflow: the
  // event's name and id and the reason, such as a source its account may not read.
  "workflow.event_dropped": { ...LIVE_ONCE_AUDIT, name: "workflow.event_dropped" },
  "workflow.before_publish": {
    name: "workflow.before_publish",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  }
} as const satisfies Record<string, PlatformEventDefinition>;
