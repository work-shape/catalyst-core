import type { ActionScopes } from "./action-scopes";

export const CONNECTION_GRANT_SCOPES = {
  // Reading and using a Connection are granted on one Connection or on all of them. No
  // workspace owns a Connection, so a right at workspace scope would cover nothing. Writing,
  // deleting and approving stay with the role until RIGHTS-1d opens them.
  "connection.read": ["asset", "instance"],
  "connection.use": ["asset", "instance"]
} as const satisfies ActionScopes;
