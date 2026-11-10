import type { ActionScopes } from "./action-scopes";

export const CONNECTION_GRANT_SCOPES = {
  // A Connection's rights are granted on one Connection or on all of them. No workspace owns a
  // Connection, so a right at workspace scope would cover nothing. Writing is grantable because
  // a change of the host a Connection calls clears its stored secret (D11): a writer cannot have
  // the key sent to another system. Creating a Connection is writing on the instance.
  "connection.read": ["asset", "instance"],
  "connection.use": ["asset", "instance"],
  "connection.write": ["asset", "instance"],
  "connection.delete": ["asset", "instance"],
  "connection.approve": ["asset", "instance"],
  // Adding one's own MCP server names no Connection: it is held, or denied, on the instance.
  "connection.add_own": ["instance"]
} as const satisfies ActionScopes;
