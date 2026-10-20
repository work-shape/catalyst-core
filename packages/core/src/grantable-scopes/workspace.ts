import type { ActionScopes } from "./action-scopes";

export const WORKSPACE_GRANT_SCOPES = {
  // Builder and Publisher are held in one Shared Workspace, with or without membership, and
  // cover what it owns (`rowGives` in `permissions.ts`).
  builder: ["workspace"],
  publisher: ["workspace"]
} as const satisfies ActionScopes;
