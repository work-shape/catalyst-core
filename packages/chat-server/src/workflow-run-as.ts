import {
  AppError,
  operationDenialError,
  type ActorAccess,
  type ApiAccessStore,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type ServicePrincipalRecord
} from "@vivd-catalyst/core";
import { authorizePrincipalAdministration } from "./api-access-administration-workflow";
import type { WorkflowAssetKind } from "./asset-kinds/shared";

/** What the check reads: the principals of one instance, by name. */
export interface WorkflowRunAsOptions {
  clientInstanceId: ClientInstanceId;
  apiAccess: Pick<ApiAccessStore, "findServicePrincipalByName">;
}

/**
 * Answers the service principal a Workflow names under `runAs`, for a caller who may let a
 * Workflow act as it. Making a revision live lends the principal's grants to everyone who
 * holds `workflow.use`, so it asks this, with the name of its operation. The caller needs
 * exactly what administering principals needs: no second rule exists. The right is asked
 * before the name is looked up, so a caller without it does not learn which names exist. A
 * test run of a draft lends nothing and does not ask it (`workflowRunAsPrincipal`, ADR-0031).
 */
export async function requireWorkflowRunAs(
  options: WorkflowRunAsOptions,
  caller: { actor: AuthenticatedIdentity; access: ActorAccess },
  input: { workflow: string; runAs: unknown; operation: string }
): Promise<ServicePrincipalRecord> {
  if (typeof input.runAs !== "string" || input.runAs === "") {
    throw new AppError(
      "VALIDATION_FAILED",
      `The Workflow '${input.workflow}' names no service principal under 'runAs'`,
      { reason: "run_as_missing" }
    );
  }
  const authorization = authorizePrincipalAdministration(caller, input.operation);
  if (!authorization.allowed) {
    throw operationDenialError({
      kind: "forbidden",
      action: authorization.action,
      reason: authorization.reason,
      message: `The Workflow '${input.workflow}' acts as the service principal '${input.runAs}'. Letting a Workflow act as a service principal needs what administering service principals needs`
    });
  }
  return workflowRunAsPrincipal(options, { workflow: input.workflow, runAs: input.runAs });
}

/**
 * The active service principal a Workflow names under `runAs`, without a right of the caller:
 * a test run of a draft is bounded by it and lends its grants to nobody (ADR-0031). Refuses a
 * name the instance does not have and a principal that is disabled, as a publish does.
 */
export async function workflowRunAsPrincipal(
  options: WorkflowRunAsOptions,
  input: { workflow: string; runAs: string }
): Promise<ServicePrincipalRecord> {
  const principal = await options.apiAccess.findServicePrincipalByName({
    clientInstanceId: options.clientInstanceId,
    name: input.runAs
  });
  if (!principal) {
    throw new AppError(
      "VALIDATION_FAILED",
      `The Workflow '${input.workflow}' acts as the service principal '${input.runAs}', and this instance has no service principal of that name`,
      { reason: "run_as_unknown", runAs: input.runAs }
    );
  }
  // A run never acts as a disabled principal, so no revision that names one goes live.
  if (principal.status !== "active") {
    throw new AppError(
      "VALIDATION_FAILED",
      `The Workflow '${input.workflow}' acts as the service principal '${input.runAs}', which is disabled`,
      { reason: "run_as_disabled", runAs: input.runAs }
    );
  }
  return principal;
}

/**
 * The `authorizeLive` of the Workflow kind: whoever makes a revision live may let a Workflow
 * act as the principal that revision names. `runAsOf` reads the name from the kind's config.
 */
export function createWorkflowLiveCheck(
  options: WorkflowRunAsOptions,
  runAsOf: (config: unknown) => unknown
): NonNullable<WorkflowAssetKind["authorizeLive"]> {
  return async ({ actor, access, name, config }) => {
    await requireWorkflowRunAs(
      options,
      { actor, access },
      { workflow: name, runAs: runAsOf(config), operation: "assets.publish" }
    );
  };
}
