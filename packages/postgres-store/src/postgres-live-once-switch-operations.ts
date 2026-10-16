import { and, desc, eq, notExists, sql } from "drizzle-orm";
import { type LiveOnceSwitch, type LiveOnceSwitchStore } from "@work-shape/catalyst-core";
import { type PostgresConnection } from "./postgres-database";
import { configAssets } from "./schema/configAssets";
import { liveOnceRuns, liveOnceSwitches } from "./schema/liveOnceSwitches";

type SwitchRow = typeof liveOnceSwitches.$inferSelect;
type RunRow = typeof liveOnceRuns.$inferSelect;
type Input<Method extends keyof LiveOnceSwitchStore> = Parameters<LiveOnceSwitchStore[Method]>[0];

/** How many bindings of one owner on one asset a page's read looks through. */
const LIST_BINDINGS_MAX = 200;

async function switchLiveOnceOn(
  db: PostgresConnection,
  input: Input<"switchOn">
): Promise<{ cleared: LiveOnceSwitch[] }> {
  const { asset, switchedBy, ...set } = input.switch;
  const cleared = await clearStale(db, input.clientInstanceId, asset.id);
  const row = {
    revisionId: set.revisionId,
    switchedByLabel: switchedBy.label,
    switchedAt: new Date(set.switchedAt)
  };
  // A switch a test run took is no longer here: the new one waits for its owner's next run.
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

async function takeLiveOnceSwitch(
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
    const [taken] = await db.delete(liveOnceSwitches).where(owned).returning();
    return {
      ...(taken ? { taken: mapSwitch(taken) } : {}),
      firstUse: taken !== undefined,
      cleared
    };
  }
  // A step of a test run: the run keeps the switch it took to its end, whatever its owner sets
  // since. A draft saved meanwhile clears no switch a run took, so the later items of a step
  // that is live for this run stay live, on the revision the run started on.
  const bound = await bindingOf(db, input.clientInstanceId, forRun, input.part);
  if (bound) return { taken: mapBinding(bound), firstUse: false, cleared };
  // One statement takes the switch and binds it to the run. Of the items of one run that ask
  // at once, one takes it; the others find the binding below once that statement committed.
  const usedAt = new Date(input.at).toISOString();
  const result = await db.execute<{ part: string }>(sql`
    with taken as (
      delete from ${liveOnceSwitches} where ${owned} returning *
    )
    insert into ${liveOnceRuns} (
      client_instance_id, workflow_run_id, part, asset_id, asset_kind, asset_name, revision_id,
      switched_by_id, switched_by_label, switched_at, used_at
    )
    select client_instance_id, ${forRun}, part, asset_id, asset_kind, asset_name, revision_id,
      switched_by_id, switched_by_label, switched_at, ${usedAt}::timestamptz
    from taken
    on conflict do nothing
    returning part
  `);
  const firstUse = result.length > 0;
  const held = await bindingOf(db, input.clientInstanceId, forRun, input.part);
  return {
    ...(held ? { taken: mapBinding(held) } : {}),
    firstUse: firstUse && held !== undefined,
    cleared
  };
}

async function bindingOf(
  db: PostgresConnection,
  clientInstanceId: Input<"take">["clientInstanceId"],
  workflowRunId: string,
  part: string
): Promise<RunRow | undefined> {
  const [row] = await db
    .select()
    .from(liveOnceRuns)
    .where(
      and(
        eq(liveOnceRuns.clientInstanceId, clientInstanceId),
        eq(liveOnceRuns.workflowRunId, workflowRunId),
        eq(liveOnceRuns.part, part)
      )
    );
  return row;
}

/**
 * One owner's switches on the asset's current draft: each set one, and of each part the test
 * run that last used a switch on that draft.
 */
async function listLiveOnceSwitches(
  db: PostgresConnection,
  input: Input<"list">
): Promise<LiveOnceSwitch[]> {
  const onDraft = and(
    eq(configAssets.id, input.assetId),
    eq(configAssets.clientInstanceId, input.clientInstanceId)
  );
  const set = await db
    .select({ row: liveOnceSwitches })
    .from(liveOnceSwitches)
    .innerJoin(
      configAssets,
      and(onDraft, eq(configAssets.activeRevisionId, liveOnceSwitches.revisionId))
    )
    .where(
      and(
        eq(liveOnceSwitches.assetId, input.assetId),
        eq(liveOnceSwitches.switchedById, input.switchedBy)
      )
    )
    .orderBy(liveOnceSwitches.part);
  const used = await db
    .select({ row: liveOnceRuns })
    .from(liveOnceRuns)
    .innerJoin(
      configAssets,
      and(onDraft, eq(configAssets.activeRevisionId, liveOnceRuns.revisionId))
    )
    .where(
      and(eq(liveOnceRuns.assetId, input.assetId), eq(liveOnceRuns.switchedById, input.switchedBy))
    )
    .orderBy(desc(liveOnceRuns.usedAt))
    .limit(LIST_BINDINGS_MAX);
  const lastUse = new Map<string, RunRow>();
  for (const { row } of used) if (!lastUse.has(row.part)) lastUse.set(row.part, row);
  return [...set.map(({ row }) => mapSwitch(row)), ...[...lastUse.values()].map(mapBinding)];
}

function clearStaleLiveOnceSwitches(
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

function mapBinding(row: RunRow): LiveOnceSwitch {
  return {
    asset: { kind: row.assetKind, id: row.assetId, name: row.assetName },
    revisionId: row.revisionId,
    part: row.part,
    switchedBy: { id: row.switchedById, label: row.switchedByLabel },
    switchedAt: row.switchedAt.toISOString(),
    usedByRunId: row.workflowRunId,
    usedAt: row.usedAt.toISOString()
  };
}

export function createPostgresLiveOnceSwitchesStore(db: PostgresConnection): LiveOnceSwitchStore {
  return {
    switchOn: (input) => switchLiveOnceOn(db, input),
    take: (input) => takeLiveOnceSwitch(db, input),
    clearStale: (input) => clearStaleLiveOnceSwitches(db, input),
    list: (input) => listLiveOnceSwitches(db, input)
  };
}
