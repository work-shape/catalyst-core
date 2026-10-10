import { z } from "zod";
import type { ConfigAssetRecord } from "@vivd-catalyst/core";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  skill,
  type AccessInstance
} from "./access-instance";

// What the tests of the asset operations share: the instance with one Namespace holder, and
// the shape of a page of the list.

export const assetPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      name: z.string(),
      title: z.string(),
      scope: z.object({ kind: z.string(), workspaceId: z.string().optional() }),
      namespace: z.string().optional(),
      revision: z.number()
    })
  ),
  nextCursor: z.string().optional()
});

export type AssetCall = Parameters<AccessInstance["call"]>;

export interface NamespaceHolderInstance extends AccessInstance {
  /** Creates the asset as this user. */
  put(
    userId: string,
    kind: "agent" | "skill",
    name: string
  ): ReturnType<AccessInstance["expectOk"]>;
  /** The names on the page of the list this call answers. */
  names(...call: AssetCall): Promise<string[]>;
  stored(kind: string, name: string): Promise<ConfigAssetRecord | undefined>;
}

/** Kai holds every right on agents and the write right on skills in `kai-`; Lena holds nothing. */
export async function setupNamespaceHolder(): Promise<NamespaceHolderInstance> {
  const t = await setupAccessInstance();
  await t.createNamespace("kai-");
  await t.createNamespace("lena-");
  for (const action of ["agent.read", "agent.write", "agent.delete", "skill.read", "skill.write"]) {
    await t.grant(t.kai.id, action, { namespace: "kai-" });
  }
  const put = (userId: string, kind: "agent" | "skill", name: string) =>
    t.expectOk(userId, "assets.put", {
      params: { kind, name },
      payload: { config: kind === "agent" ? agent(name) : skill(name) }
    });
  const names = async (...call: AssetCall) =>
    assetPageSchema.parse((await t.expectOk(...call)).json()).items.map((item) => item.name);
  const stored = (kind: string, name: string) =>
    t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  return { ...t, put, names, stored };
}
