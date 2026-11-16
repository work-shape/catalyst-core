import { workflowStepsDeep, type WorkflowManifest } from "@work-shape/catalyst-core";
import { WORKFLOW_MODEL_NOT_AVAILABLE, type WorkflowDefinitionIssue } from "./definition-issue";

/**
 * The agent steps whose `model` names a binding agents may not select on the instance: one that
 * does not exist, an embedding binding or one marked `agentSelectable: false`. Asked at save and
 * at publish; `selectable` is the instance's agent-selectable binding ids.
 */
export function workflowAgentModelIssues(
  manifest: WorkflowManifest,
  selectable: readonly string[]
): WorkflowDefinitionIssue[] {
  return [...workflowStepsDeep(manifest.steps)].flatMap((step) =>
    step.type === "agent" && typeof step.model === "string" && !selectable.includes(step.model)
      ? [
          {
            code: WORKFLOW_MODEL_NOT_AVAILABLE,
            path: `steps.${step.id}.model`,
            message: `The agent step '${step.id}' names the model binding '${step.model}', which agents may not select on this instance (${WORKFLOW_MODEL_NOT_AVAILABLE})`
          }
        ]
      : []
  );
}
