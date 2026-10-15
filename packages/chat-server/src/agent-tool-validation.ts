import {
  agentConfigSchema,
  agentToolReferenceLocations,
  findAgentToolReferenceIssues
} from "@vivd-catalyst/config-schema";
import { AppError, type OperationListScope } from "@vivd-catalyst/core";
import { readDefinitionName } from "./asset-kinds/shared";
import { definitionsOf, type AssetSet, INVALID_ASSET_SET_MESSAGE } from "./asset-set";
import type { AssetWorkflowOptions } from "./types";

/** Agents explicitly submitted for validation, even when their content is unchanged. */
export interface AgentToolValidationTargets {
  names: readonly string[];
  scope: OperationListScope;
}

/** Check explicit references against the enabled registry and the live data-tool sources. */
export async function findUnavailableAgentToolRefusals(
  options: AssetWorkflowOptions,
  validated: AssetSet,
  { names: agentNames, scope }: AgentToolValidationTargets
): Promise<{ agentName: string; error: AppError }[]> {
  const agents = definitionsOf(validated, "agent").flatMap((definition) =>
    agentNames.includes(readDefinitionName(definition) ?? "")
      ? [agentConfigSchema.parse(definition)]
      : []
  );
  const refs = options.configAssets.validationRefs;
  const names = [
    ...new Set(
      agents.flatMap((agent) => agentToolReferenceLocations(agent).map(({ name }) => name))
    )
  ];
  const dataNames = names.filter((name) => !refs.enabledToolNames.includes(name));
  const dataTools =
    dataNames.length === 0
      ? []
      : ((await options.configAssets.dataTools?.describe(dataNames, scope)) ?? []);
  const offered = new Set([...refs.enabledToolNames, ...dataTools.map(({ name }) => name)]);
  return agents.flatMap((agent) => {
    const enabledToolNames = agentToolReferenceLocations(agent)
      .map(({ name }) => name)
      .filter(
        (name) =>
          offered.has(name) &&
          refs.offToolModule?.(name) === undefined &&
          refs.isToolAvailable?.(agent, name) !== false
      );
    const issues = findAgentToolReferenceIssues({ agents: [agent], enabledToolNames });
    return issues.length === 0
      ? []
      : [
          {
            agentName: agent.name,
            error: new AppError("VALIDATION_FAILED", INVALID_ASSET_SET_MESSAGE, {
              issues: issues.map((message) => ({ message }))
            })
          }
        ];
  });
}
