import type {
  ApiAccessStore,
  AuditActor,
  ClientInstanceId,
  WorkflowManifest,
  WorkflowRun,
  WorkflowRunPrincipal
} from "@work-shape/catalyst-core";

// Who a Workflow Run acts as. The one place of the engine that reads `runAs`: a definition
// names its principal by its `name`, which is unique on the instance, never changes and is
// the same on every instance the definition moves to.

type Principals = Pick<ApiAccessStore, "findServicePrincipalByName">;

/**
 * The service principal a definition names under `runAs`, where it is active. Publishing a
 * revision refuses a principal that is disabled or missing; a principal disabled since then
 * answers nothing here, and no run is started as it.
 */
export async function workflowRunPrincipal(
  principals: Principals,
  clientInstanceId: ClientInstanceId,
  manifest: Pick<WorkflowManifest, "runAs">
): Promise<WorkflowRun["principal"] | undefined> {
  const record = await principals.findServicePrincipalByName({
    clientInstanceId,
    name: manifest.runAs
  });
  if (record?.status !== "active") return undefined;
  return { id: record.id, name: record.name, displayLabel: record.displayLabel };
}

/**
 * The identity every operation call of a run is made as: its service principal, as it is
 * stored when the step runs. A principal that was disabled or removed since the start
 * answers nothing, and the step fails. The rights of the call are the principal's grants,
 * which the call path reads for this identity; whoever started the run adds nothing.
 */
export async function workflowRunActor(
  principals: Principals,
  run: Pick<WorkflowRun, "id" | "clientInstanceId" | "principal" | "correlationId">
): Promise<WorkflowRunPrincipal | undefined> {
  const record = await principals.findServicePrincipalByName({
    clientInstanceId: run.clientInstanceId,
    name: run.principal.name
  });
  // A name is one principal's for good, so another id under it is not the run's principal.
  if (record?.status !== "active" || record.id !== run.principal.id) return undefined;
  return {
    kind: "service",
    id: record.id,
    workflowRunId: run.id,
    displayLabel: record.displayLabel,
    permissionRefs: record.permissionRefs,
    permissions: record.permissions,
    clientInstanceId: record.clientInstanceId,
    authSource: "workflow_run",
    correlationId: run.correlationId,
    // A run holds its principal's own grants and nothing a credential's scope would add.
    scopes: []
  };
}

/** The run's principal as the actor of what the engine itself writes to the audit. */
export function principalActor(run: Pick<WorkflowRun, "principal">): AuditActor {
  return {
    displayLabel: run.principal.displayLabel,
    roles: [],
    principalKind: "service",
    principalId: run.principal.id,
    principalDisplayLabel: run.principal.displayLabel
  };
}
