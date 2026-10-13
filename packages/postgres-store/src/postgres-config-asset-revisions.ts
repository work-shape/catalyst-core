import { and, eq, type SQL } from "drizzle-orm";
import type { ConfigAssetRevisionRecord, ConfigAssetStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { mapConfigAssetRevision } from "./rows";
import { configAssetRevisions, configAssets } from "./schema";

// The reads of one revision of an asset: by its number, as the asset operations name it, and
// by its id, as a reader names it that kept the id of the revision it started on.

export async function getConfigAssetRevision(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["getConfigAssetRevision"]>[0]
): Promise<ConfigAssetRevisionRecord | undefined> {
  return readRevision(db, input, eq(configAssetRevisions.revision, input.revision));
}

export async function getConfigAssetRevisionById(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["getConfigAssetRevisionById"]>[0]
): Promise<ConfigAssetRevisionRecord | undefined> {
  return readRevision(db, input, eq(configAssetRevisions.id, input.revisionId));
}

/** One revision of the named asset, by whatever tells it from the asset's other revisions. */
async function readRevision(
  db: PostgresConnection,
  asset: Pick<
    Parameters<ConfigAssetStore["getConfigAssetRevision"]>[0],
    "clientInstanceId" | "kind" | "name"
  >,
  which: SQL
): Promise<ConfigAssetRevisionRecord | undefined> {
  const [row] = await db
    .select({ revision: configAssetRevisions })
    .from(configAssetRevisions)
    .innerJoin(configAssets, eq(configAssets.id, configAssetRevisions.assetId))
    .where(
      and(
        eq(configAssets.clientInstanceId, asset.clientInstanceId),
        eq(configAssets.kind, asset.kind),
        eq(configAssets.name, asset.name),
        eq(configAssetRevisions.clientInstanceId, asset.clientInstanceId),
        which
      )
    )
    .limit(1);
  return row ? mapConfigAssetRevision(row.revision) : undefined;
}
