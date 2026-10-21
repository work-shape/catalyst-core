import { deleteTryConversations } from "../../deletion/conversation-cleanup";
import { AppError, auditActorFromIdentity, operationDenialError } from "@work-shape/catalyst-core";
import { afterRemove } from "../asset-after-write";
import {
  validateAssetSet,
  withDefaultAgentName,
  withoutDefinition,
  type AssetSet
} from "../asset-set";
import { deleteDecision, type AssetCall } from "../asset-access";
import {
  assertDeleteWithinLimits,
  assetKey,
  clearsLastDefault,
  loadStoredAssets,
  requireInstanceDefaultChange,
  withPublishedConfigs
} from "../asset-write-rules";
import {
  assertStoredWritable,
  recordAssetEvent,
  recordCommitted,
  requireDeletable,
  type AssetAddress
} from "../asset-target";
import { requirePrecondition } from "../asset-revision";
import type { AssetVerbScope } from "./scope";
import { applyAssetWrite, requireTellableChange } from "./apply";
import { requireFurtherRight } from "./revision-rights";

export async function deleteAsset(
  scope: AssetVerbScope,
  call: AssetCall,
  input: AssetAddress & { expectedRevision?: number }
) {
  const target = await scope.target(input);
  const { kind, name } = target;
  const right = deleteDecision(call.access, target);
  if (!right.allowed) {
    if (right.action === undefined) throw operationDenialError({ kind: "forbidden", ...right });
    call.access.require(right.action, target.resource);
  }
  await requireFurtherRight(scope, call.access, target, "delete");
  const expectedRevision = requirePrecondition(input, input.expectedRevision);
  await scope.authorizeEditing(call, "delete");
  assertStoredWritable(target, call.access);
  assertDeleteWithinLimits(call.access, "delete", kind);
  await requireDeletable(scope.options, call, target, expectedRevision);
  assertStoredWritable(target, "always");
  if (kind.representation === "files") {
    return scope.drafts.remove(call, target, expectedRevision);
  }
  const stored = await loadStoredAssets(scope.options);
  await kind.assertRemovable?.({
    name,
    assets: (other) => withPublishedConfigs(scope.options, stored.assets, other)
  });
  const clearsDefault = clearsLastDefault(stored.set, kind, name);
  requireInstanceDefaultChange(call.access, kind, clearsDefault);
  /** The set as the delete would leave it. */
  const deleted = (set: AssetSet) => {
    const removed = withoutDefinition(set, kind.kind, name);
    return clearsDefault ? withDefaultAgentName(removed, undefined) : removed;
  };
  requireTellableChange(scope, call, target, stored, deleted);
  validateAssetSet(scope.options.configAssets.kinds.kinds, deleted(stored.set), stored.set);
  const result = await applyAssetWrite(
    scope,
    call,
    target,
    {
      baseRevisions: { [assetKey(kind.kind, name)]: expectedRevision },
      ...(clearsDefault ? { baseDefaultAgentName: name } : {}),
      mutations: [
        { type: "delete", kind: kind.kind, name, scope: target.scope },
        ...(clearsDefault ? [{ type: "setDefaultAgent" as const, agentName: undefined }] : [])
      ]
    },
    { previous: target.asset?.config, config: undefined }
  );
  const revision = allocatedRevision(result, kind.kind, name);

  await recordCommitted(scope.options, call, [
    () =>
      recordAssetEvent(call, "config_asset.deleted", {
        kind: kind.kind,
        name,
        revision,
        version: result.version
      })
  ]);
  if (kind.kind === "agent" && target.asset) {
    await deleteTryConversations(
      scope.options,
      { agentId: target.asset.id },
      {
        deletedAt: new Date().toISOString(),
        requestedBy: "agent_deleted",
        correlationId: call.correlationId,
        actor: auditActorFromIdentity(call.actor)
      }
    );
  }

  await afterRemove(scope.options, call, target);
  return { version: result.version, revision, warnings: [] };
}

/** The revision the store gave the asset in the write that just committed. */
function allocatedRevision(
  result: { revisions: Record<string, number> },
  kind: string,
  name: string
): number {
  const revision = result.revisions[assetKey(kind, name)];
  if (revision === undefined) {
    throw new AppError("INTERNAL", `The write of config ${kind} '${name}' has no revision`);
  }
  return revision;
}
