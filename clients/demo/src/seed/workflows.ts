import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readWorkflowManifest } from "@vivd-catalyst/client-assembly";
import { WORKFLOWS_MODULE, WORKFLOW_KIND, type SeedApi } from "./api";
import { workflowPrincipal, workflows } from "./company";

/**
 * The Workflows of the demo, on an instance with the module: the service principal they run
 * as, and each definition written from its `workflow.yaml` and published. The superadmin
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
  if (!principals.some(({ principal }) => principal.name === workflowPrincipal.name)) {
    await root.createServicePrincipal({
      ...workflowPrincipal,
      permissions: [...workflowPrincipal.permissions]
    });
  }
  let created = 0;
  for (const name of workflows) {
    let stored = await root.getAsset(WORKFLOW_KIND, name);
    if (!stored) {
      const file = join(assetsDir, "workflows", name, "workflow.yaml");
      const read = readWorkflowManifest(await readFile(file, "utf8"));
      if (!read.ok) {
        throw new Error(`${file} is no definition the engine runs: ${read.issues[0]?.message}`);
      }
      await root.saveAsset(WORKFLOW_KIND, { name, manifest: { ...read.manifest } });
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
