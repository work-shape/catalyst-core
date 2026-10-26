import type { WorkflowBlockIssue } from "@work-shape/catalyst-core";

/** The code of a limit that lies above the ceiling of release config. Asked at publish. */
export const WORKFLOW_LIMIT_ABOVE_CEILING = "limit_above_ceiling";

/** The code of a step that names an operation no step of a Workflow may call. */
export const WORKFLOW_OPERATION_NOT_CALLABLE = "operation_not_callable";

/** The code of a definition outside clients may start that reads data not exposed to them. */
export const WORKFLOW_OUTSIDE_NOT_EXPOSED = "outside_not_exposed";

/**
 * One thing that keeps a definition from being run: where it is, and a sentence to show. An
 * issue the contract names carries its code: what `workflowBlockIssues` refuses, and
 * `not_supported_yet` for what the file form holds and this engine does not run.
 */
export interface WorkflowDefinitionIssue {
  path: string;
  message: string;
  code?:
    | WorkflowBlockIssue["code"]
    | typeof WORKFLOW_OPERATION_NOT_CALLABLE
    | typeof WORKFLOW_LIMIT_ABOVE_CEILING
    | typeof WORKFLOW_OUTSIDE_NOT_EXPOSED
    | "process_workflow_write_operation";
}
