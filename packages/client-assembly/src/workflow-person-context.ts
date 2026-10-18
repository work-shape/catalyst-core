import {
  connectionCallError,
  egressOriginOf,
  parseConnectionOperationName,
  type ClientInstanceId,
  type PlatformStores,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  indexWorkflowSteps,
  workflowRunPrincipal,
  type WorkflowDefinitionSource
} from "@work-shape/catalyst-workflows";

/** Publish checks each definition's own principal, including children; never the publisher. */
export async function checkWorkflowPersonContexts(
  deps: { clientInstanceId: ClientInstanceId; stores: PlatformStores },
  manifest: WorkflowManifest,
  definitions: WorkflowDefinitionSource,
  seen = new Set<string>()
): Promise<void> {
  if (seen.has(manifest.id)) return;
  seen.add(manifest.id);
  const principal = await workflowRunPrincipal(
    deps.stores.apiAccess,
    deps.clientInstanceId,
    manifest
  );
  for (const { step } of indexWorkflowSteps(manifest).values()) {
    if (step.type === "workflow") {
      const child = await definitions.read(step.workflow);
      if (child) await checkWorkflowPersonContexts(deps, child.manifest, definitions, seen);
    }
    if (step.type !== "operation") continue;
    const named = parseConnectionOperationName(step.operation);
    if (!named) continue;
    const asset = await deps.stores.configAssets.getConfigAsset({
      clientInstanceId: deps.clientInstanceId,
      kind: "connection",
      name: named.connection
    });
    const parsed = connectionConfigSchema.safeParse(asset?.config);
    if (!parsed.success || !asset || parsed.data.connectorType !== "http_api") continue;
    const { personContextHeader, baseUrl } = parsed.data.settings;
    if (typeof personContextHeader !== "string") continue;
    if (!principal || typeof baseUrl !== "string")
      throw connectionCallError("person_context_unmapped");
    const url = new URL(baseUrl);
    const origin = egressOriginOf({
      protocol: url.protocol === "https:" ? "https" : "http",
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80))
    });
    const binding = await deps.stores.connections.getConnectionPersonContext({
      clientInstanceId: deps.clientInstanceId,
      connectionAssetId: asset.id,
      subject: `person_context:service_principal:${principal.id}`
    });
    if (
      !binding ||
      binding.value === null ||
      binding.origin !== origin ||
      binding.header !== personContextHeader.toLowerCase()
    )
      throw connectionCallError("person_context_unmapped");
  }
}
