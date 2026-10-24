import type { ActionScopes } from "./action-scopes";

export const SYSTEM_GRANT_SCOPES = {
  // How the instance runs is the instance's as a whole, so seeing it is held on the whole
  // instance only (RIGHTS-1e).
  "system.view": ["instance"]
} as const satisfies ActionScopes;
