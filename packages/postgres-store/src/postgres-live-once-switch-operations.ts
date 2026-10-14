import { and, eq, notExists } from "drizzle-orm";
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
    switchedById: switchedBy.id,
    switchedByLabel: switchedBy.label,
    switchedAt: new Date(set.switchedAt)
  };
  await db
    .insert(liveOnceSwitches)
    .values({
      clientInstanceId: input.clientInstanceId,
      assetId: asset.id,
      assetKind: asset.kind,
      assetName: asset.name,
      part: set.part,
      ...row
    })
    .onConflictDoUpdate({ target: [liveOnceSwitches.assetId, liveOnceSwitches.part], set: row });
  return { cleared };
}

export async function takeLiveOnceSwitch(
  db: PostgresConnection,
  input: Input<"take">
): Promise<{ taken?: LiveOnceSwitch; cleared: LiveOnceSwitch[] }> {
  const cleared = await clearStale(db, input.clientInstanceId, input.assetId);
  // One statement: of two calls that take the same switch at once, one deletes the row.
  const [taken] = await db
    .delete(liveOnceSwitches)
    .where(
      and(
        eq(liveOnceSwitches.clientInstanceId, input.clientInstanceId),
        eq(liveOnceSwitches.assetId, input.assetId),
        eq(liveOnceSwitches.part, input.part),
        eq(liveOnceSwitches.revisionId, input.revisionId)
      )
    )
    .returning();
  return { ...(taken ? { taken: mapSwitch(taken) } : {}), cleared };
}

export function clearStaleLiveOnceSwitches(
  db: PostgresConnection,
  input: Input<"clearStale">
): Promise<LiveOnceSwitch[]> {
  return clearStale(db, input.clientInstanceId, input.assetId);
}

/** Deletes the switches of an asset set for a revision that is no longer its draft. */
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
    switchedAt: row.switchedAt.toISOString()
  };
}
