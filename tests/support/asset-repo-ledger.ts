import { expect } from "vitest";
import {
  assetRepoBundleObjectKey,
  createPlatformId,
  isAppError,
  type AssetRepoSaveBundle,
  type AssetRepoWrite,
  type ConfigAssetStore,
  type OperationRunId
} from "@work-shape/catalyst-core";
import type { usePostgresSuite } from "./postgres-suite";

// What the tests of the ledger of asset repositories share: one asset on a client instance of
// its own and the steps a save of it takes, against the real store.

export const oid = (seed: string) => seed.repeat(40).slice(0, 40);
export const sha = (seed: string) => seed.repeat(64).slice(0, 64);
export const runId = () => createPlatformId<"OperationRunId">("oprun");
export const FAR_FUTURE = new Date("2100-01-01T00:00:00Z");

export async function refusalOf(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    if (isAppError(error)) {
      const details: unknown = error.details;
      return {
        code: error.code,
        ...(typeof details === "object" && details !== null ? details : {})
      };
    }
    throw error;
  }
  throw new Error("Expected a refusal");
}

export interface Base {
  revision: number | null;
  commit: string | null;
}

/** What a test says of one save beyond its base and its commit. */
export interface SaveOptions {
  run?: OperationRunId;
  tree?: string;
  /** What the save names of its bundle, where that is not what the commit and the base give. */
  bundle?: Partial<AssetRepoSaveBundle>;
  checkout?: AssetRepoWrite["checkout"];
  validate?: () => Promise<void>;
  /** What the object store answers for the size of an object. By default every bundle is there. */
  objectSize?: (objectKey: string) => Promise<number | undefined>;
}

/** One asset on a client instance of its own, and the steps a save of it takes. */
export function arrangeAssetRepo(
  db: ReturnType<typeof usePostgresSuite>,
  label: string,
  kind = "app",
  clientInstanceId = db.clientInstance(label)
) {
  const name = "rates";
  const assetId = createPlatformId("cfga");
  const address = { clientInstanceId, kind, name };
  const bundleOf = (base: Base, commit: string, more: Partial<AssetRepoSaveBundle> = {}) => {
    const named = {
      kind: base.commit === null ? ("full" as const) : ("incremental" as const),
      tipCommit: commit,
      ...(base.commit === null ? {} : { prerequisiteCommit: base.commit }),
      bytes: 100,
      sha256: sha("5"),
      ...more
    };
    return {
      objectKey: assetRepoBundleObjectKey({ assetId, commit, sha256: named.sha256 }),
      ...named
    };
  };
  /** The first two steps of a save: the pending row, then the name of its bundle. */
  const pend = async (
    store: ConfigAssetStore,
    base: Base,
    commit: string,
    more: SaveOptions = {}
  ) => {
    const operationRunId = more.run ?? runId();
    const save = { clientInstanceId, assetId, operationRunId };
    const begun = await store.beginAssetRepoSave(save);
    const bundle = bundleOf(base, commit, more.bundle);
    await store.nameAssetRepoSaveBundle({ ...save, bundle });
    return { operationRunId, savedAt: begun.savedAt, bundle };
  };
  /** The last step: the transaction that makes `commit` the draft, as a save that read `base`. */
  const settle = (
    store: ConfigAssetStore,
    base: Base,
    commit: string,
    operationRunId: OperationRunId,
    more: SaveOptions = {}
  ) => {
    const { objectKey, sha256, bytes } = bundleOf(base, commit, more.bundle);
    return store.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [`${kind}:${name}`]: base.revision },
      ...(more.validate ? { validate: more.validate } : {}),
      repositoryObjectSize: more.objectSize ?? (() => Promise.resolve(bytes)),
      mutations: [
        {
          type: "upsert",
          kind,
          name,
          config: { name },
          draft: true,
          assetId,
          repository: {
            commit,
            tree: more.tree ?? oid("e"),
            baseCommit: base.commit,
            operationRunId,
            bundle: { objectKey, sha256, bytes },
            ...(more.checkout ? { checkout: more.checkout } : {})
          }
        }
      ]
    });
  };
  /** A whole save. */
  const save = async (
    store: ConfigAssetStore,
    base: Base,
    commit: string,
    more: SaveOptions = {}
  ) => {
    const { operationRunId } = await pend(store, base, commit, more);
    return settle(store, base, commit, operationRunId, more);
  };
  const bundles = () => db.store.configAssets.listAssetRepoBundles({ clientInstanceId, assetId });
  const revisions = () => db.store.configAssets.listConfigAssetRevisions(address);
  const draft = () => db.store.configAssets.getConfigAsset(address);
  /** One pass of the sweeper. Answers the objects of this asset it removed. */
  const sweep = async (olderThan = FAR_FUTURE, fail = false) => {
    const removed: string[] = [];
    const pass = db.store.configAssets.sweepAssetRepoSaves({
      olderThan,
      limit: 1000,
      removeObject: (object) => {
        if (object.assetId !== assetId) return Promise.resolve();
        if (fail) return Promise.reject(new Error("the store is away"));
        removed.push(object.objectKey);
        return Promise.resolve();
      }
    });
    await (fail ? expect(pass).rejects.toThrow("the store is away") : pass);
    return removed;
  };
  /** The rows of this asset, as the table holds them. */
  const rows = () =>
    db.sql<{ state: string; object_key: string | null }[]>`
      select state, object_key from asset_repo_bundles where asset_id = ${assetId} order by created_at, object_key`;
  return {
    clientInstanceId,
    assetId,
    address,
    bundleOf,
    pend,
    settle,
    save,
    bundles,
    revisions,
    draft,
    sweep,
    rows
  };
}
