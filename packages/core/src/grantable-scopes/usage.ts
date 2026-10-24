import type { ActionScopes } from "./action-scopes";

export const USAGE_GRANT_SCOPES = {
  // Usage by named person (LU-3): of every person at instance scope, of the members of one
  // shared workspace at workspace scope.
  "usage.view_users": ["workspace", "instance"]
} as const satisfies ActionScopes;
