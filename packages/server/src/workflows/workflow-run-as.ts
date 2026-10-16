import {
  AppError,
  isAuthenticatedServicePrincipal,
  operationDenialError,
  type ActorAccess,
  type ApiAccessStore,
  type AuthenticatedIdentity,
  type ServicePrincipalRecord
} from "@work-shape/catalyst-core";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import { requireHeldRightsWithin } from "../access/held-rights-within";
import {
  RELEASE_KEY,
  principalRights,
  type PrincipalRightsOptions
} from "../access/principal-rights";

/** What the check reads: the principals of one instance by name, and the rights they hold. */
export interface WorkflowRunAsOptions extends PrincipalRightsOptions {
  apiAccess: Pick<ApiAccessStore, "findServicePrincipalByName">;
}

/**
 * Answers the service principal a Workflow names under `runAs`, for a caller who may let a
 * Workflow act as it. Making a revision live lends the principal's rights to everyone who
 * holds `workflow.use`, so the caller must hold every one of them (`requireHeldRights`): no
 * role and no right over principals stands in for that. A refusal names the first right the
 * caller lacks, and the asset only where the caller may read it. A principal holding the
 * release key is lent by nobody, superadmins included. A service principal
 * lends nothing. A test run of a draft lends nothing and does not ask this
 * (`workflowRunAsPrincipal`, ADR-0031).
 */
export async function requireWorkflowRunAs(
  options: WorkflowRunAsOptions,
  caller: { actor: AuthenticatedIdentity; access: ActorAccess },
  input: { workflow: string; runAs: unknown }
): Promise<ServicePrincipalRecord> {
  if (typeof input.runAs !== "string" || input.runAs === "") {
    throw new AppError(
      "VALIDATION_FAILED",
      `The Workflow '${input.workflow}' names no service principal under 'runAs'`,
      { reason: "run_as_missing" }
    );
  }
  if (isAuthenticatedServicePrincipal(caller.actor)) {
    throw operationDenialError({
      kind: "forbidden",
      reason: "user_only",
      message: `The Workflow '${input.workflow}' acts as the service principal '${input.runAs}', and a service principal lends no rights: a person publishes it`
    });
  }
  const principal = await workflowRunAsPrincipal(options, {
    workflow: input.workflow,
    runAs: input.runAs
  });
  const rights = await principalRights(options, principal.id);
  if (rights.some((right) => right.action === RELEASE_KEY)) {
    throw operationDenialError({
      kind: "forbidden",
      action: RELEASE_KEY,
      reason: "no_grant",
      message: `The Workflow '${input.workflow}' acts as '${principal.displayLabel}', which holds '${RELEASE_KEY}'. No Workflow runs as a principal that releases config, so nobody publishes it`
    });
  }
  await requireHeldRightsWithin(options, caller.access, rights, {
    lends: { label: principal.displayLabel }
  });
  return principal;
}

/**
 * The active service principal a Workflow names under `runAs`, without a right of the caller:
 * a test run of a draft is bounded by it and lends its grants to nobody (ADR-0031). Refuses a
 * name the instance does not have and a principal that is disabled, as a publish does.
 */
export async function workflowRunAsPrincipal(
  options: Pick<WorkflowRunAsOptions, "clientInstanceId" | "apiAccess">,
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
      { workflow: name, runAs: runAsOf(config) }
    );
  };
}
