import { and, eq, isNull, notExists } from "drizzle-orm";
import type { LiveOnceSwitch, LiveOnceSwitchStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { configAssets } from "./schema/configAssets";
import { liveOnceSwitches } from "./schema/liveOnceSwitches";

type SwitchRow = typeof liveOnceSwitches.$inferSelect;
type Input<Method extends keyof LiveOnceSwitchStore> = Parameters<LiveOnceSwitchStore[Method]>[0];

export async function switchLiveOnceOn(
  db: PostgresConnection,
  input: Input<"switchOn">
): Promise<{ cleared: LiveOnceSwitch[] }> {
  const { asset, switchedBy, ...set } = input.switch;
  const cleared = await clearStale(db, input.clientInstanceId, asset.id);
  const row = {
    revisionId: set.revisionId,
    switchedByLabel: switchedBy.label,
    switchedAt: new Date(set.switchedAt),
    // Set again, the switch is unused again.
    usedByRunId: null,
    usedAt: null
  };
  await db
    .insert(liveOnceSwitches)
    .values({
      clientInstanceId: input.clientInstanceId,
      assetId: asset.id,
      assetKind: asset.kind,
      assetName: asset.name,
      part: set.part,
      switchedById: switchedBy.id,
      ...row
    })
    .onConflictDoUpdate({
      target: [liveOnceSwitches.assetId, liveOnceSwitches.part, liveOnceSwitches.switchedById],
      set: row
    });
  return { cleared };
}

export async function takeLiveOnceSwitch(
  db: PostgresConnection,
  input: Input<"take">
): ReturnType<LiveOnceSwitchStore["take"]> {
  const cleared = await clearStale(db, input.clientInstanceId, input.assetId);
  const owned = and(
    eq(liveOnceSwitches.clientInstanceId, input.clientInstanceId),
    eq(liveOnceSwitches.assetId, input.assetId),
    eq(liveOnceSwitches.part, input.part),
    eq(liveOnceSwitches.revisionId, input.revisionId),
    eq(liveOnceSwitches.switchedById, input.switchedBy)
  );
  const { forRun } = input;
  if (forRun === undefined) {
    // One statement: of two calls that take the same switch at once, one deletes the row.
    const [taken] = await db
      .delete(liveOnceSwitches)
      .where(and(owned, isNull(liveOnceSwitches.usedByRunId)))
      .returning();
    return {
      ...(taken ? { taken: mapSwitch(taken) } : {}),
      firstUse: taken !== undefined,
      cleared
    };
  }
  // One statement binds an unused switch to the run: of the calls of two runs, or of the items
  // of one run, that ask at once, the first binds it, and every call of that run finds it bound.
  const [bound] = await db
    .update(liveOnceSwitches)
    .set({ usedByRunId: forRun, usedAt: new Date(input.at) })
    .where(and(owned, isNull(liveOnceSwitches.usedByRunId)))
    .returning();
  if (bound) return { taken: mapSwitch(bound), firstUse: true, cleared };
  const [held] = await db
    .select()
    .from(liveOnceSwitches)
    .where(and(owned, eq(liveOnceSwitches.usedByRunId, forRun)));
  return { ...(held ? { taken: mapSwitch(held) } : {}), firstUse: false, cleared };
}

export async function listLiveOnceSwitches(
  db: PostgresConnection,
  input: Input<"list">
): Promise<LiveOnceSwitch[]> {
  const rows = await db
    .select({ row: liveOnceSwitches })
    .from(liveOnceSwitches)
    .innerJoin(
      configAssets,
      and(
        eq(configAssets.id, liveOnceSwitches.assetId),
        eq(configAssets.activeRevisionId, liveOnceSwitches.revisionId)
      )
    )
    .where(
      and(
        eq(liveOnceSwitches.clientInstanceId, input.clientInstanceId),
        eq(liveOnceSwitches.assetId, input.assetId),
        eq(liveOnceSwitches.switchedById, input.switchedBy)
      )
    )
    .orderBy(liveOnceSwitches.part);
  return rows.map(({ row }) => mapSwitch(row));
}

export function clearStaleLiveOnceSwitches(
  db: PostgresConnection,
  input: Input<"clearStale">
): Promise<LiveOnceSwitch[]> {
  return clearStale(db, input.clientInstanceId, input.assetId);
}

/**
 * Deletes the unused switches of an asset set for a revision that is no longer its draft. A
 * switch a test run is bound to stays: a draft saved while that run goes on leaves the later
 * items of the step live for that run, which started on the revision the switch was set for.
 * Its owner sets it again for the new draft, which replaces the row.
 */
async function clearStale(
  db: PostgresConnection,
  clientInstanceId: Input<"take">["clientInstanceId"],
  assetId: string
): Promise<LiveOnceSwitch[]> {
  const rows = await db
    .delete(liveOnceSwitches)
    .where(
      and(
        eq(liveOnceSwitches.clientInstanceId, clientInstanceId),
        eq(liveOnceSwitches.assetId, assetId),
        isNull(liveOnceSwitches.usedByRunId),
        notExists(
          db
            .select({ id: configAssets.id })
            .from(configAssets)
            .where(
              and(
                eq(configAssets.id, liveOnceSwitches.assetId),
                eq(configAssets.status, "active"),
                eq(configAssets.activeRevisionId, liveOnceSwitches.revisionId)
              )
            )
        )
      )
    )
    .returning();
  return rows.map(mapSwitch);
}

function mapSwitch(row: SwitchRow): LiveOnceSwitch {
  return {
    asset: { kind: row.assetKind, id: row.assetId, name: row.assetName },
    revisionId: row.revisionId,
    part: row.part,
    switchedBy: { id: row.switchedById, label: row.switchedByLabel },
    switchedAt: row.switchedAt.toISOString(),
    ...(row.usedByRunId === null ? {} : { usedByRunId: row.usedByRunId }),
    ...(row.usedAt === null ? {} : { usedAt: row.usedAt.toISOString() })
  };
}
