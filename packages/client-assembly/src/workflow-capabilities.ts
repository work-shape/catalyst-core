import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  connectionConfigSchema,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import {
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  GRANT_SCOPE_KINDS,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  type ActorAccess,
  type ClientInstanceId,
  type ConfigAssetStore,
  type ConnectorTypeDefinition,
  type OperationAuthorization
} from "@work-shape/catalyst-core";
import type { RouteRegistration } from "@work-shape/catalyst-server";
import {
  describeWorkflowCapabilities,
  renderWorkflowCapabilitiesPage,
  workflowCapabilityConnection,
  type WorkflowCapabilities,
  type WorkflowCapabilityConnection
} from "@work-shape/catalyst-workflows";
import type { RunnerPackageManifest } from "./runner-packages";

// `workflows.capabilities` (WF-FIT): what a Workflow can do on this instance, for whoever may
// write a Workflow somewhere. Runtime, ceilings and source bounds are the instance's; reach
// names only the Connections the caller may use.

/** Where the Connections of the list are read. */
export interface CapabilitySource {
  clientInstanceId: ClientInstanceId;
  stores: { configAssets: Pick<ConfigAssetStore, "listActiveConfigAssets"> };
}

/** What the list of one instance is made of, apart from the caller's Connections. */
export interface InstanceWorkflowCapabilities {
  config: ClientInstanceConfig["workflows"];
  codeSteps: WorkflowCapabilities["runtime"]["codeSteps"];
  packages: RunnerPackageManifest;
  connectorTypes: readonly ConnectorTypeDefinition[];
}

/** Whether the instance runs code steps: the command worker needs Execution Workspaces and a sandbox. */
export function codeStepAvailability(
  config: Pick<ClientInstanceConfig, "executionWorkspaces" | "infrastructure">
): WorkflowCapabilities["runtime"]["codeSteps"] {
  return config.executionWorkspaces.enabled && config.infrastructure.sandbox
    ? "available"
    : "no_sandbox";
}

/** The right to write a Workflow anywhere: on the instance's, or on some asset or workspace. */
function writesSomeWorkflow(access: ActorAccess): OperationAuthorization {
  const decision = access.authorize(WORKFLOW_ACTIONS.write, { kind: WORKFLOW_ASSET_KIND });
  if (
    decision.allowed ||
    access.holdsGrantAt(
      WORKFLOW_ACTIONS.write,
      GRANT_SCOPE_KINDS.filter((scope) => scope !== "instance")
    )
  )
    return { allowed: true };
  return { allowed: false, action: WORKFLOW_ACTIONS.write, reason: decision.reason };
}

/** The Connections the caller may use, as a Workflow reaches them. */
async function usableConnections(
  source: CapabilitySource,
  access: ActorAccess
): Promise<WorkflowCapabilityConnection[]> {
  const assets = await source.stores.configAssets.listActiveConfigAssets({
    clientInstanceId: source.clientInstanceId,
    kind: CONNECTION_ASSET_KIND
  });
  return assets.flatMap((asset) => {
    const usable = access.authorize(CONNECTION_ACTIONS.use, {
      kind: asset.kind,
      name: asset.name,
      assetId: asset.id,
      ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
    }).allowed;
    const parsed = connectionConfigSchema.safeParse(asset.config);
    return usable && parsed.success ? [workflowCapabilityConnection(parsed.data)] : [];
  });
}

/** The operation, registered with the module `workflows`. */
export function createWorkflowCapabilitiesRoute(
  source: CapabilitySource,
  instance: InstanceWorkflowCapabilities
): RouteRegistration {
  return (route) =>
    route.operation(apiOperations["workflows.capabilities"], {
      authorize: (_input, { access }) => writesSomeWorkflow(access),
      module: "workflows",
      execute: async (_input, { access }) =>
        describeWorkflowCapabilities({
          config: instance.config,
          codeSteps: instance.codeSteps,
          packages: instance.packages,
          connections: await usableConnections(source, access),
          connectorTypes: instance.connectorTypes
        })
    });
}

/**
 * The page "What a Workflow can do" with the instance's own values, for the platform docs it
 * ships. Reach there is the Connector types; which Connections a reader may use is the list's.
 */
export function instanceWorkflowCapabilitiesPage(instance: InstanceWorkflowCapabilities): string {
  return renderWorkflowCapabilitiesPage(
    describeWorkflowCapabilities({ ...instance, connections: [] }),
    "instance"
  );
}
