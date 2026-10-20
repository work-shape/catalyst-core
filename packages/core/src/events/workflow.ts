import { LIVE_ONCE_AUDIT, type PlatformEventDefinition } from "./definition";

export const workflowEvents = {
  "workflow.unpublished": { ...LIVE_ONCE_AUDIT, name: "workflow.unpublished" },
  "workflow.before_publish": {
    name: "workflow.before_publish",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  }
} as const satisfies Record<string, PlatformEventDefinition>;
