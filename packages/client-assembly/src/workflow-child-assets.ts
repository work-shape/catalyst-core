import {
  AppError,
  createActorAccess,
  type ConfigAssetStore,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import type { WorkflowRunAsOptions } from "@work-shape/catalyst-server";
import {
  checkChildContracts,
  checkChildCycles,
  indexWorkflowSteps,
  type WorkflowDefinitionSource
} from "@work-shape/catalyst-workflows";

/** Publish grants no new right: the parent's account must already be able to start each child. */
export async function checkPublishedChildren(
  options: WorkflowRunAsOptions & {
    configAssets: Pick<ConfigAssetStore, "getConfigAsset" | "listPublishedConfigAssets">;
  },
  manifest: WorkflowManifest,
  definitions: WorkflowDefinitionSource
): Promise<void> {
  await checkChildContracts(manifest, definitions);
  const principal = await options.apiAccess.findServicePrincipalByName({
    clientInstanceId: options.clientInstanceId,
    name: manifest.runAs
  });
  if (principal?.status !== "active")
    throw new AppError("VALIDATION_FAILED", "The Workflow principal is unavailable", {
      reason: "run_as_unknown"
    });
  // Use the ordinary authorizer for the account, with no credential scope or starter rights.
  const access = createActorAccess(
    {
      kind: "service_principal",
      id: principal.id,
      clientInstanceId: options.clientInstanceId,
      roles: [],
      permissionRefs: principal.permissionRefs
    },
    await options.access.loadPersistedAccess({
      clientInstanceId: options.clientInstanceId,
      holder: { kind: "service_principal", id: principal.id }
    })
  );
  for (const { step } of indexWorkflowSteps(manifest).values()) {
    if (step.type !== "workflow") continue;
    const child = await definitions.read(step.workflow);
    const trigger = child?.manifest.steps[0];
    if (trigger?.type !== "trigger" || !trigger.triggers.some((t) => t.kind === "parent"))
      throw new AppError(
        "VALIDATION_FAILED",
        `The child Workflow '${step.workflow}' does not accept a parent`,
        { reason: "no_parent_trigger" }
      );
    const asset = await options.configAssets.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: "workflow",
      name: step.workflow
    });
    const decision = access.authorize("workflow.use", {
      kind: "workflow",
      name: step.workflow,
      ...(asset ? { assetId: asset.id } : {})
    });
    if (!decision.allowed)
      throw new AppError(
        "FORBIDDEN",
        "The parent's principal does not hold workflow.use on the child",
        { action: "workflow.use", reason: "child_use_forbidden" }
      );
  }
  await checkChildCycles(manifest, definitions);
}
