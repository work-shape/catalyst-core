import { WORKFLOWS_MODULE, WORKFLOW_KIND, type SeedApi } from "./api";
import { builder, type PersonKey } from "./company";
import type { SeedStep } from "./step";
import { readWorkflowFile } from "./workflows";

/**
 * What the member who builds made in his own Namespace, written in his session so each
 * carries his name: his agent, shown in every workspace as the seed shows every agent, and
 * his Workflow as a draft where the instance has the module. Runs after the grants, which
 * are what lets him write there. An asset the instance holds is left as it is.
 */
export async function seedBuilder(
  root: SeedApi,
  as: (key: PersonKey) => Promise<SeedApi>,
  modules: Awaited<ReturnType<SeedApi["listModules"]>>,
  assetsDir: string,
  steps: SeedStep[]
): Promise<void> {
  let created = 0;
  let existing = 0;
  const { agent } = builder;
  if (await root.getAsset("agent", agent.name)) {
    existing += 1;
  } else {
    await (await as(builder.person)).saveAsset("agent", { ...agent, skillNames: [] });
    created += 1;
  }
  const { assets } = await root.assetsOverview();
  const stored = assets.find((asset) => asset.kind === "agent" && asset.name === agent.name);
  if (stored && !stored.availability) await root.showAgentEverywhere(agent.name);

  const module = modules.find((candidate) => candidate.name === WORKFLOWS_MODULE);
  const workflowsOn = module?.enabled === true && module.kinds.includes(WORKFLOW_KIND);
  if (workflowsOn) {
    if (await root.getAsset(WORKFLOW_KIND, builder.workflow)) {
      existing += 1;
    } else {
      const manifest = await readWorkflowFile(assetsDir, builder.workflow);
      await (
        await as(builder.person)
      ).saveAsset(WORKFLOW_KIND, { name: builder.workflow, manifest });
      created += 1;
    }
  }
  steps.push({
    name: "builder assets",
    created,
    existing,
    ...(workflowsOn
      ? {}
      : { note: "This instance has no Workflows module, so Kai Berger's Workflow was left out." })
  });
}
