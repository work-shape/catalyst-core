import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readWorkflowManifest } from "@work-shape/catalyst-client-assembly";
import {
  CONNECTION_KIND,
  WORKFLOWS_MODULE,
  WORKFLOW_KIND,
  hasConnection,
  type SeedApi
} from "./api";
import { WORKFLOW_CONNECTIONS, workflowPrincipal, workflows } from "./company";

/** The definition of `seed/workflows/<name>/workflow.yaml`, as the engine reads it. */
export async function readWorkflowFile(
  assetsDir: string,
  name: string
): Promise<Record<string, unknown>> {
  const file = join(assetsDir, "workflows", name, "workflow.yaml");
  const read = readWorkflowManifest(await readFile(file, "utf8"));
  if (!read.ok) {
    throw new Error(`${file} is no definition the engine runs: ${read.issues[0]?.message}`);
  }
  return { ...read.manifest };
}

/**
 * The Workflows of the demo, on an instance with the module: the service principal they run
 * as, its right to use the Connection they read where the instance has it, and each definition
 * written from its `workflow.yaml` and published. The superadmin
 * publishes, because a publish lends the principal's rights to whoever may start the
 * Workflow. A Workflow the instance holds is left as it is, whatever was written since; one
 * an earlier run left unpublished is published. Answers nothing on an instance without the
 * module, which has no kind to write.
 */
export async function seedWorkflows(
  root: SeedApi,
  modules: Awaited<ReturnType<SeedApi["listModules"]>>,
  assetsDir: string
): Promise<{ name: string; created: number; existing: number } | undefined> {
  const module = modules.find((candidate) => candidate.name === WORKFLOWS_MODULE);
  if (module?.enabled !== true || !module.kinds.includes(WORKFLOW_KIND)) return undefined;
  const principals = await root.listServicePrincipals();
  const principal =
    principals.find((detail) => detail.principal.name === workflowPrincipal.name)?.principal ??
    (
      await root.createServicePrincipal({
        ...workflowPrincipal,
        permissions: [...workflowPrincipal.permissions]
      })
    ).principal;
  for (const connection of WORKFLOW_CONNECTIONS)
    await grantConnectionUse(root, modules, principal.id, connection);
  let created = 0;
  for (const name of workflows) {
    let stored = await root.getAsset(WORKFLOW_KIND, name);
    if (!stored) {
      await root.saveAsset(WORKFLOW_KIND, {
        name,
        manifest: await readWorkflowFile(assetsDir, name)
      });
      created += 1;
      stored = await root.getAsset(WORKFLOW_KIND, name);
    }
    if (!stored) throw new Error(`The instance has no Workflow '${name}' after writing it`);
    if (stored.publishedRevision === undefined) {
      await root.publishAsset(WORKFLOW_KIND, name, stored.revision);
    }
  }
  return { name: "workflows", created, existing: workflows.length - created };
}

/**
 * Lets the principal use the Connection the Workflows read, by one grant on that Connection, as
 * the superadmin writes one for a principal. Nothing where the instance has no such Connection:
 * the Workflows are stored all the same, and the list says their operations are missing.
 */
async function grantConnectionUse(
  root: SeedApi,
  modules: Awaited<ReturnType<SeedApi["listModules"]>>,
  principalId: string,
  connectionName: string
): Promise<void> {
  if (!(await hasConnection(root, modules, connectionName))) return;
  const connection = await root.getAsset(CONNECTION_KIND, connectionName);
  if (!connection) return;
  const grant: Parameters<SeedApi["grant"]>[0] = {
    holderKind: "service_principal",
    holderId: principalId,
    action: `${CONNECTION_KIND}.use`,
    effect: "allow",
    scopeKind: "asset",
    scopeId: connection.id
  };
  const there = (await root.listGrants()).some(
    (row) =>
      row.holderKind === grant.holderKind &&
      row.holderId === grant.holderId &&
      row.action === grant.action &&
      row.effect === grant.effect &&
      row.scopeKind === grant.scopeKind &&
      row.scopeId === grant.scopeId
  );
  if (!there) await root.grant(grant);
}
