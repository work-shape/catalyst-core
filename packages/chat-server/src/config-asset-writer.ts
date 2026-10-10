import { AppError, type ConfigAssetStore } from "@vivd-catalyst/core";
import { assetSetOf, validateAssetSet, withDefaultAgentName, type AssetSet } from "./asset-set";
import { readDefinitionName } from "./asset-kinds/shared";
import type { ChatServerOptions } from "./types";

export type ConfigAssetWriterOptions = Pick<
  ChatServerOptions,
  "config" | "configAssets" | "clientInstanceId"
>;

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
  const stored = assetSetOf(assets, state.defaultAgentName);
  const definitions = new Map(
    [...stored.definitions].map(([kind, ofKind]) => [
      kind,
      new Map(ofKind.map((config) => [readDefinitionName(config), config]))
    ])
  );
  let defaultAgentName = state.defaultAgentName;
  for (const mutation of input.mutations) {
    if (mutation.type === "setDefaultAgent") {
      defaultAgentName = mutation.agentName;
      continue;
    }
    const ofKind = definitions.get(mutation.kind) ?? new Map<string | undefined, unknown>();
    definitions.set(mutation.kind, ofKind);
    if (mutation.type === "delete") {
      ofKind.delete(mutation.name);
    } else {
      ofKind.set(mutation.name, mutation.config);
    }
  }
  const candidate: AssetSet = withDefaultAgentName(
    {
      definitions: new Map([...definitions].map(([kind, ofKind]) => [kind, [...ofKind.values()]]))
    },
    defaultAgentName
  );
  validateAssetSet(kinds.kinds, candidate, stored);
  return options.configAssets.store.applyConfigAssetMutations(input);
}
