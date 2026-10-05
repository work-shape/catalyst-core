import { AppError, type ConfigAssetStore } from "@vivd-catalyst/core";
import {
  assertSpendBudgetPricingCoverage,
  validateConfigAssetBundle
} from "@vivd-catalyst/config-schema";
import type { ChatServerOptions } from "./types";

export type ConfigAssetWriterOptions = Pick<
  ChatServerOptions,
  "config" | "configAssets" | "clientInstanceId"
>;
export function validateConfigAssetCandidate(
  options: ConfigAssetWriterOptions,
  input: { agents: unknown[]; skills: unknown[]; defaultAgentName?: string }
) {
  const validated = validateConfigAssetBundle({
    ...input,
    refs: options.configAssets.validationRefs
  });
  assertSpendBudgetPricingCoverage(options.config, validated.agents);
  const issues = options.configAssets.validateAgents?.(validated.agents) ?? [];
  if (issues.length) {
    throw new AppError("VALIDATION_FAILED", "Config asset bundle is invalid", {
      issues: issues.map((message) => ({ message }))
    });
  }
  return validated;
}

/** Shared write path. Callers own authorization; all writes validate the resulting bundle. */
export async function applyValidatedConfigAssetMutations(
  options: ConfigAssetWriterOptions,
  input: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]
) {
  const [state, assets] = await Promise.all([
    options.configAssets.store.getConfigAssetState({ clientInstanceId: options.clientInstanceId }),
    options.configAssets.store.listActiveConfigAssets({
      clientInstanceId: options.clientInstanceId
    })
  ]);
  const agents = new Map<string, unknown>(
    assets.filter((asset) => asset.kind === "agent").map((asset) => [asset.name, asset.config])
  );
  const skills = new Map<string, unknown>(
    assets.filter((asset) => asset.kind === "skill").map((asset) => [asset.name, asset.config])
  );
  let defaultAgentName = state.defaultAgentName;
  for (const mutation of input.mutations) {
    if (mutation.type === "setDefaultAgent") {
      defaultAgentName = mutation.agentName;
      continue;
    }
    const assets = mutation.kind === "agent" ? agents : skills;
    if (mutation.type === "delete") {
      assets.delete(mutation.name);
    } else {
      assets.set(mutation.name, mutation.config);
    }
  }
  validateConfigAssetCandidate(options, {
    agents: [...agents.values()],
    skills: [...skills.values()],
    defaultAgentName
  });
  return options.configAssets.store.applyConfigAssetMutations(input);
}
