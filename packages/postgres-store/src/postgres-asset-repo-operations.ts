import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import {
  AppError,
  type AssetRepoBundle,
  type AssetRepoWrite,
  type ClientInstanceId,
  type ConfigAssetMutation,
  type ConfigAssetStore
} from "@vivd-catalyst/core";
import type { PostgresConnection, PostgresTransaction } from "./postgres-database";
import { assetCheckouts, assetRepoBundles } from "./schema";

// The ledger of the repositories of assets. Postgres says which bundles make a repository and
// which commit its draft is at; a write that adds a commit adds its bundle row in the
// transaction that writes the revision, under the lock every write of an asset takes.

function mapBundle(row: typeof assetRepoBundles.$inferSelect): AssetRepoBundle {
  return {
    assetId: row.assetId,
    sequence: row.sequence,
    objectKey: row.objectKey,
    kind: row.kind,
    tipCommit: row.tipCommit,
    ...(row.prerequisiteCommit ? { prerequisiteCommit: row.prerequisiteCommit } : {}),
    bytes: row.bytes,
    sha256: row.sha256,
    ...(row.supersededAt ? { supersededAt: row.supersededAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString()
  };
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
        input.includeSuperseded ? undefined : isNull(assetRepoBundles.supersededAt)
      )
    )
    .orderBy(asc(assetRepoBundles.sequence));
  return rows.map(mapBundle);
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
    if ((write.bundle.kind === "full") !== (write.baseCommit === null)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The first commit of a repository comes in a full bundle, and every other in an incremental one"
      );
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
 * Adds the bundle row of each repository write and binds its folder, once the revisions of the
 * batch are written. `revisions` and `assetIds` are what the batch gave each asset it wrote,
 * keyed `<kind>:<name>`.
 */
export async function insertRepoWrites(
  tx: PostgresTransaction,
  clientInstanceId: ClientInstanceId,
  now: Date,
  locked: readonly LockedRepoWrite[],
  written: {
    revisions: Readonly<Record<string, number>>;
    assetIds: Readonly<Record<string, string>>;
  }
): Promise<void> {
  const writes = locked.flatMap((entry) => {
    const assetId = written.assetIds[keyOf(entry)];
    const revision = written.revisions[keyOf(entry)];
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
    await tx.insert(assetRepoBundles).values({
      assetId,
      sequence: sequence + 1,
      clientInstanceId,
      objectKey: write.bundle.objectKey,
      kind: write.bundle.kind,
      tipCommit: write.commit,
      prerequisiteCommit: write.baseCommit,
      bytes: write.bundle.bytes,
      sha256: write.bundle.sha256,
      createdAt: now
    });
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
