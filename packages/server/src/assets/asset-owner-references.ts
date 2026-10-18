import {
  AppError,
  asCollaborationWorkspaceId,
  INSTANCE_ASSET_SCOPE,
  type AssetScope,
  type ClientInstanceId,
  type PlatformStores,
  type LocaleCode,
  type ConfigAssetRecord
} from "@work-shape/catalyst-core";
import { assetKindLabel } from "./asset-reference-labels";
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
 * Check owner pairs when writing their source or creating their target. Owners never change,
 * so editing an existing target leaves legacy pairs running.
 * Workflows may reach workspace Apps, Data Stores and Knowledge Bases: their principal's
 * grants are checked at run time. Guardrail filters are absent from the reference inventory.
 */
export async function assertReferencesWithinOwners(
  kinds: readonly WorkflowAssetKind[],
  mutations: readonly OwnedWrite[],
  assets: readonly ConfigAssetRecord[],
  locale: LocaleCode,
  options: { clientInstanceId: ClientInstanceId; stores: Pick<PlatformStores, "workspaces"> }
): Promise<void> {
  const key = (kind: string, name: string) => `${kind}:${name}`;
  const owned = new Map<string, Owned>(
    assets.map((asset) => [
      key(asset.kind, asset.name),
      { kind: asset.kind, name: asset.name, scope: asset.scope, definition: asset.config }
    ])
  );
  const existing = new Set(owned.keys());
  const touched = new Set<string>();
  const created = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.type === "setDefaultAgent") continue;
    const at = key(mutation.kind, mutation.name);
    touched.add(at);
    if (mutation.type === "delete") {
      owned.delete(at);
    } else {
      if (!existing.has(at)) created.add(at);
      owned.set(at, {
        kind: mutation.kind,
        name: mutation.name,
        scope: mutation.scope ?? INSTANCE_ASSET_SCOPE,
        definition: mutation.config
      });
    }
  }
  if (touched.size === 0) return;
  const kindsByName = new Map(kinds.map((kind) => [kind.kind, kind]));
  for (const [at, asset] of owned) {
    const kind = kindsByName.get(asset.kind);
    const references = kind?.references;
    if (!references) continue;
    for (const reference of references(asset.definition)) {
      const named = owned.get(key(reference.kind, reference.name));
      if (!named || (!touched.has(at) && !created.has(key(named.kind, named.name)))) continue;
      if (asset.scope.kind === "instance" && kind?.crossOwnerReferences?.includes(named.kind))
        continue;
      if (named.scope.kind === "workspace" && !sameWorkspace(asset.scope, named.scope)) {
        // A reverse reference can come from an asset the writer may not read. Tell nothing
        // about that source, including its name, kind or owner.
        if (!touched.has(at)) {
          throw new AppError(
            "VALIDATION_FAILED",
            locale === "de"
              ? "Dieses Asset kann nicht erstellt werden, weil ein Asset eines anderen Eigentümers darauf verweist. Ein Asset darf nur auf Assets im selben Arbeitsbereich oder in der Instanz verweisen."
              : "This asset cannot be created because an asset of another owner references it. An asset may reference only assets of its own workspace or the instance.",
            { reason: "invalid_scope" }
          );
        }
        const ownerName = async (scope: AssetScope) => {
          if (scope.kind === "instance") return locale === "de" ? "Instanz" : "the instance";
          const workspace = await options.stores.workspaces.getWorkspace(
            options.clientInstanceId,
            asCollaborationWorkspaceId(scope.workspaceId)
          );
          return locale === "de"
            ? `Arbeitsbereich '${workspace?.name ?? "unbekannt"}'`
            : `workspace '${workspace?.name ?? "unknown"}'`;
        };
        const sourceName = await ownerName(asset.scope);
        const sourceOwner =
          locale === "de"
            ? `${asset.scope.kind === "instance" ? "zur" : "zum"} ${sourceName}`
            : sourceName;
        const targetName = await ownerName(named.scope);
        const targetOwner = locale === "de" ? `im ${targetName}` : targetName;
        throw new AppError(
          "VALIDATION_FAILED",
          locale === "de"
            ? `${assetKindLabel(asset.kind, locale)} '${asset.name}' gehört ${sourceOwner} und verweist auf ${assetKindLabel(named.kind, locale)} '${named.name}' ${targetOwner}. Ein Asset darf nur auf Assets im selben Arbeitsbereich oder in der Instanz verweisen; ein Asset der Instanz darf nicht auf Assets eines Arbeitsbereichs verweisen.`
            : `${assetKindLabel(asset.kind, locale)} '${asset.name}' owned by ${sourceOwner} references ${assetKindLabel(named.kind, locale)} '${named.name}' owned by ${targetOwner}. An asset may reference only assets of its own workspace or the instance; an instance-owned asset cannot reference workspace assets.`,
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
