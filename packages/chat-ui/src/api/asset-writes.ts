import type { ApiClient } from "@vivd-catalyst/api-client";

/** Where a new agent starts: everywhere, or in the shared workspace it was made in. */
export type AvailableIn = "all" | { workspaceId: string };

/** One asset as a write names it. Without a workspace it is one of the instance's own. */
interface AssetAddress {
  kind: string;
  name: string;
  /** The workspace that owns the asset. */
  workspaceId?: string;
}

function scopeOf(workspaceId: string | undefined): { workspaceId?: string } {
  return workspaceId === undefined ? {} : { workspaceId };
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
      workspaceId,
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
        body: {
          config,
          expectedRevision,
          ...scopeOf(workspaceId),
          ...(availableIn ? { availableIn } : {})
        }
      }),
    delete: ({
      kind,
      name,
      workspaceId,
      expectedRevision
    }: AssetAddress & { expectedRevision: number }) =>
      client.assets.delete({
        params: { kind, name },
        body: { expectedRevision, ...scopeOf(workspaceId) }
      }),
    revert: ({
      kind,
      name,
      workspaceId,
      revision,
      expectedRevision
    }: AssetAddress & { revision: number; expectedRevision: number }) =>
      client.assets.revert({
        params: { kind, name },
        body: { revision, expectedRevision, ...scopeOf(workspaceId) }
      })
  };
}
