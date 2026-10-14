import type { SeedApi } from "./api";
import { workspaceAssets, type PersonKey } from "./company";
import type { SeedStep } from "./step";

/**
 * The skill and the agent the company's workspace owns, saved by its owner as a save in the
 * workspace's Studio makes them: owned by the workspace, and the agent offered there. The
 * skill comes first, since the agent names it. An asset the workspace holds is left as it is.
 */
export async function seedWorkspaceAssets(
  as: (key: PersonKey) => Promise<SeedApi>,
  workspaceId: string,
  steps: SeedStep[]
): Promise<void> {
  const owner = await as(workspaceAssets.savedBy);
  let created = 0;
  const writes: { kind: string; config: Record<string, unknown> & { name: string } }[] = [
    { kind: "skill", config: workspaceAssets.skill },
    { kind: "agent", config: workspaceAssets.agent }
  ];
  for (const { kind, config } of writes) {
    if (await owner.getAsset(kind, config.name, workspaceId)) continue;
    await owner.saveAsset(kind, config, undefined, workspaceId);
    created += 1;
  }
  steps.push({ name: "workspace assets", created, existing: 2 - created });
}
