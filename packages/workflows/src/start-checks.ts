import { workflowValueSchema } from "./dataset-schema";
import { compileJsonSchema } from "@work-shape/catalyst-connections";
import type {
  ApiAccessStore,
  ClientInstanceId,
  OperationRegistry,
  WorkflowManifest,
  WorkflowRun
} from "@work-shape/catalyst-core";
import { indexWorkflowSteps, type WorkflowDefinitionIssue } from "./definition";
import { secretOperationSteps } from "./operation-step";

// What keeps a published definition from being started by hand, asked without starting it.
// The start refuses for the same things under the same codes, one at a time; a list of the
// instance's Workflows asks here to say of each whether it can be started and, if not, why.

/** One thing a start by hand is refused for, under the code the refusal carries as `reason`. */
export interface WorkflowStartIssue {
  /**
   * A code of the definition's parser (`not_supported_yet`, `block_depth`,
   * `reference_out_of_scope`, `duplicate_step_id`, `operation_not_callable`, or
   * `definition_invalid` where the parser names none), or of the start: `no_manual_trigger`, `inputs_unreadable`,
   * `operation_secret`, `principal_inactive`, and of a code step's script:
   * `code_file_missing`, `code_file_too_large`, `code_file_invalid`. `operation_unknown` is the
   * one a start does not refuse for: the run would fail at that step with
   * `operation_not_found`.
   */
  code: string;
  /** A sentence of the product. Never a value of a run. */
  message: string;
  /** The technical account’s display label, when it still exists. */
  principalDisplayLabel?: string;
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
    /** The principal the definition runs as, as `workflowRunPrincipal` answers it. */
    principal: WorkflowRun["principal"] | undefined;
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
  if (!compileJsonSchema(workflowValueSchema(manifest.inputs, manifest.types)).ok) {
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
  if (!instance.principal) {
    const principal = await instance.principals.findServicePrincipalByName({
      clientInstanceId: instance.clientInstanceId,
      name: manifest.runAs ?? ""
    });
    issues.push({
      code: "principal_inactive",
      message: principal
        ? `The technical account ‘${principal.displayLabel}’ is disabled.`
        : "The technical account for this Workflow is unavailable.",
      ...(principal ? { principalDisplayLabel: principal.displayLabel } : {}),
      path: "runAs"
    });
  }
  return issues;
}
