import {
  AppError,
  type AssetScope,
  type ConfigAssetStore,
  type RegisteredAssetKind
} from "@vivd-catalyst/core";
import { assetSetOf, validateAssetSet, withDefaultAgentName, type AssetSet } from "./asset-set";
import { readDefinitionName } from "./asset-kinds/shared";
import type { ChatServerOptions } from "./types";

export type ConfigAssetWriterOptions = Pick<
  ChatServerOptions,
  "config" | "configAssets" | "clientInstanceId"
>;

/**
 * Whether the owner a write names can own an asset of the kind. A kind says who may own it;
 * without a word of its own that is the instance alone.
 */
export function assertScopeCanOwn(
  kind: Pick<RegisteredAssetKind, "kind" | "owners">,
  scope: AssetScope
): void {
  if (kind.owners.includes(scope.kind)) {
    return;
  }
  if (scope.kind === "workspace") {
    throw new AppError("VALIDATION_FAILED", `A ${kind.kind} cannot be owned by a workspace`, {
      reason: "invalid_scope"
    });
  }
  throw new AppError(
    "VALIDATION_FAILED",
    `A ${kind.kind} belongs to one workspace. Name it as 'workspaceId'`,
    { reason: "scope_unavailable" }
  );
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
    const kind = kinds.require(mutation.kind);
    if (mutation.type === "upsert" && mutation.scope) {
      assertScopeCanOwn(kind, mutation.scope);
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
