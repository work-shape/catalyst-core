import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  type AssetScope,
  type LocaleCode,
  type ConfigAssetRecord
} from "@work-shape/catalyst-core";
import type { WorkflowAssetKind } from "../asset-kinds/shared";

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
 * Only saved sources are checked. Existing invalid references keep running and do not block
 * edits to their targets or unrelated assets; the next save or publish of the source refuses
 * them. Ownership is immutable, so changing a target cannot create an invalid owner pair.
 */
export function assertReferencesWithinOwners(
  kinds: readonly WorkflowAssetKind[],
  mutations: readonly OwnedWrite[],
  assets: readonly ConfigAssetRecord[],
  locale: LocaleCode = "en"
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
    if (!references || !touched.has(at)) continue;
    for (const reference of references(asset.definition)) {
      const named = owned.get(key(reference.kind, reference.name));
      if (!named) continue;
      if (named.scope.kind === "workspace" && !sameWorkspace(asset.scope, named.scope)) {
        const owner = named.scope.workspaceId;
        throw new AppError(
          "VALIDATION_FAILED",
          locale === "de"
            ? `Config ${asset.kind} '${asset.name}' verweist auf ${named.kind} '${named.name}' im Arbeitsbereich '${owner}'. Ein Asset darf nur Assets desselben Arbeitsbereichs oder der Instanz referenzieren; ein Asset der Instanz darf keine Arbeitsbereichs-Assets referenzieren.`
            : `Config ${asset.kind} '${asset.name}' references ${named.kind} '${named.name}' owned by workspace '${owner}'. An asset may reference only assets of its own workspace or the instance; an instance-owned asset cannot reference workspace assets.`,
          {
            reason: "invalid_scope",
            reference: { kind: named.kind, name: named.name, owner: named.scope },
            owner: asset.scope
          }
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
    (mutation) =>
      mutation.type === "upsert" && mutation.kind === kind.kind && mutation.name === name
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
