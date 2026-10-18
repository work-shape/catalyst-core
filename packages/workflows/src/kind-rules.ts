import {
  WORKFLOW_ERROR_CODES,
  workflowStepsDeep,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import type { WorkflowDefinitionIssue } from "./definition";

// Match whole operation names, including nested records.propose; a prefix match would also
// refuse reads and unrelated Connection operations. Walk blocks with the contract's walker.
const DATA_WRITE_OPERATION =
  /^(?:knowledge\.[^.]+\.(?:ingest|withdraw|put_processed)|data_store\.[^.]+\.records\.propose)$/u;

/** Drafts can be built in either order; this rule applies when a revision becomes live. */
export function workflowKindIssues(manifest: WorkflowManifest): WorkflowDefinitionIssue[] {
  if (manifest.kind === "data") return [];
  const steps = [...workflowStepsDeep(manifest.steps)];
  const calls = [
    ...steps.flatMap((step) =>
      step.type === "operation" && typeof step.operation === "string"
        ? [{ operation: step.operation, path: `steps.${String(step.id)}.operation` }]
        : []
    ),
    // An agent step can dispatch the same writes through its declared tools.
    ...(steps.some((step) => step.type === "agent") ? (manifest.tools ?? []) : []).map(
      (operation, index) => ({
        operation,
        path: `tools.${index}`
      })
    )
  ];
  return calls
    .filter(({ operation }) => DATA_WRITE_OPERATION.test(operation))
    .map(({ operation, path }) => ({
      code: WORKFLOW_ERROR_CODES.processWriteOperation,
      path,
      message: `Operation '${operation}' writes data. Set kind: data in workflow.yaml before publishing this Workflow.`
    }));
}
