import type {
  AgentConfig,
  ConfigAssetSource,
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
