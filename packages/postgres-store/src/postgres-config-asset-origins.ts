import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ConfigAssetFromPage, ConfigAssetStore } from "@vivd-catalyst/core";
import { publishedColumns, publishedRevisions } from "./postgres-config-asset-operations";
import type { PostgresConnection } from "./postgres-database";
import { mapConfigAsset } from "./rows";
import { configAssetRevisions, configAssets } from "./schema";

// The reads of assets by the Page their revisions came from.

/** The revisions an asset's Page is read from, beside the active and the published one. */
const pageRevisions = alias(configAssetRevisions, "page_revisions");
const namesPage = sql`${pageRevisions.origin} ->> 'kind' = 'page'`;

export async function listConfigAssetsFromPage(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["listConfigAssetsFromPage"]>[0]
): Promise<ConfigAssetFromPage[]> {
  // Every active asset of the kind is read, and of each its revisions from the newest back to
  // the first that names a Page: one where the newest does, all of them where none does. No
  // index narrows the read to a Page.
  const linked = db
    .select({ actor: pageRevisions.actor, origin: pageRevisions.origin })
    .from(pageRevisions)
    .where(and(eq(pageRevisions.assetId, configAssets.id), namesPage))
    .orderBy(desc(pageRevisions.revision))
    .limit(1)
    .as("linked_revision");
  const rows = await db
    .select({
      asset: configAssets,
      revision: configAssetRevisions,
      published: publishedColumns,
      savedBy: linked.actor
    })
    .from(configAssets)
    .innerJoinLateral(linked, sql`true`)
    .innerJoin(configAssetRevisions, eq(configAssetRevisions.id, configAssets.activeRevisionId))
    .leftJoin(publishedRevisions, eq(publishedRevisions.id, configAssets.publishedRevisionId))
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, input.kind),
        eq(configAssets.status, "active"),
        sql`${linked.origin} ->> 'pageId' = ${input.pageId}`
      )
    )
    .orderBy(asc(configAssets.createdAt), asc(configAssets.id))
    .limit(input.limit)
    .offset(input.offset ?? 0);
  return rows.map((row) => ({
    asset: mapConfigAsset(row.asset, row.revision, row.published),
    savedBy: row.savedBy
  }));
}

export async function getConfigAssetPageOrigin(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["getConfigAssetPageOrigin"]>[0]
): ReturnType<ConfigAssetStore["getConfigAssetPageOrigin"]> {
  const [row] = await db
    .select({ origin: pageRevisions.origin })
    .from(pageRevisions)
    .innerJoin(configAssets, eq(configAssets.id, pageRevisions.assetId))
    .where(
      and(
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(pageRevisions.assetId, input.assetId),
        namesPage
      )
    )
    .orderBy(desc(pageRevisions.revision))
    .limit(1);
  return row?.origin?.kind === "page" ? row.origin : undefined;
}
