import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const apiAccessEvents = {
  "api_access.connect_code_confirmed": {
    ...LEGACY_AUDIT,
    name: "api_access.connect_code_confirmed",
    subject: "api_access"
  },
  "api_access.credential_created": {
    ...LEGACY_AUDIT,
    name: "api_access.credential_created",
    subject: "api_access"
  },
  "api_access.credential_revoked": {
    ...LEGACY_AUDIT,
    name: "api_access.credential_revoked",
    subject: "api_access"
  },
  "api_access.personal_key_created": {
    ...LEGACY_AUDIT,
    name: "api_access.personal_key_created",
    subject: "api_access"
  },
  "api_access.personal_key_revoked": {
    ...LEGACY_AUDIT,
    name: "api_access.personal_key_revoked",
    subject: "api_access"
  },
  "api_access.personal_keys_viewed": {
    ...LEGACY_AUDIT,
    name: "api_access.personal_keys_viewed",
    subject: "api_access"
  },
  "api_access.service_principal_created": {
    ...LEGACY_AUDIT,
    name: "api_access.service_principal_created",
    subject: "api_access"
  },
  "api_access.service_principal_updated": {
    ...LEGACY_AUDIT,
    name: "api_access.service_principal_updated",
    subject: "api_access"
  },
  "api_access.service_principals_viewed": {
    ...LEGACY_AUDIT,
    name: "api_access.service_principals_viewed",
    subject: "api_access"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
