import {
  AppError,
  WORKFLOW_ASSET_KIND,
  workflowRightsLacking,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import {
  resolveWorkflowNeededRights,
  checkChildContracts,
  checkChildCycles,
  indexWorkflowSteps,
  type WorkflowDefinitionSource
} from "@work-shape/catalyst-workflows";
import { workflowRunAccount, type WorkflowRightsOptions } from "./workflow-account-rights";

/**
 * Publish grants no new right: the parent's account must already be able to start each child.
 * The rights are those the publish screen lists (`workflowRightsOf`), so the two never differ.
 */
export async function checkPublishedChildren(
  options: WorkflowRightsOptions,
  manifest: WorkflowManifest,
  definitions: WorkflowDefinitionSource
): Promise<void> {
  // With the operations, as the save checks: a text in a Markdown field of an operation step
  // joins a list only where the field's schema is read (EW-TEXT).
  await checkChildContracts(manifest, definitions, options.registry?.());
  const account = await workflowRunAccount(options, manifest.runAs);
  if (manifest.runAs !== undefined && account?.principal.status !== "active")
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
  const needed = (await resolveWorkflowNeededRights(options, manifest)).filter(
    (right) => right.neededFor === "publish"
  );
  const [lacking] = account ? workflowRightsLacking(needed, account.access) : [];
  if (lacking?.asset.kind === WORKFLOW_ASSET_KIND)
    throw new AppError(
      "FORBIDDEN",
      `The parent's principal does not hold ${lacking.action} on the child`,
      { action: lacking.action, reason: "child_use_forbidden", workflow: lacking.asset.name }
    );
  // A right an operation needs at publish, such as sending mail as the instance's sender: the
  // account is given it on the publish screen, by someone who holds it (RIGHTS-1).
  if (lacking)
    throw new AppError(
      "FORBIDDEN",
      `The Workflow's account does not hold ${lacking.action} on '${lacking.asset.name}', which its steps need. Give it on the publish screen; only someone who holds the right can`,
      { action: lacking.action, reason: "no_grant" }
    );
  await checkChildCycles(manifest, definitions);
}
