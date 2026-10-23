import { upsertAsset, type AssetUpsert } from "../asset-upsert";
import {
  AppError,
  auditActorFromIdentity,
  isAppError,
  type ConfigAssetStore,
  type JsonObject
} from "@work-shape/catalyst-core";
import type { AssetWriteFollowUp } from "../../asset-kinds/shared";
import { INVALID_ASSET_SET_MESSAGE, type AssetSet } from "../asset-set";
import type { AssetCall } from "../asset-access";
import {
  assetKey,
  findIssuesOfChange,
  loadReferableAssets,
  type StoredAssets
} from "../asset-write-rules";
import type { AssetTarget } from "../asset-target";
import { revisionConflictOf } from "../asset-revision";
import { applyValidatedConfigAssetMutations } from "../config-asset-writer";
import type { AssetVerbScope } from "./scope";

type MutationBatch = Omit<
  Parameters<typeof applyValidatedConfigAssetMutations>[1],
  "clientInstanceId" | "actor"
>;

/**
 * Refuses a change for what its caller may be told: a reference to an asset the caller may
 * not read in the words of a reference to nothing, and an issue of such an asset without
 * its name. A caller who reads everything is left to the check of the whole set after it.
 */
export function requireTellableChange(
  scope: AssetVerbScope,
  call: AssetCall,
  target: AssetTarget,
  stored: StoredAssets,
  written: (set: AssetSet) => AssetSet
): void {
  const { kind, name } = target;
  const view = loadReferableAssets(scope.options, call.access, stored);
  if (view.complete) return;
  const issues = findIssuesOfChange(
    scope.options.configAssets.kinds.kinds,
    stored.set,
    view,
    written,
    new Set([assetKey(kind.kind, name)]),
    call.runtime?.locale ?? scope.options.config.localization.defaultLocale
  );
  if (issues.length > 0) {
    throw new AppError("VALIDATION_FAILED", INVALID_ASSET_SET_MESSAGE, { issues });
  }
}

/**
 * Applies the write of one asset. The store checks the expected revision once more under
 * its lock, and a write that got in between is answered as every stale write is.
 */
export async function applyAssetWrite(
  scope: AssetVerbScope,
  call: AssetCall,
  target: AssetTarget,
  batch: MutationBatch,
  write?: { previous: unknown; config: JsonObject | undefined }
): ReturnType<ConfigAssetStore["applyConfigAssetMutations"]> {
  const actor = auditActorFromIdentity(call.actor);
  const within = target.kind.withinWrite?.bind(target.kind);
  try {
    if (within === undefined || write === undefined) {
      return await applyValidatedConfigAssetMutations(
        scope.options,
        {
          clientInstanceId: scope.options.clientInstanceId,
          actor,
          ...batch
        },
        call.runtime?.locale
      );
    }
    // The kind's part of the write commits with the revision or not at all.
    const followUps: AssetWriteFollowUp[] = [];
    let result: Awaited<ReturnType<ConfigAssetStore["applyConfigAssetMutations"]>>;
    try {
      result = await scope.options.stores.transaction(async (stores) => {
        const applied = await applyValidatedConfigAssetMutations(
          {
            ...scope.options,
            configAssets: { ...scope.options.configAssets, store: stores.configAssets }
          },
          { clientInstanceId: scope.options.clientInstanceId, actor, ...batch },
          call.runtime?.locale
        );
        const followUp = await within({
          clientInstanceId: scope.options.clientInstanceId,
          name: target.name,
          assetId: target.asset?.status === "active" ? target.asset.id : undefined,
          ...(target.asset?.status === "deleted" && write.config !== undefined && !restores(batch)
            ? { createdAgainId: target.asset.id }
            : {}),
          previousRevision: target.asset?.status === "active" ? target.asset.revision : undefined,
          ...write,
          actor,
          correlationId: call.correlationId,
          stores
        });
        if (followUp !== undefined) followUps.push(followUp);
        return applied;
      });
    } catch (error) {
      for (const followUp of followUps) followUp.rolledBack();
      throw error;
    }
    for (const followUp of followUps) await followUp.committed();
    return result;
  } catch (error) {
    if (!isAppError(error) || error.code !== "REVISION_CONFLICT") throw error;
    if (
      typeof error.details === "object" &&
      error.details !== null &&
      "reason" in error.details &&
      error.details.reason === "draft_changed"
    )
      throw error;
    if (
      batch.mutations.some(
        (mutation) => mutation.type === "upsert" && mutation.agentPublish !== undefined
      )
    ) {
      throw new AppError("CONFLICT", "The live agent changed since the draft was written", {
        reason: "stale_base"
      });
    }
    const now = await scope.target(target.address);
    throw await revisionConflictOf(scope.options, call.access, now);
  }
}

/**
 * Writes the config of one asset as a new revision, with the checks of what its caller may be
 * told and the kind's part of the write.
 */
export function writeAssetConfig(
  scope: AssetVerbScope,
  call: AssetCall,
  target: AssetTarget,
  config: Record<string, unknown>,
  write: AssetUpsert
) {
  return upsertAsset(scope.options, call, target, config, write, {
    requireTellableChange: (stored, written) =>
      requireTellableChange(scope, call, target, stored, written),
    apply: (batch, applied) => applyAssetWrite(scope, call, target, batch, applied)
  });
}

/** The batch restores an earlier revision: a revert, not a put. */
function restores(batch: MutationBatch): boolean {
  return batch.mutations.some(
    (mutation) => mutation.type === "upsert" && mutation.operation === "revert"
  );
}
