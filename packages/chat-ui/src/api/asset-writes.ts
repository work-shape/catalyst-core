import type { ApiClient } from "@vivd-catalyst/api-client";

/** Where a new agent starts: everywhere, or in the shared workspace it was made in. */
export type AvailableIn = "all" | { workspaceId: string };

/** One asset as a write names it. */
interface AssetAddress {
  kind: string;
  name: string;
}

/**
 * The three writes of one asset. Each names the revision its caller loaded, so a write over
 * somebody else's newer revision is answered with a conflict. The caller holds that revision
 * with the form it was loaded into: nothing here looks a later one up.
 */
export function createAssetWrites(client: ApiClient) {
  return {
    /**
     * With `null` for the expected revision the call creates the asset. A new agent starts
     * where `availableIn` says, and hidden without it.
     */
    put: ({
      kind,
      name,
      config,
      expectedRevision,
      availableIn
    }: AssetAddress & {
      config: Record<string, unknown>;
      expectedRevision: number | null;
      availableIn?: AvailableIn;
    }) =>
      client.assets.put({
        params: { kind, name },
        body: { config, expectedRevision, ...(availableIn ? { availableIn } : {}) }
      }),
    delete: ({ kind, name, expectedRevision }: AssetAddress & { expectedRevision: number }) =>
      client.assets.delete({ params: { kind, name }, body: { expectedRevision } }),
    revert: ({
      kind,
      name,
      revision,
      expectedRevision
    }: AssetAddress & { revision: number; expectedRevision: number }) =>
      client.assets.revert({ params: { kind, name }, body: { revision, expectedRevision } })
  };
}
