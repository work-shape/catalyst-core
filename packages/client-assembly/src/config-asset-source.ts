import type {
  ClientInstanceId,
  ConfigAssetSource,
  ConfigAssetStore,
  RuntimeAssetSnapshot
} from "@vivd-catalyst/core";
import { agentConfigSchema, skillConfigSchema } from "@vivd-catalyst/config-schema";

export function createConfigAssetSource(input: {
  store: ConfigAssetStore;
  clientInstanceId: ClientInstanceId;
}): ConfigAssetSource {
  return {
    async getSnapshot(): Promise<RuntimeAssetSnapshot> {
      const [state, assets] = await Promise.all([
        input.store.getConfigAssetState({ clientInstanceId: input.clientInstanceId }),
        input.store.listActiveConfigAssets({ clientInstanceId: input.clientInstanceId })
      ]);
      return {
        version: state.version,
        defaultAgentName: state.defaultAgentName,
        agents: assets
          .filter((asset) => asset.kind === "agent")
          .map((asset) => agentConfigSchema.parse(asset.config)),
        skills: assets
          .filter((asset) => asset.kind === "skill")
          .map((asset) => skillConfigSchema.parse(asset.config))
      };
    }
  };
}
