import {
  INSTANCE_ASSET_SCOPE,
  asCollaborationWorkspaceId,
  type AccessResource,
  type ActorAccess,
  type ApprovalFurtherRight,
  type AssetScope,
  type ClientInstanceId,
  type ConfigAssetStore,
  type JsonObject,
  type PlatformAction
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { accessResource } from "../assets/asset-access";
import { CONFIG_CHANGE_OPERATIONS } from "./connection-approval";

// `skill.approve` decides a proposed change of one skill: an agent's `skill_change` request and
// a person's held save or deletion of the skill. It is held on that skill, on what a workspace
// owns, or on the instance through `agent_skills.approve`. A request names the skill by its
// asset id as it was filed, so a skill deleted and made again under the same name is another
// skill. Deciding a change gives the approver no right to write the skill.

export const SKILL_APPROVE_ACTION: PlatformAction = "skill.approve";

const heldSubjectSchema = z.object({
  skillAssetId: z.string().min(1),
  skill: z.string().min(1),
  workspaceId: z.string().min(1).nullable()
});

const assetInputSchema = z.object({ kind: z.literal("skill"), name: z.string() });

/** The resource `skill.approve` is asked on for one stored skill, or for what a scope owns. */
export function skillApproveResource(
  name: string,
  scope: AssetScope,
  assetId: string | undefined
): AccessResource {
  return accessResource("skill", name, scope, assetId);
}

/** The scope a subject's `workspaceId` names. */
export function scopeOfWorkspace(workspaceId: string | null): AssetScope {
  return workspaceId === null
    ? INSTANCE_ASSET_SCOPE
    : { kind: "workspace", workspaceId: asCollaborationWorkspaceId(workspaceId) };
}

/**
 * The subject of the request a held call files, where the call saves or deletes one stored
 * skill. A call that creates a skill is about none yet: only `operations.approve` decides it.
 */
export async function heldSkillSubjectOf(
  input: { clientInstanceId: ClientInstanceId; store: Pick<ConfigAssetStore, "getConfigAsset"> },
  operation: string,
  callInput: unknown
): Promise<JsonObject | undefined> {
  if (!CONFIG_CHANGE_OPERATIONS.includes(operation)) return undefined;
  const asset = assetInputSchema.safeParse(callInput);
  if (!asset.success) return undefined;
  const stored = await input.store.getConfigAsset({
    clientInstanceId: input.clientInstanceId,
    kind: "skill",
    name: asset.data.name
  });
  return stored?.status === "active"
    ? {
        skillAssetId: stored.id,
        skill: stored.name,
        workspaceId: stored.scope.kind === "workspace" ? stored.scope.workspaceId : null
      }
    : undefined;
}

/** `skill.approve` on the skill a held call's subject names, or nothing. */
export function heldSkillApproveRight(
  subject: JsonObject | undefined
): ApprovalFurtherRight | undefined {
  const parsed = heldSubjectSchema.safeParse(subject);
  if (!parsed.success) return undefined;
  return {
    permission: SKILL_APPROVE_ACTION,
    resource: skillApproveResource(
      parsed.data.skill,
      scopeOfWorkspace(parsed.data.workspaceId),
      parsed.data.skillAssetId
    )
  };
}

/**
 * The active skills `access` holds `skill.approve` on, by asset id: nothing where it holds the
 * right nowhere. A deny on one skill leaves that skill out.
 */
export async function skillApproveAssets(
  input: {
    clientInstanceId: ClientInstanceId;
    store: Pick<ConfigAssetStore, "listActiveConfigAssets">;
  },
  access: ActorAccess
): Promise<{ id: string; scope: AssetScope }[]> {
  if (
    !access.authorize(SKILL_APPROVE_ACTION).allowed &&
    !access.holdsGrantAt(SKILL_APPROVE_ACTION, ["workspace", "asset"])
  )
    return [];
  const skills = await input.store.listActiveConfigAssets({
    clientInstanceId: input.clientInstanceId,
    kind: "skill"
  });
  return skills.filter(
    (skill) =>
      access.authorize(
        SKILL_APPROVE_ACTION,
        skillApproveResource(skill.name, skill.scope, skill.id)
      ).allowed
  );
}
