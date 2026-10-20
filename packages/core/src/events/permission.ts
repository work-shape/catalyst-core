import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const permissionEvents = {
  "permission.granted": {
    ...LEGACY_AUDIT,
    name: "permission.granted",
    subject: "permission_grant"
  },
  "permission.revoked": {
    ...LEGACY_AUDIT,
    name: "permission.revoked",
    subject: "permission_grant"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
