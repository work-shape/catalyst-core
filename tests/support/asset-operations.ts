import { z } from "zod";
import type { CollaborationWorkspaceId, ConfigAssetRecord } from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  skill,
  type AccessInstance,
  type AccessInstanceOptions
} from "./access-instance";

// What the tests of the asset operations share: the instance with one holder of rights in a
// Shared Workspace, and the shape of a page of the list.

export const assetPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      name: z.string(),
      title: z.string(),
      scope: z.object({ kind: z.string(), workspaceId: z.string().optional() }),
      revision: z.number()
    })
  ),
  nextCursor: z.string().optional()
});

export type AssetCall = Parameters<AccessInstance["call"]>;

/** The rights Kai holds on what Kai's workspace owns. */
const WORKSPACE_HOLDER_RIGHTS = [
  "agent.read",
  "agent.write",
  "agent.delete",
  "skill.read",
  "skill.write"
] as const;

export interface WorkspaceHolderInstance extends AccessInstance {
  /** The Shared Workspace whose assets Kai holds rights on. */
  kaiTeam: CollaborationWorkspaceId;
  /** A second Shared Workspace, in which nobody but the administrators holds a right. */
  lenaTeam: CollaborationWorkspaceId;
  /** Creates the asset as this user: the named workspace's, or the instance's without one. */
  put(
    userId: string,
    kind: "agent" | "skill",
    name: string,
    workspaceId?: string
  ): ReturnType<AccessInstance["expectOk"]>;
  /** The names on the page of the list this call answers. */
  names(...call: AssetCall): Promise<string[]>;
  stored(kind: string, name: string): Promise<ConfigAssetRecord | undefined>;
  /** Publishes the agent's draft as the administrator, as `publishAgentDraft` does, in its owner. */
  publishDraft(name: string, workspaceId?: string): Promise<void>;
}

/**
 * Kai holds every right on agents and the write right on skills on what `kaiTeam` owns, and
 * is no member of it; Lena holds nothing.
 */
export async function setupWorkspaceHolder(
  options: AccessInstanceOptions = {}
): Promise<WorkspaceHolderInstance> {
  const t = await setupAccessInstance(options);
  const kaiTeam = await t.sharedWorkspace("Kai's team");
  const lenaTeam = await t.sharedWorkspace("Lena's team");
  for (const action of WORKSPACE_HOLDER_RIGHTS) {
    await t.grant(t.kai.id, action, { workspaceId: kaiTeam });
  }
  const put = (userId: string, kind: "agent" | "skill", name: string, workspaceId?: string) =>
    t.expectOk(userId, "assets.put", {
      params: { kind, name },
      payload: {
        config: kind === "agent" ? agent(name) : skill(name),
        ...(workspaceId === undefined ? {} : { workspaceId })
      }
    });
  const names = async (...call: AssetCall) =>
    assetPageSchema.parse((await t.expectOk(...call)).json()).items.map((item) => item.name);
  const stored = (kind: string, name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  const publishDraft = async (name: string, workspaceId?: string) => {
    const scope = workspaceId === undefined ? {} : { workspaceId };
    const { draft } = z
      .object({ draft: z.object({ revision: z.number() }).nullable() })
      .parse(
        (
          await t.expectOk(t.admin.id, "agents.draft.get", { params: { name }, query: scope })
        ).json()
      );
    if (draft) {
      await t.expectOk(t.admin.id, "assets.publish", {
        params: { kind: "agent", name },
        payload: { revision: draft.revision, ...scope }
      });
    }
  };
  return { ...t, kaiTeam, lenaTeam, put, names, stored, publishDraft };
}
