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
  // A spend limit was set, changed or removed (LU-2): its level, the workspace or user it names,
  // and the amounts before and after. Nothing of what anyone spent.
  "governance.usage_limit_changed": {
    name: "governance.usage_limit_changed",
    subject: "instance",
    legacy: false,
    audited: true,
    phases: ["after"]
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
