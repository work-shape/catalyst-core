import { WORKFLOWS_MODULE, WORKFLOW_KIND, offeredNowhere, type SeedApi } from "./api";
import { builder, type PersonKey } from "./company";
import type { SeedStep } from "./step";
import { readWorkflowFile } from "./workflows";

/**
 * An admin creates the initial drafts, then gives Kai rights on those exact assets. Kai
 * saves their next revision in his session. No grant gives him a broader creation right.
 * Existing drafts are left alone on later runs.
 */
export async function seedBuilder(
  root: SeedApi,
  as: (key: PersonKey) => Promise<SeedApi>,
  modules: Awaited<ReturnType<SeedApi["listModules"]>>,
  assetsDir: string,
  steps: SeedStep[],
  grantRights: () => Promise<void>
): Promise<void> {
  let created = 0;
  let existing = 0;
  const { agent } = builder;
  const createdDrafts: { kind: string; config: Record<string, unknown> & { name: string } }[] = [];
  if (await root.getAsset("agent", agent.name)) {
    existing += 1;
  } else {
    const config = { ...agent, skillNames: [] };
    await root.saveAsset("agent", config);
    createdDrafts.push({ kind: "agent", config });
    created += 1;
  }
  const { assets } = await root.assetsOverview();
  const stored = assets.find((asset) => asset.kind === "agent" && asset.name === agent.name);
  // The seed offers the agent everywhere, leaving an existing availability choice alone.
  if (stored && (created > 0 || offeredNowhere(stored.availability))) {
    await root.showAgentEverywhere(agent.name);
  }

  const module = modules.find((candidate) => candidate.name === WORKFLOWS_MODULE);
  const workflowsOn = module?.enabled === true && module.kinds.includes(WORKFLOW_KIND);
  if (workflowsOn) {
    if (await root.getAsset(WORKFLOW_KIND, builder.workflow)) {
      existing += 1;
    } else {
      const manifest = await readWorkflowFile(assetsDir, builder.workflow);
      const config = { name: builder.workflow, manifest };
      await root.saveAsset(WORKFLOW_KIND, config);
      createdDrafts.push({ kind: WORKFLOW_KIND, config });
      created += 1;
    }
  }
  await grantRights();
  for (const { kind, config } of createdDrafts) {
    await (await as(builder.person)).saveAsset(kind, config, 1);
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
