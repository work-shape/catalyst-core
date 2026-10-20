import type { ActionScopes } from "./action-scopes";

export const GUARDRAIL_GRANT_SCOPES = {
  // `guardrail.publish` is one workspace's or the instance's; no bundle carries it.
  "guardrail.publish": ["workspace", "instance"]
} as const satisfies ActionScopes;
