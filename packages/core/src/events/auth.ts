import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const authEvents = {
  "auth.personal_access_token_issued": {
    ...LEGACY_AUDIT,
    name: "auth.personal_access_token_issued",
    subject: "auth"
  },
  "auth.service_access_token_issued": {
    ...LEGACY_AUDIT,
    name: "auth.service_access_token_issued",
    subject: "auth"
  },
  "auth.session_token_issued": {
    ...LEGACY_AUDIT,
    name: "auth.session_token_issued",
    subject: "auth"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
