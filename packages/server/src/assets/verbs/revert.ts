import { AppError } from "@work-shape/catalyst-core";
import type { AssetCall } from "../asset-access";
import { requireMatchingConfigName } from "../asset-write-rules";
import {
  assertStoredWritable,
  notFound,
  readsTarget,
  requireOwnScope,
  type AssetAddress
} from "../asset-target";
import { requirePrecondition, revisionConflictOf } from "../asset-revision";
import { writeAssetConfig } from "./apply";
import type { AssetVerbScope } from "./scope";
import { requireFurtherRight, revisionOf } from "./revision-rights";

/** Makes an earlier revision the content again, as a new revision. A deleted asset returns. */
export async function revertAsset(
  scope: AssetVerbScope,
  call: AssetCall,
  input: AssetAddress & {
    revision: number;
    expectedRevision?: number;
    expectedDraftRevision?: number | null;
  }
) {
  const target = await scope.target(input);
  call.access.require(target.kind.actions.write, target.resource);
  const restored = await revisionOf(scope, target, input.revision);
  if (restored?.config) {
    await requireFurtherRight(scope, call.access, target, "write", restored.config);
  }
  const expectedRevision = requirePrecondition(input, input.expectedRevision);
  await scope.authorizeEditing(call, "revert");
  if (target.kind.lifecycle === "draft_published") {
    throw new AppError(
      "VALIDATION_FAILED",
      `A ${target.kind.kind} has a published revision: publish the earlier revision by its number with 'assets.publish'`,
      { reason: "use_publish" }
    );
  }
  assertStoredWritable(target, call.access);
  requireOwnScope(target, call.access);
  // A caller who does not read the asset is not told whether it was ever stored.
  if (!target.asset && readsTarget(call.access, target)) {
    throw notFound(target);
  }
  if (target.asset?.revision !== expectedRevision) {
    throw await revisionConflictOf(scope.options, call.access, target);
  }
  assertStoredWritable(target, "always");
  if (!restored || restored.config === null) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Config asset revision ${input.revision} does not contain a restorable config`
    );
  }
  requireMatchingConfigName(restored.config, target.name);
  return writeAssetConfig(scope, call, target, restored.config, {
    expectedRevision,
    operation: "revert",
    expectedDraftRevision: input.expectedDraftRevision ?? null,
    audit: "config_asset.reverted",
    // The files of the restored revision come back with it. They were never removed.
    ...(target.kind.revisionFiles && restored.fileSetId && target.asset
      ? { fileSet: { assetId: target.asset.id, fileSetId: restored.fileSetId } }
      : {})
  });
}
