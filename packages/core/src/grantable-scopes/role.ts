import type { ActionScopes } from "./action-scopes";

export const ROLE_GRANT_SCOPES = {
  // Editing `user` and `admin` changes the rights of everybody who holds them, so it is held on
  // the whole instance only (Felix, 2026-10-21).
  "roles.edit_built_in": ["instance"]
} as const satisfies ActionScopes;
