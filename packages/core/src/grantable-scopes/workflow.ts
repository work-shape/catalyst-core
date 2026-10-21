import type { ActionScopes } from "./action-scopes";

export const WORKFLOW_GRANT_SCOPES = {
  // A Workflow is owned by the instance or by one workspace (WS-OWN-1b): its rights are granted
  // on one Workflow, on those a workspace owns, or on all of them. Membership gives none,
  // because a run acts as its principal. Reading shows it and its runs, using starts it, writing
  // edits the draft, publishing moves the published pointer and deleting removes it; making a
  // revision live that names a service principal also asks every right of that principal
  // (`requireHeldRights`). The rows of a run's datasets are a copy of what the principal reads,
  // so `read_run_data` is given on one Workflow only, by a holder of every right of its
  // principal (D4).
  "workflow.read": ["workspace", "asset", "instance"],
  "workflow.use": ["workspace", "asset", "instance"],
  "workflow.write": ["workspace", "asset", "instance"],
  "workflow.publish": ["workspace", "asset", "instance"],
  "workflow.delete": ["workspace", "asset", "instance"],
  "workflow.read_run_data": ["asset"]
} as const satisfies ActionScopes;
