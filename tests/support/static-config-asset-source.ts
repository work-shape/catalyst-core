import { createConfigAssetSource } from "@vivd-catalyst/client-assembly";
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
    },
    async getSkill(name) {
      return input.skills?.find((skill) => skill.name === name);
    }
  };
}

/** The stored agents and skills of the instance, read on every call as an assembly reads them. */
export function createStoredConfigAssetSource(input: {
  store: ConfigAssetStore;
  clientInstanceId: ClientInstanceId;
}): ConfigAssetSource {
  return createConfigAssetSource(input);
}
