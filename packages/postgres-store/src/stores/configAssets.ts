import {
  AppError,
  type ConfigAssetRecord,
  type ConfigAssetRevisionRecord,
  type ConfigAssetState,
  type ConfigAssetStore
} from "@vivd-catalyst/core";
import {
  applyConfigAssetMutations as applyPostgresConfigAssetMutations,
  getConfigAsset as getPostgresConfigAsset,
  getConfigAssetState as getPostgresConfigAssetState,
  listActiveConfigAssets as listActivePostgresConfigAssets,
  listConfigAssetPage as listPostgresConfigAssetPage,
  listConfigAssetsByKey as listPostgresConfigAssetsByKey,
  listPublishedConfigAssets as listPublishedPostgresConfigAssets,
  getConfigAssetRevision as getPostgresConfigAssetRevision,
  listConfigAssetRevisions as listPostgresConfigAssetRevisions
} from "../postgres-config-asset-operations";
import {
  listAgentAvailability as listPostgresAgentAvailability,
  setAgentAvailability as setPostgresAgentAvailability
} from "../postgres-agent-availability";
import {
  discardConfigAssetDraft as discardPostgresConfigAssetDraft,
  publishConfigAssetRevision as publishPostgresConfigAssetRevision,
  removeConfigAsset as removePostgresConfigAsset
} from "../postgres-config-asset-pointers";
import {
  beginAssetRepoSave,
  getAssetCheckout,
  listAssetRepoBundles,
  nameAssetRepoSaveBundle
} from "../postgres-asset-repo-operations";
import { sweepAssetRepoSaves } from "../jobs/asset-repo-sweep";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresConfigAssetsStore(
  db: PostgresConnection,
  inTransaction = false
): ConfigAssetStore {
  // The row of a save says which object may be in the store, so it is written for itself and
  // at once. Inside a transaction a rollback would take the row and leave the object.
  const own = () => {
    if (inTransaction) {
      throw new AppError(
        "INTERNAL",
        "A save of a repository is begun, named and swept outside of a transaction"
      );
    }
    return db;
  };
  return {
    async getConfigAssetState(
      input: Parameters<ConfigAssetStore["getConfigAssetState"]>[0]
    ): Promise<ConfigAssetState> {
      return getPostgresConfigAssetState(db, input);
    },
    async listActiveConfigAssets(
      input: Parameters<ConfigAssetStore["listActiveConfigAssets"]>[0]
    ): Promise<ConfigAssetRecord[]> {
      return listActivePostgresConfigAssets(db, input);
    },
    async listConfigAssetPage(
      input: Parameters<ConfigAssetStore["listConfigAssetPage"]>[0]
    ): Promise<ConfigAssetRecord[]> {
      return listPostgresConfigAssetPage(db, input);
    },
    listPublishedConfigAssets: (input) => listPublishedPostgresConfigAssets(db, input),
    async getConfigAsset(
      input: Parameters<ConfigAssetStore["getConfigAsset"]>[0]
    ): Promise<ConfigAssetRecord | undefined> {
      return getPostgresConfigAsset(db, input);
    },
    async listConfigAssetRevisions(
      input: Parameters<ConfigAssetStore["listConfigAssetRevisions"]>[0]
    ): Promise<ConfigAssetRevisionRecord[]> {
      return listPostgresConfigAssetRevisions(db, input);
    },
    async getConfigAssetRevision(
      input: Parameters<ConfigAssetStore["getConfigAssetRevision"]>[0]
    ): Promise<ConfigAssetRevisionRecord | undefined> {
      return getPostgresConfigAssetRevision(db, input);
    },
    listConfigAssetsByKey: (input) => listPostgresConfigAssetsByKey(db, input),
    applyConfigAssetMutations: (input) => applyPostgresConfigAssetMutations(db, input),
    publishConfigAssetRevision: (input) => publishPostgresConfigAssetRevision(db, input),
    discardConfigAssetDraft: (input) => discardPostgresConfigAssetDraft(db, input),
    removeConfigAsset: (input) => removePostgresConfigAsset(db, input),
    listAssetRepoBundles: (input) => listAssetRepoBundles(db, input),
    beginAssetRepoSave: (input) => beginAssetRepoSave(own(), input),
    nameAssetRepoSaveBundle: (input) => nameAssetRepoSaveBundle(own(), input),
    sweepAssetRepoSaves: (input) => sweepAssetRepoSaves(own(), input),
    getAssetCheckout: (input) => getAssetCheckout(db, input),
    async listAgentAvailability(
      input: Parameters<ConfigAssetStore["listAgentAvailability"]>[0]
    ): ReturnType<ConfigAssetStore["listAgentAvailability"]> {
      return listPostgresAgentAvailability(db, input);
    },
    async setAgentAvailability(
      input: Parameters<ConfigAssetStore["setAgentAvailability"]>[0]
    ): ReturnType<ConfigAssetStore["setAgentAvailability"]> {
      return setPostgresAgentAvailability(db, input);
    }
  };
}
