import type {
  ApiAccessStore,
  ClientInstanceId,
  WorkflowManifest,
  WorkflowRun,
  WorkflowRunPrincipal
} from "@vivd-catalyst/core";

// Who a Workflow Run acts as. The one place of the engine that reads `runAs`: a definition
// names its principal by a name, which is the same on every instance, and a run keeps the id
// that name had when it started.

type Principals = Pick<ApiAccessStore, "getServicePrincipal" | "listServicePrincipals">;

/**
 * The service principal a definition names under `runAs`: the one active principal of the
 * instance with that label. A service principal has no other name than its label, and labels
 * are not unique, so a name that two active principals carry answers nothing: a run is
 * never started as a principal the definition does not single out.
 */
export async function workflowRunPrincipal(
  principals: Principals,
  clientInstanceId: ClientInstanceId,
  manifest: Pick<WorkflowManifest, "runAs">
): Promise<WorkflowRun["principal"] | undefined> {
  const named = (await principals.listServicePrincipals({ clientInstanceId })).filter(
    (record) => record.status === "active" && record.displayLabel === manifest.runAs
  );
  const [record] = named;
  if (!record || named.length !== 1) return undefined;
  return { id: record.id, displayLabel: record.displayLabel };
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
  const record = await principals.getServicePrincipal({
    clientInstanceId: run.clientInstanceId,
    servicePrincipalId: run.principal.id
  });
  if (!record || record.status !== "active") return undefined;
  return {
    kind: "service",
    id: record.id,
    workflowRunId: run.id,
    displayLabel: record.displayLabel,
    permissionRefs: record.permissionRefs,
    permissions: record.permissions,
    clientInstanceId: record.clientInstanceId,
    authSource: "workflow-run",
    correlationId: run.correlationId,
    // A run holds its principal's own grants and nothing a credential's scope would add.
    scopes: []
  };
}
