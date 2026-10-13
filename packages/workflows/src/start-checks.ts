import { compileJsonSchema } from "@vivd-catalyst/connections";
import type {
  ApiAccessStore,
  ClientInstanceId,
  OperationRegistry,
  WorkflowManifest
} from "@vivd-catalyst/core";
import { indexWorkflowSteps, type WorkflowDefinitionIssue } from "./definition";
import { secretOperationSteps } from "./operation-step";
import { workflowRunPrincipal } from "./run-identity";

// What keeps a published definition from being started by hand, asked without starting it.
// The start refuses for the same things under the same codes, one at a time; a list of the
// instance's Workflows asks here to say of each whether it can be started and, if not, why.

/** One thing a start by hand is refused for, under the code the refusal carries as `reason`. */
export interface WorkflowStartIssue {
  /**
   * A code of the definition's parser (`not_supported_yet`, `block_depth`,
   * `reference_out_of_scope`, `duplicate_step_id`, or `definition_invalid` where the parser
   * names none), or of the start: `no_manual_trigger`, `inputs_unreadable`,
   * `operation_secret`, `principal_inactive`. `operation_unknown` is the one a start does not
   * refuse for: the run would fail at that step with `operation_not_found`.
   */
  code: string;
  /** A sentence of the product. Never a value of a run. */
  message: string;
  /** Where in the definition it is, where it is at one place. */
  path?: string;
}

/** The issues of a definition the parser refused, as a start names them. */
export function workflowDefinitionStartIssues(
  issues: readonly WorkflowDefinitionIssue[]
): WorkflowStartIssue[] {
  return issues.map(({ code, message, path }) => ({
    code: code ?? "definition_invalid",
    message,
    ...(path === "" ? {} : { path })
  }));
}

/**
 * Everything a start by hand of this definition is refused for before its input is read, in
 * the order the start asks. Empty for a definition a person may start now. A principal can be
 * disabled and an operation marked secret after a revision was published, so this is asked
 * when it is shown and never stored.
 */
export async function workflowStartIssues(
  manifest: WorkflowManifest,
  instance: {
    clientInstanceId: ClientInstanceId;
    principals: Pick<ApiAccessStore, "findServicePrincipalByName">;
    registry: Pick<OperationRegistry, "resolve">;
  }
): Promise<WorkflowStartIssue[]> {
  const issues: WorkflowStartIssue[] = [];
  const [trigger] = manifest.steps;
  if (trigger?.type !== "trigger" || !trigger.triggers.some(({ kind }) => kind === "manual")) {
    issues.push({
      code: "no_manual_trigger",
      message: `The Workflow '${manifest.id}' is not started by hand`
    });
  }
  if (!compileJsonSchema(manifest.inputs).ok) {
    issues.push({
      code: "inputs_unreadable",
      message: "The Workflow's inputs are a schema that cannot be checked",
      path: "inputs"
    });
  }
  // An operation the instance does not have now: a Connection that was removed, or a name
  // nothing registers. A start is accepted and its run fails at the step, so the list says it.
  for (const [id, { step }] of indexWorkflowSteps(manifest)) {
    if (step.type !== "operation" || (await instance.registry.resolve(step.operation))) continue;
    issues.push({
      code: "operation_unknown",
      message: `The operation '${step.operation}' does not exist on this instance`,
      path: `steps.${id}.operation`
    });
  }
  issues.push(...(await secretOperationSteps(manifest, instance.registry)));
  const principal = await workflowRunPrincipal(
    instance.principals,
    instance.clientInstanceId,
    manifest
  );
  if (!principal) {
    issues.push({
      code: "principal_inactive",
      message: `The instance has no active service principal named '${manifest.runAs}', which the Workflow '${manifest.id}' runs as`,
      path: "runAs"
    });
  }
  return issues;
}
