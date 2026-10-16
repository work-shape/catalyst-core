import type {
  ClientInstanceId,
  ConfigAssetSource,
  ConfigAssetStore,
  RuntimeAssetSnapshot
} from "@work-shape/catalyst-core";
import {
  agentConfigSchema,
  formerAgentToolWarnings,
  skillConfigSchema,
  resolveStoredAgentReferences,
  type StoredAgentReferences
} from "@work-shape/catalyst-config-schema";

export function createConfigAssetSource(input: {
  store: ConfigAssetStore;
  clientInstanceId: ClientInstanceId;
  references?: StoredAgentReferences;
  onUnavailable?(
    agentName: string,
    resolution: ReturnType<typeof resolveStoredAgentReferences>
  ): void;
  /** A stored agent names former tool names: the warnings name the names that replaced them. */
  onFormerToolNames?(agentName: string, warnings: string[]): void;
}): ConfigAssetSource {
  const warned = new Set<string>();
  const warnedFormer = new Set<string>();
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
          const former = formerAgentToolWarnings(agent);
          if (former.length > 0 && !warnedFormer.has(agent.name)) {
            warnedFormer.add(agent.name);
            input.onFormerToolNames?.(agent.name, former);
          }
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
