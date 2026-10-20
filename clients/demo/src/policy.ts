import type {
  ClientInstanceApp,
  DefinedClientInstance
} from "@work-shape/catalyst-client-assembly";
import { getClientInstanceId } from "@work-shape/catalyst-config-schema";

type Operations = NonNullable<
  NonNullable<Parameters<DefinedClientInstance["listen"]>[0]>["operations"]
>;
type CentralPolicySettings = Awaited<ReturnType<NonNullable<Operations["centralPolicySettings"]>>>;

/** What the policy reads of the running instance: its config and its Shared Workspaces. */
export interface PolicyInstance {
  config: ClientInstanceApp["config"];
  store: { workspaces: Pick<ClientInstanceApp["store"]["workspaces"], "listSharedWorkspaces"> };
}

/** The Shared Workspace whose skills the demo holds for an approval. The seed creates it. */
export const HELD_SKILLS_WORKSPACE = "Personalwesen / HR";

/**
 * One setting per Shared Workspace of that name that holds a new or changed skill saved into
 * it through `assets.put`. A workspace id is known only once the workspace exists, so the
 * settings are read anew each time. None while the instance is not there yet.
 */
export async function heldSkillSaves(
  instance: PolicyInstance | undefined,
  workspaceName: string
): Promise<CentralPolicySettings> {
  if (!instance) return [];
  const workspaces = await instance.store.workspaces.listSharedWorkspaces({
    clientInstanceId: getClientInstanceId(instance.config)
  });
  return workspaces
    .filter((workspace) => workspace.name === workspaceName)
    .map((workspace): CentralPolicySettings[number] => ({
      operation: "assets.put",
      assetKind: "skill",
      workspaceId: workspace.id,
      value: "approval"
    }));
}

/**
 * The demo's one policy setting. A new or changed skill that is saved through `assets.put`
 * into the Shared Workspace `Personalwesen / HR` is held for an approval, for every caller,
 * admins and the superadmin included. It holds nothing else: not a delete, not a revert, not
 * a sync of the config CLI, not a skill of the instance or of another workspace, and nothing
 * at all while no workspace has that name. Whoever holds `operations.approve` decides a held
 * call, the caller too if they hold it.
 *
 * It gives the Inbox a registered operation to hold without a model call, which
 * `pnpm demo:seed` uses. No screen sets such a setting yet, so the demo's server names it.
 * `instance` answers the running instance once there is one.
 */
export function demoOperations(instance: () => PolicyInstance | undefined): Operations {
  return { centralPolicySettings: () => heldSkillSaves(instance(), HELD_SKILLS_WORKSPACE) };
}
