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
  // An admin set, changed or removed a central policy setting (OP-2): the operation or pattern,
  // the workspace and asset kind it is narrowed to, and the value before and after. Nothing of
  // any call's input.
  "governance.policy_setting_changed": {
    name: "governance.policy_setting_changed",
    subject: "instance",
    legacy: false,
    audited: true,
    phases: ["after"]
  },
  // An admin locked "Always allow" for an operation or a pattern, or lifted their lock (OP-2).
  "governance.always_allow_lock_changed": {
    name: "governance.always_allow_lock_changed",
    subject: "instance",
    legacy: false,
    audited: true,
    phases: ["after"]
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
  // The usage of named people was opened (LU-3, limits spec 3.4): the Users view of the
  // instance or the members of one workspace, and the month. No figure and no name of anyone
  // shown.
  "governance.usage_users_viewed": {
    name: "governance.usage_users_viewed",
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
