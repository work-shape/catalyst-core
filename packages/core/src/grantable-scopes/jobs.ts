import type { ActionScopes } from "./action-scopes";

export const JOBS_GRANT_SCOPES = {
  // The background queue is the instance's, so a retry is held on the whole instance only
  // (RIGHTS-1e).
  "jobs.retry": ["instance"]
} as const satisfies ActionScopes;
