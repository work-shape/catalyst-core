import {
  agentConfigSchema,
  connectionConfigSchema,
  agentToolReferenceLocations
} from "@vivd-catalyst/config-schema";
import { compiledActionsOf } from "@vivd-catalyst/app-build";
import {
  AppError,
  appActionOperationName,
  connectionOperationName,
  type OperationListScope
} from "@vivd-catalyst/core";
import { readDefinitionField, readDefinitionName } from "./asset-kinds/shared";
import { definitionsOf, type AssetSet, INVALID_ASSET_SET_MESSAGE } from "./asset-set";
import type { AssetWorkflowOptions } from "./types";

/** Agents explicitly submitted for validation, even when their content is unchanged. */
export interface AgentToolValidationTargets {
  names: readonly string[];
  scope: OperationListScope;
}

export interface AgentToolWarning {
  code: string;
  message: string;
}

/** Existence comes from the proposed asset set; live discovery only decides warnings. */
export async function findAgentToolValidation(
  options: AssetWorkflowOptions,
  validated: AssetSet,
  { names: agentNames, scope }: AgentToolValidationTargets
): Promise<{
  refusals: { agentName: string; error: AppError }[];
  warnings: AgentToolWarning[];
}> {
  const agents = definitionsOf(validated, "agent").flatMap((definition) =>
    agentNames.includes(readDefinitionName(definition) ?? "")
      ? [agentConfigSchema.parse(definition)]
      : []
  );
  const refs = options.configAssets.validationRefs;
  const names = [
    ...new Set(
      agents.flatMap((agent) =>
        agentToolReferenceLocations(agent, refs.enabledToolNames).map(({ name }) => name)
      )
    )
  ];
  const dataNames = names.filter((name) => !refs.enabledToolNames.includes(name));
  const dataTools =
    dataNames.length === 0
      ? []
      : ((await options.configAssets.dataTools?.describe(dataNames, scope)) ?? []);
  const existing = new Set(refs.enabledToolNames);
  for (const definition of definitionsOf(validated, "connection")) {
    const connection = connectionConfigSchema.parse(definition);
    for (const operation of connection.operations) {
      existing.add(connectionOperationName(connection.name, operation.name));
    }
  }
  for (const definition of definitionsOf(validated, "app")) {
    const name = readDefinitionName(definition);
    if (name === undefined) continue;
    for (const action of compiledActionsOf(readDefinitionField(definition, "manifest"))) {
      existing.add(appActionOperationName(name, action.name));
    }
  }
  // Other dynamic tool sources retain their own existence check.
  for (const { name } of dataTools) {
    if (!isStoredDataTool(name)) existing.add(name);
  }
  const callable = new Set([...refs.enabledToolNames, ...dataTools.map(({ name }) => name)]);
  const warnings: AgentToolWarning[] = [];
  const refusals = agents.flatMap((agent) => {
    const references = agentToolReferenceLocations(agent, refs.enabledToolNames);
    const issues = references
      .filter(
        ({ name }) =>
          !existing.has(name) ||
          (!isStoredDataTool(name) &&
            (refs.offToolModule?.(name) !== undefined ||
              refs.isToolAvailable?.(agent, name) === false))
      )
      .map(
        ({ name, location }) =>
          `Agent '${agent.name}' references unavailable tool '${name}' in ${location}`
      );
    for (const { name } of references) {
      if (
        existing.has(name) &&
        (!callable.has(name) ||
          refs.offToolModule?.(name) !== undefined ||
          refs.isToolAvailable?.(agent, name) === false) &&
        !warnings.some((warning) => warning.message === warningMessage(agent.name, name))
      ) {
        warnings.push({ code: "tool_not_callable", message: warningMessage(agent.name, name) });
      }
    }
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
  return { refusals, warnings };
}

function warningMessage(agent: string, name: string): string {
  return `Agent '${agent}' references tool '${name}' which exists but is not callable now`;
}

function isStoredDataTool(name: string): boolean {
  return name.startsWith("connection.") || name.startsWith("app.");
}
