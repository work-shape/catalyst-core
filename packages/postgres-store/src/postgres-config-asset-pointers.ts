import { and, eq, inArray } from "drizzle-orm";
import {
  AppError,
  asClientInstanceId,
  type ClientInstanceId,
  type ConfigAssetStore,
  type FileSetId
} from "@work-shape/catalyst-core";
import { sweepAssetRepoBundlesOf } from "./postgres-asset-repo-operations";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import type { ConfigAssetRow } from "./rows";
import {
  configAssetRevisions,
  configAssets,
  configAssetState,
  fileSets,
  permissionGrants
} from "./schema";

// The writes of an asset that append no revision: the published pointer, the draft pointer
// going back to it, and the removal of an asset with everything it holds.

/**
 * The lock every write of an asset's content takes first. A change of the draft pointer or
 * the removal of an asset takes it too, so neither runs beside a write of the same asset.
 */
async function lockConfigAssetWrites(
  tx: PostgresTransaction,
  clientInstanceId: string
): Promise<void> {
  await tx
    .select({ version: configAssetState.version })
    .from(configAssetState)
    .where(eq(configAssetState.clientInstanceId, clientInstanceId))
    .for("update")
    .limit(1);
}

/** The row of one asset, held against every other write of it until the transaction ends. */
async function lockConfigAssetRow(
  tx: PostgresTransaction,
  input: Parameters<ConfigAssetStore["getConfigAsset"]>[0]
): Promise<ConfigAssetRow | undefined> {
  const [row] = await tx
    .select()
    .from(configAssets)
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, input.kind),
        eq(configAssets.name, input.name)
      )
    )
    .for("update")
    .limit(1);
  return row;
}

/**
 * The active asset of the name, where it is the one the caller checked its right on. Another
 * asset under the name was created after that one was removed, and nobody was asked for it.
 */
async function lockAuthorizedAsset(
  tx: PostgresTransaction,
  input: Parameters<ConfigAssetStore["getConfigAsset"]>[0] & { assetId: string }
): Promise<ConfigAssetRow> {
  const asset = await lockConfigAssetRow(tx, input);
  if (!asset || asset.status !== "active") {
    throw assetNotFound(input);
  }
  if (asset.id !== input.assetId) {
    throw new AppError(
      "CONFLICT",
      `Config ${input.kind} '${input.name}' is no longer the asset that was read: the name was removed and created again`,
      { reason: "revision_changed" }
    );
  }
  return asset;
}

function assetNotFound(input: { kind: string; name: string }): AppError {
  return new AppError("NOT_FOUND", `Config ${input.kind} '${input.name}' was not found`);
}

export async function publishConfigAssetRevision(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["publishConfigAssetRevision"]>[0]
): ReturnType<ConfigAssetStore["publishConfigAssetRevision"]> {
  return db.transaction(async (tx) => {
    const asset = await lockAuthorizedAsset(tx, input);
    const [target] = await tx
      .select({
        id: configAssetRevisions.id,
        config: configAssetRevisions.config,
        fileSetId: configAssetRevisions.fileSetId
      })
      .from(configAssetRevisions)
      .where(
        and(
          eq(configAssetRevisions.assetId, asset.id),
          eq(configAssetRevisions.revision, input.revision)
        )
      )
      .limit(1);
    if (!target || target.config === null) {
      throw new AppError(
        "NOT_FOUND",
        `Config ${input.kind} '${input.name}' has no revision ${input.revision} to publish`,
        { reason: "revision_unknown" }
      );
    }
    if (target.id !== input.revisionId) {
      throw new AppError(
        "CONFLICT",
        `Revision ${input.revision} of ${input.kind} '${input.name}' is no longer the revision that was read: the name was removed and created again`,
        { reason: "revision_changed", revision: input.revision }
      );
    }
    if (
      input.requireFiles &&
      !(await hasBuiltFiles(
        tx,
        { clientInstanceId: input.clientInstanceId, assetId: asset.id },
        target.fileSetId
      ))
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Revision ${input.revision} of ${input.kind} '${input.name}' has no built files to serve, so it is not published. Write the files again and publish the new revision.`,
        { reason: "revision_files_removed", revision: input.revision }
      );
    }
    const [replaced] = asset.publishedRevisionId
      ? await tx
          .select({ revision: configAssetRevisions.revision })
          .from(configAssetRevisions)
          .where(eq(configAssetRevisions.id, asset.publishedRevisionId))
          .limit(1)
      : [];
    await tx
      .update(configAssets)
      .set({ publishedRevisionId: target.id, updatedAt: new Date() })
      .where(eq(configAssets.id, asset.id));
    return {
      assetId: asset.id,
      revision: input.revision,
      ...(replaced ? { replacedRevision: replaced.revision } : {}),
      ...(target.fileSetId ? { fileSetId: target.fileSetId } : {})
    };
  });
}

export async function discardConfigAssetDraft(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["discardConfigAssetDraft"]>[0]
): ReturnType<ConfigAssetStore["discardConfigAssetDraft"]> {
  return db.transaction(async (tx) => {
    await lockConfigAssetWrites(tx, input.clientInstanceId);
    const asset = await lockAuthorizedAsset(tx, input);
    const pointers = [asset.activeRevisionId, asset.publishedRevisionId].flatMap((id) => id ?? []);
    const numbers = new Map(
      (
        await tx
          .select({ id: configAssetRevisions.id, revision: configAssetRevisions.revision })
          .from(configAssetRevisions)
          .where(inArray(configAssetRevisions.id, pointers))
      ).map((row) => [row.id, row.revision])
    );
    const draft = numbers.get(asset.activeRevisionId);
    if (draft !== input.expectedRevision) {
      throw new AppError(
        "CONFLICT",
        `Config ${input.kind} '${input.name}' is at revision ${String(draft)}`,
        { kind: input.kind, name: input.name, currentRevision: draft ?? null }
      );
    }
    const published = asset.publishedRevisionId
      ? numbers.get(asset.publishedRevisionId)
      : undefined;
    if (!asset.publishedRevisionId || published === undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        `nothing_published: ${input.kind} '${input.name}' was never published, so there is no revision to go back to`,
        { reason: "nothing_published" }
      );
    }
    await tx
      .update(configAssets)
      .set({ activeRevisionId: asset.publishedRevisionId, updatedAt: new Date() })
      .where(eq(configAssets.id, asset.id));
    return { revision: published };
  });
}

export async function unpublishConfigAsset(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["unpublishConfigAsset"]>[0]
): ReturnType<ConfigAssetStore["unpublishConfigAsset"]> {
  return db.transaction(async (tx) => {
    await lockConfigAssetWrites(tx, input.clientInstanceId);
    const asset = await lockAuthorizedAsset(tx, input);
    const [published] = asset.publishedRevisionId
      ? await tx
          .select({ revision: configAssetRevisions.revision })
          .from(configAssetRevisions)
          .where(eq(configAssetRevisions.id, asset.publishedRevisionId))
          .limit(1)
      : [];
    if (!published) {
      throw new AppError(
        "VALIDATION_FAILED",
        `nothing_published: ${input.kind} '${input.name}' is not published`,
        { reason: "nothing_published" }
      );
    }
    await tx
      .update(configAssets)
      .set({ publishedRevisionId: null, updatedAt: new Date() })
      .where(eq(configAssets.id, asset.id));
    return { revision: published.revision };
  });
}

export async function removeConfigAsset(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["removeConfigAsset"]>[0]
): ReturnType<ConfigAssetStore["removeConfigAsset"]> {
  return db.transaction(async (tx) => {
    await lockConfigAssetWrites(tx, input.clientInstanceId);
    const asset = await lockAuthorizedAsset(tx, input);
    const [draft] = await tx
      .select({ revision: configAssetRevisions.revision })
      .from(configAssetRevisions)
      .where(eq(configAssetRevisions.id, asset.activeRevisionId))
      .limit(1);
    if (draft?.revision !== input.expectedRevision) {
      throw new AppError(
        "CONFLICT",
        `Config ${input.kind} '${input.name}' is at revision ${String(draft?.revision)}`,
        { kind: input.kind, name: input.name, currentRevision: draft?.revision ?? null }
      );
    }
    const removedFileSets = await tx
      .delete(fileSets)
      .where(
        and(
          eq(fileSets.clientInstanceId, asClientInstanceId(input.clientInstanceId)),
          eq(fileSets.ownerKind, "asset"),
          eq(fileSets.ownerId, asset.id)
        )
      )
      .returning({ id: fileSets.id });
    // The id never returns, so every grant on it goes, a deny included.
    await tx
      .delete(permissionGrants)
      .where(
        and(
          eq(permissionGrants.clientInstanceId, input.clientInstanceId),
          eq(permissionGrants.scopeKind, "asset"),
          eq(permissionGrants.scopeId, asset.id)
        )
      );
    await sweepAssetRepoBundlesOf(tx, [asset.id]);
    // The revisions go with the row through their key.
    await tx.delete(configAssets).where(eq(configAssets.id, asset.id));
    return { assetId: asset.id, fileSetCount: removedFileSets.length };
  });
}

/** Whether the file set a revision names is there, is this asset's and holds built files. */
async function hasBuiltFiles(
  db: PostgresTransaction,
  owner: { clientInstanceId: ClientInstanceId; assetId: string },
  fileSetId: FileSetId | null
): Promise<boolean> {
  if (fileSetId === null) {
    return false;
  }
  const [fileSet] = await db
    .select({ builtFileCount: fileSets.builtFileCount })
    .from(fileSets)
    .where(
      and(
        eq(fileSets.id, fileSetId),
        eq(fileSets.clientInstanceId, owner.clientInstanceId),
        eq(fileSets.ownerKind, "asset"),
        eq(fileSets.ownerId, owner.assetId)
      )
    )
    .limit(1);
  return fileSet !== undefined && fileSet.builtFileCount > 0;
}
