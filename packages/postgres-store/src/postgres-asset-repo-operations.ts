import { and, asc, eq, inArray, isNull, lt, max } from "drizzle-orm";
import {
  AppError,
  assetRepoBundleObjectKey,
  type AssetRepoSave,
  type AssetRepoSaveBundle,
  type AssetRepoWrite,
  type ClientInstanceId,
  type ConfigAssetMutation,
  type ConfigAssetStore
} from "@vivd-catalyst/core";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { assetCheckouts, assetRepoBundles } from "./schema";

// The ledger of the repositories of assets. Postgres says which bundles make a repository and
// which commit its draft is at. A save writes a pending row before it puts its bundle; the
// transaction that writes the revision makes that row part of the repository, under the lock
// every write of an asset takes.

type BundleRow = typeof assetRepoBundles.$inferSelect;

/** The bundle a row names, once it names one. The table holds all of its columns or none. */
function namedBundle(row: BundleRow): AssetRepoSaveBundle | undefined {
  const { objectKey, kind, tipCommit, bytes, sha256 } = row;
  if (
    objectKey === null ||
    kind === null ||
    tipCommit === null ||
    bytes === null ||
    sha256 === null
  ) {
    return undefined;
  }
  return {
    objectKey,
    kind,
    tipCommit,
    ...(row.prerequisiteCommit ? { prerequisiteCommit: row.prerequisiteCommit } : {}),
    bytes,
    sha256
  };
}

function mapSave(row: BundleRow): AssetRepoSave {
  const bundle = namedBundle(row);
  return {
    assetId: row.assetId,
    operationRunId: row.operationRunId,
    state: row.state,
    savedAt: row.savedAt.toISOString(),
    ...(bundle ? { bundle } : {})
  };
}

const saveOf = (input: {
  clientInstanceId: ClientInstanceId;
  assetId: string;
  operationRunId: AssetRepoSave["operationRunId"];
}) =>
  and(
    eq(assetRepoBundles.clientInstanceId, input.clientInstanceId),
    eq(assetRepoBundles.assetId, input.assetId),
    eq(assetRepoBundles.operationRunId, input.operationRunId)
  );

export async function beginAssetRepoSave(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["beginAssetRepoSave"]>[0]
): ReturnType<ConfigAssetStore["beginAssetRepoSave"]> {
  // A commit carries whole seconds, so the row holds exactly the time of the commit.
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  // Of two attempts that start at once, one writes the row and both read it.
  await db
    .insert(assetRepoBundles)
    .values({ ...input, state: "pending", savedAt: now, createdAt: now })
    .onConflictDoNothing();
  const [row] = await db.select().from(assetRepoBundles).where(saveOf(input)).limit(1);
  if (!row) {
    throw new AppError("CONFLICT", "The save of this Operation Run is not this instance's", {
      reason: "save_not_pending"
    });
  }
  return mapSave(row);
}

export async function nameAssetRepoSaveBundle(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["nameAssetRepoSaveBundle"]>[0]
): ReturnType<ConfigAssetStore["nameAssetRepoSaveBundle"]> {
  const { bundle } = input;
  const expectedKey = assetRepoBundleObjectKey({
    assetId: input.assetId,
    commit: bundle.tipCommit,
    sha256: bundle.sha256
  });
  if (bundle.objectKey !== expectedKey) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The key of a bundle holds its asset, the commit it ends on and the SHA-256 of its bytes"
    );
  }
  if ((bundle.kind === "full") !== (bundle.prerequisiteCommit === undefined)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "A full bundle stands on nothing, and an incremental one names the commit it stands on"
    );
  }
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(assetRepoBundles).where(saveOf(input)).for("update");
    if (row?.state !== "pending") {
      throw new AppError("CONFLICT", "The save is not pending any more", {
        reason: "save_not_pending"
      });
    }
    if (
      row.objectKey !== null &&
      row.objectKey !== bundle.objectKey &&
      row.objectKey !== input.replaces
    ) {
      throw new AppError("CONFLICT", "The save named another bundle before", {
        reason: "pending_bundle_differs",
        objectKey: row.objectKey
      });
    }
    // The key holds the commit and the hash, so only a save of the same files on the same base
    // by the same author in the same second names it too. One of the two is enough.
    const [other] = await tx
      .select({ operationRunId: assetRepoBundles.operationRunId })
      .from(assetRepoBundles)
      .where(eq(assetRepoBundles.objectKey, bundle.objectKey))
      .limit(1);
    if (other && other.operationRunId !== input.operationRunId) {
      throw new AppError("CONFLICT", "Another save named this bundle", {
        reason: "bundle_named_by_another_save"
      });
    }
    await tx
      .update(assetRepoBundles)
      .set({
        objectKey: bundle.objectKey,
        kind: bundle.kind,
        tipCommit: bundle.tipCommit,
        prerequisiteCommit: bundle.prerequisiteCommit ?? null,
        bytes: bundle.bytes,
        sha256: bundle.sha256
      })
      .where(saveOf(input));
  });
}

export async function sweepPendingAssetRepoSaves(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["sweepPendingAssetRepoSaves"]>[0]
): ReturnType<ConfigAssetStore["sweepPendingAssetRepoSaves"]> {
  return db.transaction(async (tx) => {
    // The lock of the row is what a finishing save waits for: it then finds no row and is
    // refused, so no live row is left naming an object that was removed.
    // A row whose save is finishing right now is waited for and is not pending after.
    const rows = await tx
      .select()
      .from(assetRepoBundles)
      .where(
        and(eq(assetRepoBundles.state, "pending"), lt(assetRepoBundles.savedAt, input.olderThan))
      )
      .orderBy(asc(assetRepoBundles.savedAt))
      .limit(input.limit)
      .for("update");
    for (const row of rows) {
      if (row.objectKey !== null) {
        await input.removeObject({
          clientInstanceId: row.clientInstanceId,
          assetId: row.assetId,
          objectKey: row.objectKey
        });
      }
      await tx
        .delete(assetRepoBundles)
        .where(
          and(
            eq(assetRepoBundles.assetId, row.assetId),
            eq(assetRepoBundles.operationRunId, row.operationRunId),
            eq(assetRepoBundles.state, "pending")
          )
        );
    }
    return { removed: rows.length };
  });
}

/** Removes the rows of assets that are being removed. Their objects lie below the assets' prefixes. */
export async function deleteAssetRepoBundles(
  tx: PostgresTransaction,
  assetIds: readonly string[]
): Promise<void> {
  if (assetIds.length > 0) {
    await tx.delete(assetRepoBundles).where(inArray(assetRepoBundles.assetId, [...assetIds]));
  }
}

export async function listAssetRepoBundles(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["listAssetRepoBundles"]>[0]
): ReturnType<ConfigAssetStore["listAssetRepoBundles"]> {
  const rows = await db
    .select()
    .from(assetRepoBundles)
    .where(
      and(
        eq(assetRepoBundles.clientInstanceId, input.clientInstanceId),
        eq(assetRepoBundles.assetId, input.assetId),
        eq(assetRepoBundles.state, "live"),
        input.includeSuperseded ? undefined : isNull(assetRepoBundles.supersededAt)
      )
    )
    .orderBy(asc(assetRepoBundles.sequence));
  return rows.flatMap((row) => {
    const bundle = namedBundle(row);
    return bundle && row.sequence !== null
      ? [
          {
            assetId: row.assetId,
            sequence: row.sequence,
            ...bundle,
            ...(row.supersededAt ? { supersededAt: row.supersededAt.toISOString() } : {}),
            createdAt: row.createdAt.toISOString()
          }
        ]
      : [];
  });
}

export async function getAssetCheckout(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["getAssetCheckout"]>[0]
): ReturnType<ConfigAssetStore["getAssetCheckout"]> {
  const [row] = await db
    .select()
    .from(assetCheckouts)
    .where(
      and(
        eq(assetCheckouts.clientInstanceId, input.clientInstanceId),
        eq(assetCheckouts.conversationId, input.conversationId),
        eq(assetCheckouts.folder, input.folder)
      )
    )
    .limit(1);
  return row
    ? {
        conversationId: row.conversationId,
        folder: row.folder,
        assetId: row.assetId,
        baseCommit: row.baseCommit,
        baseRevision: row.baseRevision
      }
    : undefined;
}

/** A repository write of a batch, with the asset as the batch found it under its lock. */
interface LockedRepoWrite {
  kind: string;
  name: string;
  write: AssetRepoWrite;
}

const keyOf = (address: { kind: string; name: string }) => `${address.kind}:${address.name}`;

/**
 * The repository writes of a batch, each held against the asset as it is under the lock of
 * the write. A write whose base is not the commit of the draft any more is refused with the
 * reason `draft_moved`. It is asked before anything else is compared, so the one of two saves
 * from the same base that comes second is told that the draft moved.
 */
export function lockedRepoWrites(
  mutations: readonly ConfigAssetMutation[],
  stored: readonly {
    asset: { kind: string; name: string; status: "active" | "deleted" };
    /** The revision the draft pointer names. */
    revision: { commit: string | null };
  }[]
): LockedRepoWrite[] {
  const writes: LockedRepoWrite[] = [];
  for (const mutation of mutations) {
    if (mutation.type !== "upsert" || !mutation.repository) {
      continue;
    }
    const { kind, name, repository: write } = mutation;
    if (writes.some((other) => keyOf(other) === keyOf(mutation))) {
      throw new AppError("VALIDATION_FAILED", "A batch adds one commit to an asset at most");
    }
    const row = stored.find((candidate) => keyOf(candidate.asset) === keyOf(mutation));
    const draftCommit = row?.asset.status === "active" ? row.revision.commit : null;
    if (write.baseCommit !== draftCommit) {
      throw new AppError(
        "CONFLICT",
        `The draft of ${kind} '${name}' moved: it is not at the commit this change was made on any more`,
        { reason: "draft_moved", kind, name, ...(draftCommit === null ? {} : { draftCommit }) }
      );
    }
    writes.push({ kind, name, write });
  }
  return writes;
}

/** The columns of a revision that name its commit. Empty for a write without a repository. */
export function repoColumns(mutation: { repository?: AssetRepoWrite }): {
  commit: string | null;
  tree: string | null;
} {
  return { commit: mutation.repository?.commit ?? null, tree: mutation.repository?.tree ?? null };
}

/**
 * Makes the pending bundle of each repository write part of its repository and binds its
 * folder, once the revisions of the batch are written. A save whose row the sweeper removed,
 * or whose bundle is not the one of this commit on this base, is refused, and with it the
 * batch. `revisions` and `assetIds` are what the batch gave each asset it wrote, keyed
 * `<kind>:<name>`.
 */
export async function insertRepoWrites(
  tx: PostgresTransaction,
  clientInstanceId: ClientInstanceId,
  now: Date,
  locked: readonly LockedRepoWrite[],
  revisions: Readonly<Record<string, number>>,
  assetIds: Readonly<Record<string, string>>
): Promise<void> {
  const writes = locked.flatMap((entry) => {
    const assetId = assetIds[keyOf(entry)];
    const revision = revisions[keyOf(entry)];
    return assetId === undefined || revision === undefined
      ? []
      : [{ assetId, revision, write: entry.write }];
  });
  if (writes.length === 0) {
    return;
  }
  const last = await tx
    .select({ assetId: assetRepoBundles.assetId, sequence: max(assetRepoBundles.sequence) })
    .from(assetRepoBundles)
    .where(
      inArray(
        assetRepoBundles.assetId,
        writes.map(({ assetId }) => assetId)
      )
    )
    .groupBy(assetRepoBundles.assetId);
  const sequences = new Map(last.map((row) => [row.assetId, row.sequence ?? 0]));
  for (const { assetId, revision, write } of writes) {
    const sequence = sequences.get(assetId) ?? 0;
    if (write.baseCommit === null && sequence > 0) {
      // The rows of an earlier repository under this id would become part of the new one.
      throw new AppError("CONFLICT", "The asset has a repository already", {
        reason: "repository_exists"
      });
    }
    sequences.set(assetId, sequence + 1);
    const save = { clientInstanceId, assetId, operationRunId: write.operationRunId };
    const [pending] = await tx.select().from(assetRepoBundles).where(saveOf(save)).for("update");
    if (pending?.state !== "pending" || pending.objectKey === null) {
      throw new AppError("CONFLICT", "The save has no pending bundle any more", {
        reason: "save_not_pending"
      });
    }
    if (
      pending.tipCommit !== write.commit ||
      pending.prerequisiteCommit !== write.baseCommit ||
      (pending.kind === "full") !== (write.baseCommit === null)
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The bundle of the save is not the one of this commit on this base: the first commit of a repository comes in a full bundle, and every other in an incremental one that stands on its base"
      );
    }
    await tx
      .update(assetRepoBundles)
      .set({ state: "live", sequence: sequence + 1 })
      .where(saveOf(save));
    if (write.checkout) {
      const bound = {
        assetId,
        baseCommit: write.commit,
        baseRevision: revision,
        updatedAt: now
      };
      await tx
        .insert(assetCheckouts)
        .values({
          ...write.checkout,
          clientInstanceId,
          ...bound,
          createdAt: now
        })
        .onConflictDoUpdate({
          target: [assetCheckouts.conversationId, assetCheckouts.folder],
          set: bound
        });
    }
  }
}
