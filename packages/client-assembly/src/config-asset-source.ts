import type {
  ClientInstanceId,
  ConfigAssetSource,
  ConfigAssetStore,
  RuntimeAssetSnapshot
} from "@vivd-catalyst/core";
import {
  agentConfigSchema,
  skillConfigSchema,
  resolveStoredAgentReferences,
  type StoredAgentReferences
} from "@vivd-catalyst/config-schema";

export function createConfigAssetSource(input: {
  store: ConfigAssetStore;
  clientInstanceId: ClientInstanceId;
  references?: StoredAgentReferences;
  onUnavailable?(
    agentName: string,
    resolution: ReturnType<typeof resolveStoredAgentReferences>
  ): void;
}): ConfigAssetSource {
  const warned = new Set<string>();
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
      const skills = assets
        .filter((asset) => asset.kind === "skill")
        .map((asset) => skillConfigSchema.parse(asset.config));
      const skillNames = skills.map((skill) => skill.name);
      const agents = assets
        .filter((asset) => asset.kind === "agent")
        .flatMap((asset) => {
          const agent = agentConfigSchema.parse(asset.config);
          if (!input.references) return [agent];
          const resolved = resolveStoredAgentReferences(agent, skillNames, input.references);
          if (
            !warned.has(agent.name) &&
            (resolved.unavailableTools.length ||
              resolved.unavailableSkills.length ||
              resolved.unavailableModels.length)
          ) {
            warned.add(agent.name);
            input.onUnavailable?.(agent.name, resolved);
          }
          return resolved.chatAvailable ? [resolved.agent] : [];
        });
      const defaultAgentExcluded =
        assets.some((asset) => asset.kind === "agent" && asset.name === state.defaultAgentName) &&
        !agents.some((agent) => agent.name === state.defaultAgentName);
      return {
        version: state.version,
        defaultAgentName: defaultAgentExcluded ? agents[0]?.name : state.defaultAgentName,
        agents,
        skills
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
