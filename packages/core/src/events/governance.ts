import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const governanceEvents = {
  "governance.audit_events_viewed": {
    ...LEGACY_AUDIT,
    name: "governance.audit_events_viewed",
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
  "governance.users_viewed": {
    ...LEGACY_AUDIT,
    name: "governance.users_viewed",
    subject: "instance"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
