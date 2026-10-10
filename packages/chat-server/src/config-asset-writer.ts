import { AppError, type ConfigAssetStore } from "@vivd-catalyst/core";
import {
  assertSpendBudgetPricingCoverage,
  validateConfigAssetBundle
} from "@vivd-catalyst/config-schema";
import type { ConfigAssetBundle } from "./asset-kinds/shared";
import type { ChatServerOptions } from "./types";

export type ConfigAssetWriterOptions = Pick<
  ChatServerOptions,
  "config" | "configAssets" | "clientInstanceId"
>;
export function validateConfigAssetCandidate(
  options: ConfigAssetWriterOptions,
  input: ConfigAssetBundle
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
  const { kinds } = options.configAssets;
  for (const mutation of input.mutations) {
    if (mutation.type === "setDefaultAgent") {
      continue;
    }
    kinds.require(mutation.kind);
    // No registered kind is owned by a workspace yet. The first one that is lifts this.
    if (mutation.type === "upsert" && mutation.scope?.kind === "workspace") {
      throw new AppError("VALIDATION_FAILED", `A ${mutation.kind} cannot be owned by a workspace`, {
        reason: "invalid_scope"
      });
    }
  }
  const [state, assets] = await Promise.all([
    options.configAssets.store.getConfigAssetState({ clientInstanceId: options.clientInstanceId }),
    options.configAssets.store.listActiveConfigAssets({
      clientInstanceId: options.clientInstanceId
    })
  ]);
  const definitions = new Map(
    kinds.kinds.map((kind) => [
      kind.kind,
      new Map<string, unknown>(
        assets
          .filter((asset) => asset.kind === kind.kind)
          .map((asset) => [asset.name, asset.config])
      )
    ])
  );
  let defaultAgentName = state.defaultAgentName;
  for (const mutation of input.mutations) {
    if (mutation.type === "setDefaultAgent") {
      defaultAgentName = mutation.agentName;
      continue;
    }
    const ofKind = definitions.get(mutation.kind);
    if (mutation.type === "delete") {
      ofKind?.delete(mutation.name);
    } else {
      ofKind?.set(mutation.name, mutation.config);
    }
  }
  validateConfigAssetCandidate(
    options,
    kinds.kinds.reduce<ConfigAssetBundle>(
      (bundle, kind) =>
        kind.withDefinitions(bundle, [...(definitions.get(kind.kind)?.values() ?? [])]),
      { agents: [], skills: [], defaultAgentName }
    )
  );
  return options.configAssets.store.applyConfigAssetMutations(input);
}
