import { agentConfigSchema, skillConfigSchema } from "@vivd-catalyst/config-schema";
import type {
  AgentConfig,
  ClientInstanceId,
  ConfigAssetSource,
  ConfigAssetStore,
  RuntimeAssetSnapshot,
  SkillConfig
} from "@vivd-catalyst/core";

export function createStaticConfigAssetSource(input: {
  agents?: AgentConfig[];
  skills?: SkillConfig[];
  defaultAgentName?: string;
  version?: number;
}): ConfigAssetSource {
  return {
    async getSnapshot(): Promise<RuntimeAssetSnapshot> {
      return {
        version: input.version ?? 1,
        defaultAgentName: input.defaultAgentName,
        agents: input.agents ?? [],
        skills: input.skills ?? []
      };
    }
  };
}

/** The stored agents and skills of the instance, read on every call as an assembly reads them. */
export function createStoredConfigAssetSource(input: {
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
