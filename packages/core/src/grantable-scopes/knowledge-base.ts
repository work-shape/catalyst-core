import type { ActionScopes } from "./action-scopes";

export const KNOWLEDGE_BASE_GRANT_SCOPES = {
  // A Knowledge Base's rights are granted on one Knowledge Base or on all of them: `use`
  // queries the published revision, `read` shows it and its state, `write` changes the draft,
  // `publish` makes it live and `delete` removes it.
  "knowledge_base.read": ["asset", "instance"],
  "knowledge_base.use": ["asset", "instance"],
  "knowledge_base.write": ["asset", "instance"],
  "knowledge_base.publish": ["asset", "instance"],
  "knowledge_base.delete": ["asset", "instance"]
} as const satisfies ActionScopes;
