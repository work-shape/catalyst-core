import {
  asApiCredentialId,
  createPlatformId,
  type AuthenticatedIdentity,
  type OperationOrigin,
  type ServicePrincipalRecord,
  type WorkflowRunPrincipal
} from "@vivd-catalyst/core";
import { runOperation } from "@vivd-catalyst/tool-execution";
import { clientInstanceId, grantSchema } from "./access-instance";
import { fixture, operationOf } from "./connection-operations";

// What the tests of a service principal's grant rows stand on: a principal, who administers
// it, and a step of a Workflow Run that acts as it and calls a Connection.

const workflowRunId = createPlatformId<"WorkflowRunId">("wfr");
export const workflowOrigin: OperationOrigin = {
  kind: "workflow",
  workflowRunId,
  stepRunId: "wfstep_test"
};

/** A Connection whose one operation a step of a Workflow may call. */
export const forWorkflows = { operations: [operationOf("echo", { exposure: ["workflow"] })] };

/** The principal as a Workflow Run acts as it: no credential, the record's own permissions. */
export function runIdentity(
  principal: ServicePrincipalRecord,
  permissions: string[] = principal.permissions
): WorkflowRunPrincipal {
  return {
    kind: "service",
    id: principal.id,
    displayLabel: principal.displayLabel,
    permissionRefs: [],
    permissions,
    clientInstanceId,
    authSource: "workflow_run",
    scopes: ["*"],
    workflowRunId
  };
}

/** The principal as one of its keys authenticates it. */
export function keyIdentity(
  principal: ServicePrincipalRecord,
  permissions: string[] = principal.permissions
): AuthenticatedIdentity {
  return {
    kind: "service",
    id: principal.id,
    credentialId: asApiCredentialId("cred_test"),
    displayLabel: principal.displayLabel,
    permissionRefs: [],
    permissions,
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  };
}

export async function setup() {
  const t = await fixture();
  const principal = await t.stores.apiAccess.createServicePrincipal({
    clientInstanceId,
    name: "monthly-check",
    displayLabel: "Monthly check",
    permissions: ["config_assets.read"]
  });
  /** An administrator who holds `api_access.manage` and is no superadmin. */
  const ops = await t.stores.users.createUser({
    clientInstanceId,
    displayLabel: "Ops",
    roles: ["user", "admin"],
    permissions: ["api_access.manage"]
  });
  const payload = (assetId: string, overrides: Record<string, unknown> = {}) => ({
    holderKind: "service_principal",
    holderId: principal.id,
    action: "connection.use",
    scopeKind: "asset",
    scopeId: assetId,
    ...overrides
  });
  /** Written by the superadmin. Returns the grant id. */
  const grantTo = async (assetId: string) =>
    grantSchema.parse(
      (await t.expectOk(t.root.id, "permissions.grant", { payload: payload(assetId) })).json()
    ).id;
  /** A step of a run that acts as the principal calls the Connection's operation. */
  const step = (name: string, actor: AuthenticatedIdentity = runIdentity(principal)) => {
    t.executed.length = 0;
    return runOperation(
      {
        operation: `connection.${name}.echo`,
        effect: "reading",
        input: { text: "hello" },
        actor,
        origin: workflowOrigin,
        correlationId: "corr_step"
      },
      t.operationCalls.deps
    );
  };
  /** The rows on resources; the instance-wide rows its legacy list became stay out (AP-4). */
  const principalRows = () =>
    t.stores.access.listGrants({
      clientInstanceId,
      holderKind: "service_principal",
      excludeInstanceScope: true
    });
  return { t, principal, ops, payload, grantTo, step, principalRows };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

export const denied = (action: string, reason: string) => ({
  status: "denied",
  reason: { kind: "forbidden", action, reason }
});
