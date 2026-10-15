import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonObject } from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import {
  finding,
  init,
  manifest,
  refusal,
  useDataStoreWorld,
  type StoreFile
} from "./support/data-store-world";

// What a store keeps of a changing call that carried an idempotency key, against real
// Postgres: the record of the key is kept with the rows of the call, a second call under the
// key changes nothing and is answered what the first was, and a call without a key is what
// it was.

const keyed: StoreFile = {
  path: "migrations/0002_month_findings.sql",
  text: `create table month_findings (
    month text not null,
    client_id text not null,
    amount numeric(14, 2),
    primary key (month, client_id)
  );`
};

const countSchema = z.object({ rows: z.array(z.object({ count: z.number() })) });

describe("a changing call of a Data Store that carries an idempotency key", () => {
  const { db, published, call, connect, recordOf } = useDataStoreWorld("data_store_call_keys");

  type World = Awaited<ReturnType<typeof published>>;

  const rows = (count: number) => Array.from({ length: count }, (_, index) => finding(index));
  const insert = (world: World, count: number, key?: string, table = "findings") =>
    call(world, "insert", { table, rows: rows(count) }, key);
  const countOf = async (world: World, table = "findings") =>
    required(
      countSchema.parse(
        await call(world, "query", { sql: `select count(*)::integer as count from ${table}` })
      ).rows[0]
    ).count;
  /** The records of the store, read as the platform's role. */
  const records = (world: World) =>
    connect(world.record.location.database)<
      { key: string; operation: string; input_hash: string; outcome: JsonObject }[]
    >`select key, operation, input_hash, outcome from catalyst.calls order by made_at`;

  it("changes nothing a second time under the same key and input, and answers what the first call was answered", async () => {
    const world = await published("again");

    const first = await insert(world, 1_000, "workflow_step:step-1");
    expect(first).toEqual({ table: "findings", inserted: 1_000, skipped: 0 });
    expect(await insert(world, 1_000, "workflow_step:step-1")).toEqual(first);
    expect(await countOf(world)).toBe(1_000);

    // The record holds the operation, two hashes and the counts: no key, no row, no value.
    const kept = await records(world);
    expect(kept).toEqual([
      {
        key: expect.stringMatching(/^[0-9a-f]{64}$/u),
        operation: "data_store.findings.insert",
        input_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        outcome: first
      }
    ]);
    expect(JSON.stringify(kept)).not.toContain("step-1");
    expect(JSON.stringify(kept)).not.toContain("client-");
  });

  it("answers the first call again where the store has since become full", async () => {
    const world = await published("full");
    const first = await insert(world, 10, "step-full");
    await db.sql`update data_stores set size_limit_bytes = 1024 where id = ${world.id}`;

    expect(await refusal(insert(world, 10, "step-other"))).toMatchObject({
      details: { reason: "data_store_size_limit" }
    });
    expect(await insert(world, 10, "step-full")).toEqual(first);
    expect(await countOf(world)).toBe(10);
  });

  it("refuses a key that was used for another input or another operation, by a reason of its own", async () => {
    const world = await published("reused", [manifest(), init, keyed]);
    await insert(world, 3, "step-reused");

    const reused = {
      code: "CONFLICT",
      message: expect.stringContaining("was used for another call"),
      details: { reason: "data_store_key_reused" }
    };
    expect(await refusal(insert(world, 4, "step-reused"))).toMatchObject(reused);
    expect(
      await refusal(
        call(
          world,
          "load",
          { table: "month_findings", dataset: { $dataset: "ds", rowCount: 1, bytes: 10 } },
          "step-reused"
        )
      )
    ).toMatchObject(reused);
    // It says that nothing of it stayed, and nothing did.
    const thrown: unknown = await insert(world, 4, "step-reused").then(
      () => undefined,
      (error: unknown) => error
    );
    expect(thrown).toMatchObject({ changedNothing: true });
    expect(await countOf(world)).toBe(3);
    expect(await records(world)).toHaveLength(1);
  });

  it("keeps the rows of one of two calls that come under one key at the same moment, and answers both the same", async () => {
    const world = await published("at-once");

    const answers = await Promise.all(
      Array.from({ length: 4 }, () => insert(world, 1_000, "step-at-once"))
    );

    expect(answers).toEqual(
      Array.from({ length: 4 }, () => ({ table: "findings", inserted: 1_000, skipped: 0 }))
    );
    expect(await countOf(world)).toBe(1_000);
    expect(await records(world)).toHaveLength(1);
  });

  it("keeps no record of a call that is rolled back, so the same key adds its rows afterwards", async () => {
    const world = await published("rolled-back");
    const broken = { table: "findings", rows: [finding(1, { severity: "unheard-of" })] };

    expect(await refusal(call(world, "insert", broken, "step-broken"))).toMatchObject({
      details: { sqlState: "23514" }
    });
    expect(await records(world)).toHaveLength(0);
    expect(await insert(world, 2, "step-good")).toMatchObject({ inserted: 2 });
    expect(await countOf(world)).toBe(2);
  });

  it("records a load with its counts and reads its dataset once", async () => {
    let reads = 0;
    const world = await published("load", [manifest(), init, keyed], {
      // One dataset of five rows of one month.
      async *read() {
        reads += 1;
        yield await Promise.resolve(
          Array.from({ length: 5 }, (_, index) => ({ month: "2026-09", client_id: `c-${index}` }))
        );
      }
    });
    const load = () =>
      call(
        world,
        "load",
        {
          table: "month_findings",
          dataset: { $dataset: "ds", rowCount: 5, bytes: 200 },
          key: ["month", "client_id"],
          replace: { by: ["month"] }
        },
        "step-load"
      );

    const first = await load();
    expect(first).toEqual({
      table: "month_findings",
      inserted: 5,
      updated: 0,
      skipped: 0,
      deleted: 0
    });
    // A second replace would report five deleted rows: it is not made.
    expect(await load()).toEqual(first);
    expect(reads).toBe(1);
    expect(await countOf(world, "month_findings")).toBe(5);
  });

  it("behaves without a key as it did: every call adds its rows and no record is kept", async () => {
    const world = await published("unkeyed");

    await insert(world, 2);
    await insert(world, 2);

    expect(await countOf(world)).toBe(4);
    expect(
      await connect(world.record.location.database)`
        select 1 from pg_catalog.pg_tables where schemaname = 'catalyst' and tablename = 'calls'`
    ).toHaveLength(1);
    expect(await records(world)).toHaveLength(0);
  });

  it("gives a store that was provisioned before the records existed its table at the first call with a key", async () => {
    const world = await published("before");
    const store = connect(world.record.location.database);
    await store`drop table catalyst.calls`;
    await store.unsafe(`revoke usage on schema catalyst from "${world.record.roles.app}"`);

    expect(await insert(world, 2, "step-first")).toMatchObject({ inserted: 2 });
    expect(await insert(world, 2, "step-first")).toMatchObject({ inserted: 2 });
    expect(await countOf(world)).toBe(2);
  });

  it("closes the records to every statement of a query, which is what an `sql` action of an App runs: it reads none and adds none", async () => {
    const world = await published("privileges");
    await insert(world, 1, "step-kept");
    const [kept] = await records(world);
    const attempt = (sql: string) => refusal(call(world, "query", { sql }));
    const denied = { details: { sqlState: "42501" } };

    // The app role holds nothing on the table: the records are read and added through two
    // functions of the platform's, by the key of one call.
    expect(
      await connect(world.record.location.database)<{ privilege: string }[]>`
        select privilege_type as privilege from information_schema.role_table_grants
        where table_schema = 'catalyst' and table_name = 'calls'
          and grantee = ${world.record.roles.app} order by 1`
    ).toEqual([]);
    expect(await attempt("select * from catalyst.calls")).toMatchObject(denied);
    expect(await attempt("select count(*)::integer as count from catalyst.calls")).toMatchObject(
      denied
    );
    expect(await attempt("table catalyst.calls")).toBeDefined();
    expect(
      await attempt(
        `with made as (
           insert into catalyst.calls (key, operation, input_hash, outcome)
           values ('forged', 'data_store.findings.insert', 'forged', '{"inserted":0}')
           returning 1
         ) select count(*)::integer as count from made`
      )
    ).toBeDefined();
    // A query is read-only, so the function that adds a record adds none from one.
    expect(
      await attempt(
        `select catalyst.record_call('forged', 'data_store.findings.insert', 'forged', '{"inserted":0}')`
      )
    ).toBeDefined();
    // An insert names a table of the schema `public` and no other.
    expect(
      await refusal(
        call(world, "insert", {
          table: "catalyst.calls",
          rows: [{ key: "forged", operation: "o", input_hash: "h", outcome: "{}" }]
        })
      )
    ).toMatchObject({ details: { reason: "table_unknown" } });
    expect(await records(world)).toEqual([kept]);
    // The ledger of the migrations stays closed to it.
    expect(await attempt("select * from catalyst.migrations")).toMatchObject(denied);
  });

  it("removes the records that are older than 30 days with the daily measurement and keeps the others", async () => {
    const world = await published("old");
    await insert(world, 1, "step-old");
    await insert(world, 1, "step-older");
    await insert(world, 1, "step-new");
    const store = connect(world.record.location.database);
    const [oldest, older] = await store<{ key: string }[]>`
      select key from catalyst.calls order by made_at`;
    await store`update catalyst.calls set made_at = now() - interval '31 days'
      where key = ${required(oldest).key}`;
    await store`update catalyst.calls set made_at = now() - interval '29 days'
      where key = ${required(older).key}`;
    const measure = required(
      world.dataStores.jobHandlers.find(({ kind }) => kind.kind === "data_store.measure_size")
    );

    await db.store.jobs.enqueue(measure.kind, {}, { clientInstanceId: world.clientInstanceId });
    await eventually(async () => {
      await world.worker.runDue();
      expect(await records(world)).toHaveLength(2);
    });
    expect((await records(world)).map(({ key }) => key)).not.toContain(required(oldest).key);
    expect(await recordOf(world, world.id)).toMatchObject({ status: "ready" });
  });
});
