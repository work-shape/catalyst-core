import type { ActionScopes } from "./action-scopes";

export const WORKFLOW_GRANT_SCOPES = {
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
  "workflow.read_run_data": ["asset"]
} as const satisfies ActionScopes;
