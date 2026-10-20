import type { GrantScopeKind, PlatformAction } from "@work-shape/catalyst-asset-schemas";

/**
 * The actions a grant row can be written for, with the scope kinds it can be written at. A row
 * at instance scope is written for the actions no legacy key carries (RIGHTS-1c, D3): the
 * actions of a legacy key stay the key's, on the Users page, until AP-5b. `guardrail.publish` is one workspace's or the instance's;
 * no bundle carries it.
 */
export const GRANTABLE_ACTION_SCOPES = {
  "agent.read": ["workspace", "asset"],
  "agent.write": ["workspace", "asset"],
  "agent.publish": ["workspace", "asset"],
  "agent.delete": ["workspace", "asset"],
  "skill.read": ["workspace", "asset"],
  "skill.write": ["workspace", "asset"],
  "skill.delete": ["workspace", "asset"],
  // Reading and using a Connection are granted on one Connection or on all of them. No
  // workspace owns a Connection, so a right at workspace scope would cover nothing. Writing,
  // deleting and approving stay with the role until RIGHTS-1d opens them.
  "connection.read": ["asset", "instance"],
  "connection.use": ["asset", "instance"],
  // An App is a workspace's: its rights are granted on what one workspace owns, on one App or
  // on all of them. `app.use` stays with the membership of the workspace.
  "app.read": ["workspace", "asset", "instance"],
  "app.write": ["workspace", "asset", "instance"],
  "app.publish": ["workspace", "asset", "instance"],
  "app.delete": ["workspace", "asset", "instance"],
  // Definition and row rights are granted separately, on one store, what a workspace owns,
  // or the instance. Editing or publishing a definition grants no right to write rows.
  "data_store.read": ["workspace", "asset", "instance"],
  "data_store.insert": ["workspace", "asset", "instance"],
  "data_store.execute": ["workspace", "asset", "instance"],
  "data_store.write": ["workspace", "asset", "instance"],
  "data_store.publish": ["workspace", "asset", "instance"],
  "data_store.delete": ["workspace", "asset", "instance"],
  "data_store.records": ["workspace", "asset", "instance"],
  // A Knowledge Base's rights are granted on one Knowledge Base or on all of them: `use`
  // queries the published revision, `read` shows it and its state, `write` changes the draft,
  // `publish` makes it live and `delete` removes it.
  "knowledge_base.read": ["asset", "instance"],
  "knowledge_base.use": ["asset", "instance"],
  "knowledge_base.write": ["asset", "instance"],
  "knowledge_base.publish": ["asset", "instance"],
  "knowledge_base.delete": ["asset", "instance"],
  // A Workflow is the instance's own: its rights are granted on one Workflow or on all of them,
  // and no workspace owns one yet. Reading shows it and its runs, using starts it, writing
  // edits the draft, publishing moves the published pointer and deleting removes it; making a
  // revision live that names a service principal also asks every right of that principal
  // (`requireHeldRights`). The rows of a run's datasets are a copy of what the principal reads,
  // so `read_run_data` is given on one Workflow only, by a holder of every right of its
  // principal (D4).
  "workflow.read": ["asset", "instance"],
  "workflow.use": ["asset", "instance"],
  "workflow.write": ["asset", "instance"],
  "workflow.publish": ["asset", "instance"],
  "workflow.delete": ["asset", "instance"],
  "workflow.read_run_data": ["asset"],
  "guardrail.publish": ["workspace", "instance"],
  // Sending as one sender of the instance (MAIL-1): granted on that one sender, `system`, and
  // never on all of them, so a later sender is not reached by a grant given for `system`. A
  // grant names a sender the instance registers, so none is written while outbound mail is off.
  "mail_sender.use": ["asset"],
  // Builder and Publisher are held in one Shared Workspace, with or without membership, and
  // cover what it owns (`rowGives` in `permissions.ts`).
  builder: ["workspace"],
  publisher: ["workspace"]
} as const satisfies Partial<Record<PlatformAction, readonly GrantScopeKind[]>>;
