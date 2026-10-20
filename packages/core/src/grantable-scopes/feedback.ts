import type { ActionScopes } from "./action-scopes";

export const FEEDBACK_GRANT_SCOPES = {
  // Reviewing feedback on the agents one workspace owns, or on every agent (LU-4).
  "feedback.review": ["workspace", "instance"]
} as const satisfies ActionScopes;
