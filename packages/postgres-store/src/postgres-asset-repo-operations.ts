import { and, asc, eq, inArray, isNull, max, ne, sql } from "drizzle-orm";
import {
  AppError,
  assetRepoBundleObjectKey,
  type AssetRepoSave,
  type AssetRepoSaveBundle,
  type AssetRepoWrite,
  type ClientInstanceId,
  type ConfigAssetMutation,
  type ConfigAssetStore
} from "@work-shape/catalyst-core";
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

const sameBundle = (left: AssetRepoSaveBundle, right: AssetRepoSaveBundle) =>
  left.objectKey === right.objectKey &&
  left.kind === right.kind &&
  left.tipCommit === right.tipCommit &&
  left.prerequisiteCommit === right.prerequisiteCommit &&
  left.bytes === right.bytes &&
  left.sha256 === right.sha256;

function mapSave(row: BundleRow): AssetRepoSave {
  const bundle = namedBundle(row);
  return {
    assetId: row.assetId,
    operationRunId: row.operationRunId,
    state: row.state,
    savedAt: row.savedAt.toISOString(),
    ...(bundle ? { bundle } : {}),
    ...(row.request ? { request: row.request } : {}),
    ...(row.result ? { result: row.result } : {})
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

export async function getAssetRepoSave(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["getAssetRepoSave"]>[0]
): ReturnType<ConfigAssetStore["getAssetRepoSave"]> {
  const [row] = await db.select().from(assetRepoBundles).where(saveOf(input)).limit(1);
  return row ? mapSave(row) : undefined;
}

export async function answerAssetRepoSave(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["answerAssetRepoSave"]>[0]
): ReturnType<ConfigAssetStore["answerAssetRepoSave"]> {
  const { result } = input;
  const written = await db
    .update(assetRepoBundles)
    // The files of a save that ended for good are not asked for again.
    .set(result === null || result.status === "failed" ? { result } : { result, request: null })
    .where(
      and(
        saveOf(input),
        eq(assetRepoBundles.state, "pending"),
        result === null
          ? sql`${assetRepoBundles.result}->>'status' = 'failed'`
          : isNull(assetRepoBundles.result)
      )
    )
    .returning({ assetId: assetRepoBundles.assetId });
  return written.length > 0;
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
    const named = namedBundle(row);
    if (named) {
      // A save keeps the bundle it named: its object may be in the store already, and an
      // attempt that is about to finish the save put exactly that one.
      if (!sameBundle(named, bundle)) {
        throw new AppError("CONFLICT", "The save named another bundle before", {
          reason: "pending_bundle_differs",
          objectKey: named.objectKey
        });
      }
      return;
    }
    // The key holds the commit and the hash, so only a save of the same files on the same base
    // by the same author in the same second names it too. One of the two is enough.
    const [other] = await tx
      .select({ operationRunId: assetRepoBundles.operationRunId })
      .from(assetRepoBundles)
      .where(eq(assetRepoBundles.objectKey, bundle.objectKey))
      .limit(1);
    if (other) {
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

/**
 * Gives up the rows of assets that are being removed, in the transaction that removes them.
 * The sweeper removes each of their objects by its row, so nothing depends on what the
 * remover does after its transaction.
 */
export async function sweepAssetRepoBundlesOf(
  tx: PostgresTransaction,
  assetIds: readonly string[]
): Promise<void> {
  if (assetIds.length > 0) {
    await tx
      .update(assetRepoBundles)
      .set({ state: "swept", sweptAt: new Date(), sequence: null })
      .where(
        and(inArray(assetRepoBundles.assetId, [...assetIds]), ne(assetRepoBundles.state, "swept"))
      );
  }
}

/**
 * Asks the object store for the bundle of every repository write of a batch, before the
 * transaction. It is enough to ask before: the key of a pending row never changes, and an
 * object is removed only once its row is swept, which the transaction refuses.
 */
export async function assertRepoObjects(
  input: Parameters<ConfigAssetStore["applyConfigAssetMutations"]>[0]
): Promise<void> {
  for (const mutation of input.mutations) {
    if (mutation.type !== "upsert" || !mutation.repository) {
      continue;
    }
    const { bundle } = mutation.repository;
    const size = await input.repositoryObjectSize?.(bundle.objectKey);
    if (size !== bundle.bytes) {
      throw new AppError("CONFLICT", "The bundle of the save is not in the store", {
        reason: "bundle_object_missing",
        objectKey: bundle.objectKey
      });
    }
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

/** The assets a batch names, as it found them under its lock. */
type StoredAssets = readonly {
  asset: { kind: string; name: string };
  /** The revision the draft pointer names. A deleted asset is at its tombstone. */
  revision: { commit: string | null; tree: string | null };
}[];

/**
 * The repository writes of a batch, each held against the asset as it is under the lock of
 * the write.
 *
 * An asset that has a repository is written with a commit and once in a batch: its draft
 * always names a commit, and the bundle and the folder of a write are bound to the revision
 * the batch leaves it at. A write of it without a commit, or a second mutation of it beside
 * the write, is refused. Deleting it alone is not a write of its content.
 *
 * A write whose base is not the commit of the draft any more is refused with the reason
 * `draft_moved`. It is asked before anything else is compared, so the one of two saves from the
 * same base that comes second is told that the draft moved. A deleted asset keeps its history:
 * its tombstone names the last commit, and the write that brings it back stands on that one.
 */
export function lockedRepoWrites(
  mutations: readonly ConfigAssetMutation[],
  stored: StoredAssets
): LockedRepoWrite[] {
  const writes: LockedRepoWrite[] = [];
  for (const mutation of mutations) {
    if (mutation.type !== "upsert") {
      continue;
    }
    const { kind, name, repository: write } = mutation;
    const row = stored.find((candidate) => keyOf(candidate.asset) === keyOf(mutation));
    const draftCommit = row?.revision.commit ?? null;
    if (!write) {
      if (draftCommit !== null) {
        throw new AppError(
          "VALIDATION_FAILED",
          `The content of ${kind} '${name}' is a repository: a write of it names the commit it adds`,
          { reason: "repository_write_without_commit", kind, name }
        );
      }
      continue;
    }
    const same = mutations.filter(
      (other) => other.type !== "setDefaultAgent" && keyOf(other) === keyOf(mutation)
    );
    if (same.length > 1) {
      throw new AppError(
        "VALIDATION_FAILED",
        "A batch that adds a commit to an asset writes that asset once"
      );
    }
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

/**
 * The commit and tree the tombstone of each asset keeps: those of the revision it is deleted
 * at. So a deleted asset still says where its history ends, and comes back on it.
 */
export function tombstoneColumns(stored: StoredAssets) {
  return (key: string) => {
    const row = stored.find((candidate) => keyOf(candidate.asset) === key);
    return { commit: row?.revision.commit ?? null, tree: row?.revision.tree ?? null };
  };
}

/**
 * What an upsert writes into its revision: its content, and the commit and tree where it adds
 * a commit. Those two are empty for a write without a repository.
 */
export function writtenColumns(mutation: Extract<ConfigAssetMutation, { type: "upsert" }>) {
  return {
    config: mutation.config,
    fileSetId: mutation.fileSetId ?? null,
    commit: mutation.repository?.commit ?? null,
    tree: mutation.repository?.tree ?? null
  };
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
    // The row must name the very object this attempt put: its key, its hash and its size.
    if (
      pending.objectKey !== write.bundle.objectKey ||
      pending.sha256 !== write.bundle.sha256 ||
      pending.bytes !== write.bundle.bytes
    ) {
      throw new AppError("CONFLICT", "The save named another bundle than this attempt put", {
        reason: "pending_bundle_differs",
        objectKey: pending.objectKey
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
      .set({ state: "live", sequence: sequence + 1, request: null })
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
