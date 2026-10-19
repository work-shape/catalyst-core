import { z } from "zod";
import type { ConfigAssetRecord } from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  setupAccessInstance,
  skill,
  type AccessInstance,
  type AccessInstanceOptions
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

/** Existing legacy-scoped sync protocol shared by current compatibility tests. */
export const prepareSyncPrefix = (t: AccessInstance, prefix: string) => t.createNamespace(prefix);
export const syncAssetsAtPrefix = (
  t: AccessInstance,
  userId: string,
  prefix: string,
  items: unknown[],
  headers = {}
) => t.call(userId, "assets.sync", { payload: { namespace: prefix, items }, headers });

/** Kai holds every right on agents and the write right on skills in `kai-`; Lena holds nothing. */
export async function setupNamespaceHolder(
  options: AccessInstanceOptions = {}
): Promise<NamespaceHolderInstance> {
  const t = await setupAccessInstance(options);
  await prepareSyncPrefix(t, "kai-");
  await prepareSyncPrefix(t, "lena-");
  for (const action of ["agent.read", "agent.write", "agent.delete", "skill.read", "skill.write"]) {
    await t.seedHistoricalGrant(t.kai.id, action, { namespace: "kai-" });
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
