import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { ApiClient, ConfigAssetKind, ConfigAssetsOverview } from "@vivd-catalyst/api-client";

export interface AssetAddress {
  kind: ConfigAssetKind;
  name: string;
  /**
   * The version of the whole set, which the editor still passes. The asset operations check
   * the one asset instead, so it is not sent.
   */
  baseVersion?: number;
}

/**
 * The three writes of one asset, each made against the revision this client last read of it.
 * That is the revision in the overview the screens are drawn from, so a save over somebody
 * else's newer revision is answered with a conflict.
 */
export function createAssetWrites(input: {
  client: ApiClient;
  queryClient: QueryClient;
  /** The key the overview is cached under. */
  overviewKey: QueryKey;
}) {
  /** Undefined for an asset the overview does not hold: a put of it is a create. */
  const read = async (kind: ConfigAssetKind, name: string): Promise<number | undefined> => {
    const overview =
      input.queryClient.getQueryData<ConfigAssetsOverview>(input.overviewKey) ??
      (await input.queryClient.fetchQuery({
        queryKey: input.overviewKey,
        queryFn: () => input.client.config_assets.get_overview()
      }));
    return overview?.assets.find((asset) => asset.kind === kind && asset.name === name)?.revision;
  };
  // A delete and a revert always name a revision. Where the overview does not hold the asset,
  // its current revision is read.
  const current = async (kind: ConfigAssetKind, name: string): Promise<number> =>
    (await read(kind, name)) ??
    (await input.client.assets.get({ params: { kind, name } })).revision;
  return {
    put: async ({ kind, name, config }: AssetAddress & { config: Record<string, unknown> }) =>
      input.client.assets.put({
        params: { kind, name },
        body: { config, expectedRevision: await read(kind, name) }
      }),
    delete: async ({ kind, name }: AssetAddress) =>
      input.client.assets.delete({
        params: { kind, name },
        body: { expectedRevision: await current(kind, name) }
      }),
    revert: async ({ kind, name, revision }: AssetAddress & { revision: number }) =>
      input.client.assets.revert({
        params: { kind, name },
        body: { revision, expectedRevision: await current(kind, name) }
      })
  };
}
