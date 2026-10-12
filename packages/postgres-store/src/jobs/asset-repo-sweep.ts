import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { ConfigAssetStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
import { assetRepoBundles, configAssets } from "../schema";

// The pass of the sweeper over the ledger of asset repositories. It claims rows the way a
// job claims work, passing over what somebody holds, and calls the object store under no lock:
// no save and no other pass waits for the store.

export async function sweepAssetRepoSaves(
  db: PostgresConnection,
  input: Parameters<ConfigAssetStore["sweepAssetRepoSaves"]>[0]
): ReturnType<ConfigAssetStore["sweepAssetRepoSaves"]> {
  const now = new Date();
  // First the rows, and that is committed: a swept row never becomes part of a repository.
  // A row somebody holds, such as the one a save is finishing right now, is passed over and
  // not waited for: the next pass finds it if it is still pending. A row of any state whose
  // asset is gone is given up with them: that is what a removal by a release that did not
  // know these rows leaves.
  const given = sql`
    select ${assetRepoBundles.assetId}, ${assetRepoBundles.operationRunId}
    from ${assetRepoBundles}
    where ${assetRepoBundles.savedAt} < ${input.olderThan.toISOString()}
      and (
        ${assetRepoBundles.state} = 'pending'
        or (
          ${assetRepoBundles.state} = 'live'
          and not exists (
            select 1 from ${configAssets} where ${configAssets.id} = ${assetRepoBundles.assetId}
          )
        )
      )
    order by ${assetRepoBundles.savedAt}
    limit ${input.limit}
    for update of ${assetRepoBundles} skip locked`;
  const marked = await db
    .update(assetRepoBundles)
    .set({ state: "swept", sweptAt: now, sequence: null })
    .where(
      and(
        sql`(${assetRepoBundles.assetId}, ${assetRepoBundles.operationRunId}) in (
          select asset_id, operation_run_id from (${given}) as given
        )`,
        ne(assetRepoBundles.state, "swept")
      )
    )
    .returning({ assetId: assetRepoBundles.assetId });

  // Then the objects, outside of any transaction: whatever fails here leaves a swept row, and
  // the next pass removes its object again.
  const rows = await db
    .select()
    .from(assetRepoBundles)
    .where(eq(assetRepoBundles.state, "swept"))
    .orderBy(asc(assetRepoBundles.sweptAt))
    .limit(input.limit);
  let removed = 0;
  const failures: unknown[] = [];
  for (const row of rows) {
    try {
      if (row.objectKey !== null) {
        await input.removeObject({
          clientInstanceId: row.clientInstanceId,
          assetId: row.assetId,
          objectKey: row.objectKey
        });
      }
    } catch (error) {
      failures.push(error);
      continue;
    }
    // The row outlives its object by the same time a save may take: a put that was on its
    // way when the row was swept writes the object again, and a later pass removes it.
    if (row.sweptAt !== null && row.sweptAt < input.olderThan) {
      await db
        .delete(assetRepoBundles)
        .where(
          and(
            eq(assetRepoBundles.assetId, row.assetId),
            eq(assetRepoBundles.operationRunId, row.operationRunId),
            eq(assetRepoBundles.state, "swept")
          )
        );
      removed += 1;
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
  return { swept: marked.length, removed };
}
