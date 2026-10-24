import type { ActionScopes } from "./action-scopes";

export const SERVICE_PRINCIPALS_GRANT_SCOPES = {
  // A service principal is the instance's, so administering them is held on the whole instance
  // only (RIGHTS-1f). Their keys stay with `api_access.manage`, a legacy key.
  "service_principals.manage": ["instance"]
} as const satisfies ActionScopes;
