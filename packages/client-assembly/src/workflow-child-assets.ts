import { AppError, workflowRightsLacking, type WorkflowManifest } from "@work-shape/catalyst-core";
import {
  checkChildContracts,
  checkChildCycles,
  indexWorkflowSteps,
  type WorkflowDefinitionSource
} from "@work-shape/catalyst-workflows";
import {
  workflowRightsOf,
  workflowRunAccount,
  type WorkflowRightsOptions
} from "./workflow-account-rights";

/**
 * Publish grants no new right: the parent's account must already be able to start each child.
 * The rights are those the publish screen lists (`workflowRightsOf`), so the two never differ.
 */
export async function checkPublishedChildren(
  options: WorkflowRightsOptions,
  manifest: WorkflowManifest,
  definitions: WorkflowDefinitionSource
): Promise<void> {
  await checkChildContracts(manifest, definitions);
  const account = await workflowRunAccount(options, manifest.runAs);
  if (account?.principal.status !== "active")
    throw new AppError("VALIDATION_FAILED", "The Workflow principal is unavailable", {
      reason: "run_as_unknown"
    });
  for (const { step } of indexWorkflowSteps(manifest).values()) {
    if (step.type !== "workflow") continue;
    const child = await definitions.read(step.workflow);
    const trigger = child?.manifest.steps[0];
    if (trigger?.type !== "trigger" || !trigger.triggers.some((t) => t.kind === "parent"))
      throw new AppError(
        "VALIDATION_FAILED",
        `The child Workflow '${step.workflow}' does not accept a parent`,
        { reason: "no_parent_trigger", workflow: step.workflow }
      );
  }
  const needed = (await workflowRightsOf(options, manifest)).filter(
    (right) => right.neededFor === "publish"
  );
  const [lacking] = workflowRightsLacking(needed, account.access);
  if (lacking)
    throw new AppError(
      "FORBIDDEN",
      `The parent's principal does not hold ${lacking.action} on the child`,
      { action: lacking.action, reason: "child_use_forbidden", workflow: lacking.asset.name }
    );
  await checkChildCycles(manifest, definitions);
}
