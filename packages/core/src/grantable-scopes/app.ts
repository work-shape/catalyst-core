import type { ActionScopes } from "./action-scopes";

export const APP_GRANT_SCOPES = {
  // An App is a workspace's: its rights are granted on what one workspace owns, on one App or
  // on all of them. `app.use` stays with the membership of the workspace.
  "app.read": ["workspace", "asset", "instance"],
  "app.write": ["workspace", "asset", "instance"],
  "app.publish": ["workspace", "asset", "instance"],
  "app.delete": ["workspace", "asset", "instance"]
} as const satisfies ActionScopes;
