import { AppError, type OperationAuthorizeContext } from "@work-shape/catalyst-core";
import type { PlatformAssetPut } from "@work-shape/catalyst-tool-execution";
import type { AssetWorkflow } from "../assets/asset-service";
import type { AssetWorkflowOptions } from "../types";

/** The same rights and definition checks as a write, before offering its confirmation. */
export async function authorizePlatformAssetPut(
  options: AssetWorkflowOptions,
  workflow: AssetWorkflow,
  target: { kind: string; name: string; workspaceId?: string },
  input: PlatformAssetPut,
  context: OperationAuthorizeContext
) {
  const kind = options.configAssets.kinds.require(target.kind);
  if (input.config === undefined && kind.representation === "config" && !kind.revisionFiles)
    throw new AppError(
      "VALIDATION_FAILED",
      "This asset needs a config definition before confirmation"
    );
  const write = {
    ...target,
    config: input.config,
    expectedRevision: input.expectedRevision ?? null
  };
  const decision = await workflow.authorizeRevisionWrite(context.access, write, "write");
  if (!decision.allowed)
    return decision.action === "agent_models.manage"
      ? {
          ...decision,
          message:
            "Changing model settings requires the right agent_models.manage, held by the Instance admin (superadmin) by default. Leave model settings out to use the default model."
        }
      : decision;
  if (input.config !== undefined) {
    if (input.config.name !== target.name)
      throw new AppError("VALIDATION_FAILED", "Config asset name must match the requested asset");
    const checked = await workflow.validate(
      {
        actor: context.actor,
        access: context.access,
        audit: options.auditRecorder,
        correlationId: context.correlationId
      },
      { ...target, config: input.config }
    );
    if (!checked.valid)
      throw new AppError(
        "VALIDATION_FAILED",
        `The asset definition is invalid: ${checked.issues.map((issue) => `${issue.path?.join(".") ?? "config"}: ${issue.message}`).join("; ")}`,
        { issues: checked.issues }
      );
  }

  return { allowed: true as const };
}
