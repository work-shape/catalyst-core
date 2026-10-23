import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const userEvents = {
  "user.created": { ...LEGACY_AUDIT, name: "user.created", subject: "user" },
  "user.deleted": { ...LEGACY_AUDIT, name: "user.deleted", subject: "user" },
  "user.deletion_requested": {
    ...LEGACY_AUDIT,
    name: "user.deletion_requested",
    subject: "user"
  },
  "user.deletion_stalled": { ...LEGACY_AUDIT, name: "user.deletion_stalled", subject: "user" },
  "user.identity_deleted": { ...LEGACY_AUDIT, name: "user.identity_deleted", subject: "user" },
  "user.identity_linked": { ...LEGACY_AUDIT, name: "user.identity_linked", subject: "user" },
  "user.identity_upserted": { ...LEGACY_AUDIT, name: "user.identity_upserted", subject: "user" },
  "user.invitation_sent": { ...LEGACY_AUDIT, name: "user.invitation_sent", subject: "user" },
  "user.password_changed": { ...LEGACY_AUDIT, name: "user.password_changed", subject: "user" },
  "user.password_reset": { ...LEGACY_AUDIT, name: "user.password_reset", subject: "user" },
  "user.password_reset_requested": {
    ...LEGACY_AUDIT,
    name: "user.password_reset_requested",
    subject: "user"
  },
  "user.password_sign_in_created": {
    ...LEGACY_AUDIT,
    name: "user.password_sign_in_created",
    subject: "user"
  },
  // A person set, changed or removed their own confirmation setting for one operation (OP-6):
  // the operation and the value, never what any call of it carried.
  "user.operation_setting_changed": {
    name: "user.operation_setting_changed",
    subject: "user",
    legacy: false,
    audited: true,
    phases: ["after"]
  },
  "user.profile_updated": { ...LEGACY_AUDIT, name: "user.profile_updated", subject: "user" },
  "user.updated": { ...LEGACY_AUDIT, name: "user.updated", subject: "user" }
} as const satisfies Record<string, PlatformEventDefinition>;
