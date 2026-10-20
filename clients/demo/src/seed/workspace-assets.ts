import type { SeedApi } from "./api";
import { heldSkillChange, hrWorkspace, workspaceAssets, type PersonKey } from "./company";
import type { SeedStep } from "./step";

/**
 * What the seeded workspaces own of their own.
 *
 * The company's workspace: a skill and an agent, saved by its owner as a save in the
 * workspace's Studio makes them, owned by the workspace, and the agent offered there. The
 * skill comes first, since the agent names it. An asset the workspace holds is left as it is.
 *
 * The HR workspace: the skill whose paragraph a held call changes, written by its owner in a
 * sync batch that names the workspace, as a push of a CLI root bound to it does. The demo holds
 * a save of a skill there and not a sync. A skill that differs from the seed's is set back, so
 * the held change can be asked for again.
 */
export async function seedWorkspaceAssets(
  as: (key: PersonKey) => Promise<SeedApi>,
  workspaceId: string,
  hrWorkspaceId: string,
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

  const hrOwner = await as(hrWorkspace.createdBy);
  const { skill } = heldSkillChange;
  const stored = await hrOwner.getAsset("skill", skill.name, hrWorkspaceId);
  const same =
    stored !== undefined &&
    (["title", "description", "content"] as const).every(
      (field) => stored.config[field] === skill[field]
    );
  if (!same) {
    const outcome = await hrOwner.syncWorkspaceSkills(hrWorkspaceId, [
      { config: skill, expectedRevision: stored?.revision ?? null }
    ]);
    if (outcome === "pending_approval") {
      throw new Error(`The instance holds the sync of the skill '${skill.name}' for an approval`);
    }
    created += 1;
  }
  steps.push({ name: "workspace assets", created, existing: writes.length + 1 - created });
}
