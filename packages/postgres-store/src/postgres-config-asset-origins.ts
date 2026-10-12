import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ConfigAssetFromPage, ConfigAssetStore } from "@vivd-catalyst/core";
import { publishedColumns, publishedRevisions } from "./postgres-config-asset-operations";
import type { PostgresConnection } from "./postgres-database";
import { mapConfigAsset } from "./rows";
import { configAssetRevisions, configAssets } from "./schema";

// The reads of assets by where their first revision came from.

/** The revisions an asset's first one is read from, beside the active and the published one. */
const firstRevisions = alias(configAssetRevisions, "first_revisions");

export async function listConfigAssetsFromPage(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["listConfigAssetsFromPage"]>[0]
): Promise<ConfigAssetFromPage[]> {
  // One probe of the index on `(asset_id, revision)` per asset, whatever its revisions number.
  const first = db
    .select({ actor: firstRevisions.actor, origin: firstRevisions.origin })
    .from(firstRevisions)
    .where(eq(firstRevisions.assetId, configAssets.id))
    .orderBy(asc(firstRevisions.revision))
    .limit(1)
    .as("first_revision");
  const rows = await db
    .select({
      asset: configAssets,
      revision: configAssetRevisions,
      published: publishedColumns,
      savedBy: first.actor
    })
    .from(configAssets)
    .innerJoinLateral(first, sql`true`)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .leftJoin(publishedRevisions, eq(publishedRevisions.id, configAssets.publishedRevisionId))
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, input.kind),
        eq(configAssets.status, "active"),
        sql`${first.origin} @> ${JSON.stringify({ kind: "page", pageId: input.pageId })}::jsonb`
      )
    )
    .orderBy(asc(configAssets.createdAt), asc(configAssets.id))
    .limit(input.limit);
  return rows.map((row) => ({
    asset: mapConfigAsset(row.asset, row.revision, row.published),
    savedBy: row.savedBy
  }));
}
