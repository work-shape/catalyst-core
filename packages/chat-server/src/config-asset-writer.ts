import {
  AppError,
  ObjectNotFound,
  type AssetScope,
  type ConfigAssetRecord,
  type ConfigAssetState,
  type ConfigAssetStore,
  type RegisteredAssetKind
} from "@vivd-catalyst/core";
import { assetSetOf, validateAssetSet, withDefaultAgentName, type AssetSet } from "./asset-set";
import { readDefinitionName, type WorkflowAssetKind } from "./asset-kinds/shared";
import type { AssetWorkflowOptions } from "./types";

export type ConfigAssetWriterOptions = Pick<
  AssetWorkflowOptions,
  "config" | "configAssets" | "clientInstanceId" | "pages"
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

type MutationInput = Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0];

/**
 * Shared write path. Callers own authorization; every write validates the set it leaves.
 *
 * The set is read and checked here first, without a lock, so a write that would leave an
 * invalid set is refused before it waits for one. The store then asks once more under the lock
 * every asset write takes: the ids of the active revisions are compared with the ones read
 * here, and only where another write changed the set in between is it read again and the
 * check repeated. So two writes that each pass alone, one that refers to an asset and one
 * that deletes it, cannot both be written: the second one is checked against the first.
 *
 * Under the lock that costs one read of an id per active asset, and after a concurrent write
 * one read of the whole set.
 */
export async function applyValidatedConfigAssetMutations(
  options: ConfigAssetWriterOptions,
  input: Omit<MutationInput, "validate"> & {
    /**
     * Asked under the lock of the write, after the set was checked and before anything is
     * written. What it throws refuses the batch. It is where a writer decides what depends on
     * a state no other write can change any more.
     */
    underLock?(): Promise<void>;
  }
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
  const validate = (stored: { state: ConfigAssetState; assets: ConfigAssetRecord[] }) =>
    validateMutations(kinds.kinds, input.mutations, stored);
  validate({ state, assets });
  const read = new Set(assets.map((asset) => asset.activeRevisionId));
  // The `files` store, which holds the bundle of a write that adds a commit to a repository.
  const objects = options.pages?.objects;
  const { underLock, ...batch } = input;
  return options.configAssets.store.applyConfigAssetMutations({
    ...batch,
    ...(objects
      ? {
          repositoryObjectSize: (key: string) =>
            objects.head(key).then(
              (head) => head.size,
              (error: unknown) => {
                if (error instanceof ObjectNotFound) return undefined;
                throw error;
              }
            )
        }
      : {}),
    async validate(locked) {
      const ids = await locked.listActiveRevisionIds();
      const unchanged =
        locked.state.defaultAgentName === state.defaultAgentName &&
        ids.length === read.size &&
        ids.every((id) => read.has(id));
      if (!unchanged) {
        validate({ state: locked.state, assets: await locked.listActiveConfigAssets() });
      }
      await underLock?.();
    }
  });
}

/** Refuses the mutations for the set they would leave of the stored one. */
function validateMutations(
  kinds: readonly WorkflowAssetKind[],
  mutations: MutationInput["mutations"],
  current: { state: ConfigAssetState; assets: ConfigAssetRecord[] }
): void {
  const stored = assetSetOf(current.assets, current.state.defaultAgentName);
  const definitions = new Map(
    [...stored.definitions].map(([kind, ofKind]) => [
      kind,
      new Map(ofKind.map((config) => [readDefinitionName(config), config]))
    ])
  );
  let defaultAgentName = current.state.defaultAgentName;
  for (const mutation of mutations) {
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
  validateAssetSet(kinds, candidate, stored);
}
