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
      // Read for every turn and tool call: the skills come without their resources, which the
      // store leaves out before they are read, and `getSkill` reads when a call needs them.
      const [state, assets] = await Promise.all([
        input.store.getConfigAssetState({ clientInstanceId: input.clientInstanceId }),
        input.store.listActiveConfigAssets({
          clientInstanceId: input.clientInstanceId,
          withoutSkillResources: true
        })
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
    },
    async getSkill(name) {
      const asset = await input.store.getConfigAsset({
        clientInstanceId: input.clientInstanceId,
        kind: "skill",
        name
      });
      return asset?.status === "active" ? skillConfigSchema.parse(asset.config) : undefined;
    }
  };
}
