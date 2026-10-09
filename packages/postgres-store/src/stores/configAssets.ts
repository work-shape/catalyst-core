import {
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
  listAgentAvailability as listPostgresAgentAvailability,
  listConfigAssetRevisions as listPostgresConfigAssetRevisions,
  setAgentAvailability as setPostgresAgentAvailability
} from "../postgres-config-asset-operations";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresConfigAssetsStore(db: PostgresConnection): ConfigAssetStore {
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
    async applyConfigAssetMutations(
      input: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]
    ): Promise<{ version: number }> {
      return applyPostgresConfigAssetMutations(db, input);
    },
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
