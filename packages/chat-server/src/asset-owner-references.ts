import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  type AssetScope,
  type ConfigAssetRecord
} from "@vivd-catalyst/core";
import type { WorkflowAssetKind } from "./asset-kinds/shared";

/** A write as far as this rule reads it: a store mutation, or a definition a validate asks of. */
type OwnedWrite =
  | { type: "upsert"; kind: string; name: string; scope?: AssetScope; config: unknown }
  | { type: "delete"; kind: string; name: string }
  | { type: "setDefaultAgent"; agentName?: string | undefined };

interface Owned {
  kind: string;
  name: string;
  scope: AssetScope;
  definition: unknown;
}

/**
 * Refuses a write that would leave an asset naming what a workspace owns while its own owner
 * is another: the instance or another workspace (WS-OWN-1a). A workspace's asset may name the
 * instance's own. Only a pair the write touches is asked, so a write is never refused for what
 * it leaves as it is. The writer asks this of every write; a caller that may not read the
 * named asset was refused before, as for a reference to nothing, so the refusal names no
 * workspace.
 */
export function assertReferencesWithinOwners(
  kinds: readonly WorkflowAssetKind[],
  mutations: readonly OwnedWrite[],
  assets: readonly ConfigAssetRecord[]
): void {
  const key = (kind: string, name: string) => `${kind}:${name}`;
  const owned = new Map<string, Owned>(
    assets.map((asset) => [
      key(asset.kind, asset.name),
      { kind: asset.kind, name: asset.name, scope: asset.scope, definition: asset.config }
    ])
  );
  const touched = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.type === "setDefaultAgent") continue;
    const at = key(mutation.kind, mutation.name);
    touched.add(at);
    if (mutation.type === "delete") {
      owned.delete(at);
    } else {
      owned.set(at, {
        kind: mutation.kind,
        name: mutation.name,
        scope: mutation.scope ?? INSTANCE_ASSET_SCOPE,
        definition: mutation.config
      });
    }
  }
  if (touched.size === 0) return;
  const referencesOf = new Map(
    kinds.flatMap((kind) => (kind.references ? [[kind.kind, kind.references] as const] : []))
  );
  for (const [at, asset] of owned) {
    const references = referencesOf.get(asset.kind);
    if (!references) continue;
    for (const reference of references(asset.definition)) {
      const named = owned.get(key(reference.kind, reference.name));
      if (!named || (!touched.has(at) && !touched.has(key(named.kind, named.name)))) continue;
      if (named.scope.kind === "workspace" && !sameWorkspace(asset.scope, named.scope)) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Config ${asset.kind} '${asset.name}' names the ${named.kind} '${named.name}', which a workspace owns: only an asset of that workspace may name it`,
          { reason: "invalid_scope" }
        );
      }
    }
  }
}

/**
 * Refuses a write that makes an agent a workspace owns the instance's default (Felix,
 * 2026-10-14): the default is offered in every workspace, and a workspace's agent is its own.
 * Only a write that sets the default is asked, so one that leaves it is never refused here.
 */
export function assertDefaultOwnedByInstance(
  kinds: readonly WorkflowAssetKind[],
  mutations: readonly OwnedWrite[],
  assets: readonly ConfigAssetRecord[]
): void {
  const kind = kinds.find((each) => each.holdsInstanceDefault);
  const set = mutations.findLast((mutation) => mutation.type === "setDefaultAgent");
  if (!kind || set?.type !== "setDefaultAgent" || set.agentName === undefined) return;
  const name = set.agentName;
  const written = mutations.findLast(
    (mutation) => mutation.type === "upsert" && mutation.kind === kind.kind && mutation.name === name
  );
  const scope =
    written?.type === "upsert"
      ? (written.scope ?? INSTANCE_ASSET_SCOPE)
      : assets.find((asset) => asset.kind === kind.kind && asset.name === name)?.scope;
  if (scope?.kind === "workspace") {
    throw new AppError(
      "VALIDATION_FAILED",
      `Config ${kind.kind} '${name}' belongs to a workspace, and only a ${kind.kind} of the whole instance can be its default`,
      { reason: "default_owned_by_workspace" }
    );
  }
}

function sameWorkspace(scope: AssetScope, workspace: AssetScope & { kind: "workspace" }): boolean {
  return scope.kind === "workspace" && scope.workspaceId === workspace.workspaceId;
}
