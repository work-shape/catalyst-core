import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DATA_STORE_ACTIONS,
  DATA_STORE_ASSET_KIND,
  DATA_STORE_MANIFEST_FILE,
  asClientInstanceId,
  asUserId,
  type DataStoreRecord
} from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { fileTestDatabaseUrl } from "./support/test-database";
import { stepRunsSchema } from "./support/workflow-instance";
import { ended, openProbeWorld, waitFor, type ProbeWorld } from "./support/workflow-probe-world";

// The Data Store's one real kill probe ends the worker after the store committed its rows,
// before the platform kept the Operation Run's outcome. Recovery must replay the answer under
// the same key without adding the rows twice. workflow-worker-kill covers an in-flight kill.

const MINUTE_MS = 60_000;
const ROWS = 1_000;
/** The lock the insert of the store waits for while the test holds it. */
const HOLD = 4711;
const clientInstanceId = asClientInstanceId("demo-local");

const files = [
  {
    path: DATA_STORE_MANIFEST_FILE,
    text: "id: findings\nname: Findings\ndescription: What the monthly check of bookings found.\n"
  },
  {
    path: "migrations/0001_init.sql",
    // The trigger lets the test hold an insert in flight: it waits while the test has the lock.
    text: `create table findings (
      run_id text not null,
      client_id text not null,
      amount numeric(14, 2)
    );
    create function hold_insert() returns trigger language plpgsql as $f$
      begin
        perform pg_advisory_xact_lock_shared(${HOLD});
        return null;
      end $f$;
    create trigger hold_insert before insert on findings
      for each statement execute function hold_insert();`
  }
];

const WORKFLOW = {
  id: "monthly-check",
  name: "Monthly check",
  runAs: "workflow-runner",
  inputs: {
    type: "object",
    properties: { rows: { type: "array", items: { type: "object" } } },
    required: ["rows"]
  },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "store",
      name: "Store the findings",
      type: "operation",
      operation: "data_store.findings.insert",
      input: {
        table: { value: "findings" },
        rows: { ref: { step: "start", path: "input.rows" } }
      }
    },
    {
      id: "result",
      name: "Result",
      type: "output",
      input: { inserted: { ref: { step: "store", path: "inserted" } } }
    }
  ]
};

const findingsOf = (runId: string) =>
  Array.from({ length: ROWS }, (_, index) => ({
    run_id: runId,
    client_id: `client-${index}`,
    amount: 119.5
  }));

describe("a Workflow Run that inserts into a Data Store and whose worker process is killed", () => {
  let open: ProbeWorld | undefined;
  const connections: postgres.Sql[] = [];

  afterEach(async () => {
    await Promise.all(connections.splice(0).map((sql) => sql.end({ timeout: 1 })));
    await open?.close();
    open = undefined;
    // The database and the roles of the store are the cluster's.
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      const records = await sql<
        { database_name: string; app_role: string; migration_role: string }[]
      >`select database_name, app_role, migration_role from data_stores`;
      for (const record of records) {
        await sql.unsafe(`drop database if exists "${record.database_name}" with (force)`);
        await sql.unsafe(`drop role if exists "${record.app_role}"`);
        await sql.unsafe(`drop role if exists "${record.migration_role}"`);
      }
    } finally {
      await sql.end();
    }
  });

  /** A connection of the test's own to a database of the cluster, as the platform's role. */
  async function connect(database?: string): Promise<postgres.Sql> {
    const url = new URL(await fileTestDatabaseUrl());
    if (database) url.pathname = `/${database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    connections.push(sql);
    return sql;
  }

  /** Writes and publishes the store, and waits for the server process to provision it. */
  async function publishStore(t: ProbeWorld): Promise<DataStoreRecord> {
    const address = { kind: DATA_STORE_ASSET_KIND, name: "findings" };
    const written = await t.api.call("assets.put", {
      params: address,
      payload: { files, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
    const published = await t.api.call("assets.publish", {
      params: address,
      payload: { revision: 1 }
    });
    expect(published.statusCode, published.body).toBe(200);
    const find = () =>
      t.api.stores.dataStores.findDataStoreByName({ clientInstanceId, name: "findings" });
    await waitFor(
      async () => (await find())?.status === "ready",
      "the server process provisioned the store",
      2 * MINUTE_MS
    );
    const record = required(await find());
    // AP-10: the grant is written to the store; its administration does not give it yet.
    await t.api.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: t.principalId,
      action: DATA_STORE_ACTIONS.insert,
      effect: "allow",
      scopeKind: "asset",
      scopeId: record.id,
      grantedBy: asUserId(t.starterId)
    });
    return record;
  }

  /** Ends the wait for what a dead process held: the lease of its job and the time of its call. */
  async function afterTheDeadProcess(t: ProbeWorld, runId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ended(await t.run(runId)), "the run ended before the lease did").toBe(false);
    await t.sql(async (sql) => {
      await sql`
        update platform_jobs set lease_expires_at = now()
        where kind like 'workflow%' and status = 'running'`;
      await sql`
        update operation_runs
        set started_at = started_at - interval '10 minutes',
          created_at = created_at - interval '10 minutes'
        where status = 'running'`;
    });
    await waitFor(async () => ended(await t.run(runId)), "the run ended", 2 * MINUTE_MS);
  }

  const recordOf = async (t: ProbeWorld, runId: string) => {
    const run = await t.run(runId);
    const stepRuns = stepRunsSchema.parse(
      (await t.api.call("workflows.list_step_runs", { params: { runId } })).json()
    ).items;
    return {
      run: { status: run.status, error: run.error },
      store: stepRuns
        .filter(({ key }) => key === "store")
        .map(({ status, attempt }) => ({ status, attempt }))
    };
  };

  // Fails without the record of the key: the call that was cut off is never made again and
  // the run ends as failed with `operation_interrupted`.
  it(
    "replays the committed insert under its key after a kill, and holds each row once",
    async () => {
      const { world: t, worker: first } = await openProbeWorld({
        modules: { dataStores: { enabled: true } },
        fileStore: true
      });
      open = t;
      const record = await publishStore(t);
      await t.publish(WORKFLOW);
      const store = await connect(record.location.database);
      // A session of its own for each lock the test holds: a pool of one would wait for itself.
      const holder = await (await connect(record.location.database)).reserve();
      const platform = await connect();
      const counted = z.array(z.object({ rows: z.number(), clients: z.number() }));
      const rowsOf = async (runId: string) =>
        required(
          counted.parse(
            await store`select count(*)::integer as rows, count(distinct client_id)::integer as clients
              from findings where run_id = ${runId}`
          )[0]
        );
      /** Whether an insert of the store waits for the lock the test holds. */
      const insertWaits = async () =>
        (
          await store`select 1 from pg_locks
            where locktype = 'advisory' and objid = ${HOLD} and not granted`
        ).length > 0;
      const insertRuns = () =>
        t.sql(
          (sql) => sql<{ status: string; attempt: number; key: string | null }[]>`
            select status, attempt, idempotency_key as key from operation_runs
            where operation = 'data_store.findings.insert' order by created_at`
        );

      // Killed when the store has kept the rows and the Operation Run is not complete: the
      // test holds the row of the run, which the process writes the outcome to.
      await holder`select pg_advisory_lock(${HOLD})`;
      const two = await t.start(WORKFLOW.id, { rows: findingsOf("run-2") });
      await waitFor(insertWaits, "the insert of the second run is in flight", MINUTE_MS);
      const held = await platform.reserve();
      await held`begin`;
      const locked = await held`
        select id from operation_runs
        where operation = 'data_store.findings.insert' and status = 'running' for update`;
      expect(locked).toHaveLength(1);
      await holder`select pg_advisory_unlock(${HOLD})`;
      await waitFor(
        async () => (await rowsOf("run-2")).rows === ROWS,
        "the store kept the rows of the second run",
        MINUTE_MS
      );
      expect(
        (await held`select status from operation_runs where id = ${required(locked[0]).id}`)[0]
      ).toEqual({ status: "running" });
      await first.kill();
      // The process died before its write of the outcome reached the database. The session it
      // left waits for the test's lock and would still write once the lock is gone, so the
      // test ends that session as the death of its process does where nothing held it.
      const [waiting] = await held<{ pids: number[] }[]>`
        select array_agg(pid) as pids from pg_stat_activity
        where pg_backend_pid() = any (pg_blocking_pids(pid))`;
      expect(waiting?.pids).toHaveLength(1);
      await held`select pg_terminate_backend(pid) from unnest(${required(waiting).pids}::int4[]) as pid`;
      await waitFor(
        async () =>
          (
            await held`select 1 from pg_stat_activity
              where pg_backend_pid() = any (pg_blocking_pids(pid))`
          ).length === 0,
        "the session of the dead process ended",
        MINUTE_MS
      );
      await held`rollback`;
      held.release();
      expect((await insertRuns()).at(-1)).toMatchObject({ status: "running", attempt: 1 });

      await t.startWorker();
      await afterTheDeadProcess(t, two.id);
      expect(await recordOf(t, two.id)).toEqual({
        run: { status: "done", error: undefined },
        store: [{ status: "done", attempt: 2 }]
      });
      // The second call was answered from the record of the first: each row is there once.
      expect(await rowsOf("run-2")).toEqual({ rows: ROWS, clients: ROWS });

      // One Operation Run per step run, made twice under the key of its step run.
      const runs = await insertRuns();
      expect(runs.map(({ status, attempt }) => ({ status, attempt }))).toEqual([
        { status: "done", attempt: 2 }
      ]);
      expect(new Set(runs.map(({ key }) => key)).size).toBe(1);
      // The store recorded each call once, with what it answered.
      expect(
        await store<{ operation: string; outcome: unknown }[]>`
          select operation, outcome from catalyst.calls order by made_at`
      ).toEqual(
        [1].map(() => ({
          operation: "data_store.findings.insert",
          outcome: { table: "findings", inserted: ROWS, skipped: 0 }
        }))
      );
      holder.release();
    },
    8 * MINUTE_MS
  );
});
