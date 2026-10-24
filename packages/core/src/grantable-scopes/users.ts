import type { ActionScopes } from "./action-scopes";

export const USERS_GRANT_SCOPES = {
  // A person's account is the instance's, so deleting one is held on the whole instance only
  // (RIGHTS-1e). `users.manage` stays a legacy key, on the Users page.
  "users.delete": ["instance"]
} as const satisfies ActionScopes;
