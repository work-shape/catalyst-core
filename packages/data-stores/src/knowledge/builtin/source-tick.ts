import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CONNECTION_ASSET_KIND,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_JOB_KINDS,
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  isOperationRunId,
  lastDueWithin,
  nextDueAfter,
  parseCron,
  scheduledJobPayloadSchema,
  type CronExpression,
  type JobControl,
  type KnowledgeSyncJobPayload
} from "@work-shape/catalyst-core";
import { knowledgeBaseDefinitionSchema } from "../definition";
import { sourceBoundaryKey, type SyncedSource } from "../source-boundary";
import type { KnowledgeListingMode } from "../source-port";
import { enqueueSourceSync, sourceSyncStarted } from "./source-lifecycle";
import { sourceTarget, type SourceJobRuntime } from "./source-runtime";
import { createSourceStore, RETRY_RUN_SQL, sourceTransaction } from "./source-store";

// The source's own schedule (spec: Freshness). One tick a minute decides from the definition and
// the clock which sources could be due, and reads only those from their stores, each on a
// connection of its own for that read. It writes nothing for a source with nothing due, and a
// due source gets a job: the tick calls no source and holds nothing between sources. A tick after
// a start or after downtime reads every source, and a time it missed is made up for once.

const MINUTE_MS = 60_000;
const SOURCE_TICK_INTERVAL_MS = MINUTE_MS;
/** Knowledge Bases read at a time. */
const SOURCE_TICK_PAGE = 100;
const SOURCE_POLL_MINUTES_DEFAULT = 15;
const SOURCE_FULL_PASS_DEFAULT = "0 2 * * *";

export const sourceTickJob = defineJobKind({
  kind: KNOWLEDGE_JOB_KINDS.sourceTick,
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 5 * MINUTE_MS,
  concurrency: { global: 1 },
  manualRetry: false
});

export const knowledgeSourceTickSchedule = defineSchedule({
  kind: sourceTickJob,
  every: SOURCE_TICK_INTERVAL_MS,
  dueAtStart: true
});

/** The latest `changes` due time of a source. Each source has its own minute, so they spread. */
export function changesDueAt(
  knowledgeBaseId: string,
  sourceId: string,
  pollMinutes: number,
  now: Date
): Date {
  const pollMs = pollMinutes * MINUTE_MS;
  const phaseMs =
    (createHash("sha256")
      .update(JSON.stringify([knowledgeBaseId, sourceId]))
      .digest()
      .readUInt32BE(0) %
      pollMinutes) *
    MINUTE_MS;
  return new Date(Math.floor((now.getTime() - phaseMs) / pollMs) * pollMs + phaseMs);
}

/** What the tick reads of a source. */
export interface SourceTickState {
  /** A sync is running, waiting or stopped: whatever is due now joins it. */
  running: boolean;
  /** A pass has ended `done`: the first import is behind it. */
  imported: boolean;
  /** The source has a change feed for its boundary, or gets one from its next listing. */
  polled: boolean;
  lastStartedAt?: Date | undefined;
  /** When the last `initial` or `full` pass ended, whether or not it succeeded. */
  lastPassEndedAt?: Date | undefined;
}

/** The pass a source is due, if any, with the time it is due for. */
export function dueSourcePass(
  state: SourceTickState,
  schedule: { full: CronExpression; timeZone: string; changesDueAt: Date; now: Date }
): { mode: KnowledgeListingMode; scheduledFor: Date } | undefined {
  // A running sync may wait for a person, a confirmation or a provider; only they move it on.
  // A `full` pass here would also skip the stop an `initial` one waits at for a first import
  // that failed or was superseded. That source waits for a person's sync.
  if (state.running || !state.imported) return undefined;
  // Of the times since the last pass, the latest alone: downtime makes up for one.
  const full = lastDueWithin([schedule.full], new Date(0), schedule.now, schedule.timeZone);
  if (full && (!state.lastPassEndedAt || state.lastPassEndedAt < full))
    return { mode: "full", scheduledFor: full };
  // A `changes` pass of a source without a feed would be a full listing, so its only listing is
  // at `schedule.full`.
  if (!state.polled) return undefined;
  if (state.lastStartedAt && state.lastStartedAt >= schedule.changesDueAt) return undefined;
  return { mode: "changes", scheduledFor: schedule.changesDueAt };
}

const stateRow = z.object({
  running: z.boolean(),
  imported: z.boolean(),
  polled: z.boolean(),
  last_started_at: z.coerce.date().nullable(),
  last_pass_ended_at: z.coerce.date().nullable()
});

async function readTickState(
  runtime: SourceJobRuntime,
  control: JobControl,
  knowledgeBaseId: string,
  source: SyncedSource
): Promise<SourceTickState> {
  const [row] = z.array(stateRow).parse(
    await createSourceStore(runtime.data, knowledgeBaseId, control.signal).change((sql) =>
      sql.run(
        `select
          exists(select 1 from catalyst_kb.sync_runs where source_id=$1::text and state='running') as running,
          exists(select 1 from catalyst_kb.sync_runs where source_id=$1::text and state='done' and not ${RETRY_RUN_SQL}) as imported,
          exists(select 1 from catalyst_kb.source_cursors c where c.source_id=$1::text and c.cursor<>''
            and (c.definition_key=$2::text or not exists(select 1 from catalyst_kb.sync_runs where source_id=$1::text and state='done' and definition_key=$2::text))) as polled,
          (select started_at from catalyst_kb.sync_runs where source_id=$1::text order by started_at desc limit 1) as last_started_at,
          (select ended_at from catalyst_kb.sync_runs where source_id=$1::text and mode in ('initial','full') and not ${RETRY_RUN_SQL} order by started_at desc limit 1) as last_pass_ended_at`,
        [source.id, sourceBoundaryKey(source)]
      )
    )
  );
  return {
    running: row?.running ?? true,
    imported: row?.imported ?? false,
    polled: row?.polled ?? false,
    lastStartedAt: row?.last_started_at ?? undefined,
    lastPassEndedAt: row?.last_pass_ended_at ?? undefined
  };
}

/** What a pass is once for: its dedupe key, and the ids of its run that follow from it. */
export function scheduledPass(
  knowledgeBaseId: string,
  sourceId: string,
  mode: KnowledgeListingMode,
  scheduledFor: Date
): { key: string; payload: KnowledgeSyncJobPayload } {
  const key = `${knowledgeBaseId}:${sourceId}:${mode}:${scheduledFor.toISOString()}`;
  const id = createHash("sha256").update(key).digest("hex").slice(0, 40);
  return {
    key,
    payload: {
      knowledgeBaseId,
      sourceId,
      syncRunId: `kbsync_${id}`,
      operationRunId: `oprun_${id}`
    }
  };
}

/** Starts a pass as the ingestion principal. A sync that started meanwhile is joined. */
async function startScheduledPass(
  runtime: SourceJobRuntime,
  control: JobControl,
  knowledgeBaseName: string,
  knowledgeBaseId: string,
  sourceId: string,
  due: NonNullable<ReturnType<typeof dueSourcePass>>,
  now: Date
) {
  const { key, payload } = scheduledPass(knowledgeBaseId, sourceId, due.mode, due.scheduledFor);
  const operationRunId = payload.operationRunId;
  if (!isOperationRunId(operationRunId)) throw new Error("A scheduled pass needs a run id");
  const { clientInstanceId } = runtime.data;
  await sourceTransaction(runtime.data, payload, control, async (bound, stores) => {
    if (!(await sourceTarget(runtime, payload, stores, "share"))) return;
    const started = await bound.start(payload, due.mode);
    if (!started.created) return;
    const principal = await stores.apiAccess.findServicePrincipalByOwner({
      clientInstanceId,
      owner: { kind: "knowledge_base", assetId: knowledgeBaseId }
    });
    if (!principal) throw new Error("The source ingestion principal is unavailable");
    await stores.operationRuns.create({
      id: operationRunId,
      clientInstanceId,
      operation: `knowledge.${knowledgeBaseName}.sync`,
      effect: "changing",
      actor: { kind: "service_principal", id: principal.id, label: principal.displayLabel },
      origin: { kind: "schedule", scheduleId: `${knowledgeBaseId}:${sourceId}:${due.mode}` },
      target: "live",
      inputHash: "source_schedule",
      correlationId: payload.operationRunId,
      startedAt: now.toISOString()
    });
    await enqueueSourceSync(stores, runtime.data, payload, key);
    // A poll shows on the Knowledge Base page alone; only a full pass is an event when it starts.
    if (due.mode === "full") await sourceSyncStarted(stores, runtime.data, payload);
  });
}

/** How often each Connection's source is polled. Reads nothing unless the setting names a type. */
async function pollMinutesOf(runtime: SourceJobRuntime, connections: readonly string[]) {
  const setting = runtime.input.sourcePollMinutes ?? {};
  const byConnection = new Map<string, number>();
  if (connections.length && Object.keys(setting).length) {
    const rows = await runtime.data.stores.configAssets.listConfigAssetsByKey({
      clientInstanceId: runtime.data.clientInstanceId,
      keys: connections.map((name) => ({ kind: CONNECTION_ASSET_KIND, name }))
    });
    for (const row of rows) {
      const parsed = z.object({ connectorType: z.string() }).safeParse(row.config);
      const minutes = parsed.success ? setting[parsed.data.connectorType] : undefined;
      if (minutes !== undefined) byConnection.set(row.name, minutes);
    }
  }
  return (connection: string) => byConnection.get(connection) ?? SOURCE_POLL_MINUTES_DEFAULT;
}

export function createSourceTickHandler(runtime: SourceJobRuntime) {
  const timeZone = runtime.input.timeZone ?? "UTC";
  /** When this process last looked at every source. Unset, the next tick reads them all. */
  let lookedAt: Date | undefined;

  async function tickSource(
    control: JobControl,
    knowledgeBase: { id: string; name: string },
    source: SyncedSource,
    pollMinutes: number,
    now: Date
  ) {
    const full = parseCron(source.schedule?.full ?? SOURCE_FULL_PASS_DEFAULT);
    if (!full) return;
    const changes = changesDueAt(knowledgeBase.id, source.id, pollMinutes, now);
    if (lookedAt) {
      const nextFull = nextDueAfter([full], lookedAt, timeZone);
      if (changes <= lookedAt && !(nextFull && nextFull <= now)) return;
    }
    const target = await sourceTarget(runtime, {
      knowledgeBaseId: knowledgeBase.id,
      sourceId: source.id,
      syncRunId: "",
      operationRunId: ""
    });
    if (!target) return;
    const due = dueSourcePass(await readTickState(runtime, control, knowledgeBase.id, source), {
      full,
      timeZone,
      changesDueAt: changes,
      now
    });
    if (due)
      await startScheduledPass(
        runtime,
        control,
        knowledgeBase.name,
        knowledgeBase.id,
        source.id,
        due,
        now
      );
  }

  return defineJobHandler({
    kind: sourceTickJob,
    slots: 1,
    async run(_job, control) {
      const now = runtime.input.now?.() ?? new Date();
      let afterName: string | undefined;
      for (;;) {
        const page = await runtime.data.stores.configAssets.listPublishedConfigAssets({
          clientInstanceId: runtime.data.clientInstanceId,
          kind: KNOWLEDGE_BASE_ASSET_KIND,
          ...(afterName === undefined ? {} : { afterName }),
          limit: SOURCE_TICK_PAGE
        });
        const bases = page.flatMap((asset) => {
          const definition = knowledgeBaseDefinitionSchema.safeParse(asset.publishedConfig);
          return definition.success && definition.data.sources?.length
            ? [{ id: asset.id, name: asset.name, sources: definition.data.sources }]
            : [];
        });
        const pollMinutes = await pollMinutesOf(runtime, [
          ...new Set(bases.flatMap((base) => base.sources.map((source) => source.connection)))
        ]);
        for (const base of bases)
          for (const source of base.sources) {
            control.signal.throwIfAborted();
            try {
              await tickSource(control, base, source, pollMinutes(source.connection), now);
            } catch (error) {
              // This source looks again at its next due time, and the others go on.
              control.signal.throwIfAborted();
              control.logger.warn(
                {
                  knowledgeBaseId: base.id,
                  sourceId: source.id,
                  errorName: error instanceof Error ? error.name : "unknown"
                },
                "The source tick could not look at a source"
              );
            }
          }
        if (page.length < SOURCE_TICK_PAGE) break;
        afterName = page.at(-1)?.name;
      }
      lookedAt = now;
    }
  });
}
