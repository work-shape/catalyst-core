import { describe, expect, it } from "vitest";
import type { JsonObject } from "@work-shape/catalyst-core";
import {
  finding,
  init,
  manifest,
  refusal,
  useDataStoreWorld,
  type StoreFile
} from "./support/data-store-world";

// What an insert into a Data Store holds to, against real Postgres: the size limit of the
// store, read on the database and never on what was sent, and the rule by which `skip` leaves
// a row out.

describe("an insert into a Data Store", () => {
  const { db, recordOf, published, call } = useDataStoreWorld("data_store_inserts");

  /** The store with room for a few megabytes more than it holds now. */
  async function nearlyFull(label: string, files: StoreFile[] = [manifest(), init]) {
    const world = await published(label, files);
    const limit = (await sizeOf(world.record.location.database)) + 4 * 1024 ** 2;
    await db.sql`update data_stores set size_limit_bytes = ${limit} where id = ${world.id}`;
    return { ...world, limit };
  }

  const sizeOf = async (database: string) =>
    Number(
      (
        await db.sql<{ bytes: string }[]>`select pg_database_size(${database}::name)::text as bytes`
      )[0]?.bytes
    );

  const count = async (world: Awaited<ReturnType<typeof published>>, table: string) =>
    call(world, "query", { sql: `select count(*)::integer as count from ${table}` });

  /** Some megabytes that do not shrink when they are stored. */
  const SWELL = `insert into bulk
    select (select string_agg(md5((n * 1000 + i)::text), '') from generate_series(1, 60) i)
    from generate_series(1, 8000) n;`;

  const swelling = (trigger: string, before = ""): StoreFile => ({
    path: "migrations/0002_swelling.sql",
    text: `create table bulk (filler text);
      create function swell() returns trigger language plpgsql as $f$
        begin ${before} ${SWELL} return new; end $f$;
      ${trigger}`
  });

  it("holds the size limit from the first insert of a store", async () => {
    const world = await published("first");
    const { sizeBytes } = await recordOf(world, world.id);
    expect(sizeBytes).toBeGreaterThan(1024 ** 2);
    await db.sql`update data_stores set size_limit_bytes = 1048576 where id = ${world.id}`;

    expect(
      await refusal(call(world, "insert", { table: "findings", rows: [finding(1)] }))
    ).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("its size limit is 1048576 bytes (sizeLimit)"),
      details: { reason: "data_store_size_limit", limit: 1024 ** 2 }
    });
    expect(await count(world, "findings")).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("keeps no row past the limit under callers at once", async () => {
    const world = await nearlyFull("callers");
    // A stored size of this second that says the store is empty: an insert does not go by it.
    await db.sql`update data_stores set size_bytes = 10, size_measured_at = now() where id = ${world.id}`;
    const batch = Array.from({ length: 1_000 }, (_, index) =>
      finding(index, { details: { note: "n".repeat(700) } })
    );
    const caller = async () => {
      for (let calls = 0; calls < 40; calls += 1) {
        const refused = await call(world, "insert", { table: "findings", rows: batch }).then(
          () => false,
          () => true
        );
        if (refused) return calls;
      }
      return 40;
    };

    const calls = await Promise.all([caller(), caller(), caller(), caller()]);

    expect(Math.max(...calls)).toBeLessThan(40);
    expect((await sizeOf(world.record.location.database)) - world.limit).toBeLessThan(
      64 * 1024 ** 2
    );
  });

  it.each([
    [
      "a trigger writes beside the rows",
      swelling(
        "create trigger swells after insert on findings for each row execute function swell();"
      )
    ],
    [
      "a trigger writes only as the transaction ends",
      swelling(
        "create constraint trigger swells after insert on findings deferrable initially deferred for each row execute function swell();"
      )
    ],
    [
      "a trigger puts a size function of its own in the way",
      swelling(
        `create function public.pg_database_size(name) returns bigint language sql as 'select 0::bigint';
         create trigger swells after insert on findings for each row execute function swell();`,
        "perform set_config('search_path', 'public, pg_catalog', true);"
      )
    ]
  ])("takes no insert that writes the store past its limit: %s", async (_case, migration) => {
    const world = await nearlyFull(`swell_${Math.random().toString(36).slice(2, 8)}`, [
      manifest(),
      init,
      migration
    ]);

    // One row of a few hundred bytes, and some fifteen megabytes written for it.
    expect(
      await refusal(call(world, "insert", { table: "findings", rows: [finding(1)] }))
    ).toMatchObject({
      code: "CONFLICT",
      details: { reason: "data_store_size_limit", limit: world.limit }
    });
    expect(await count(world, "findings")).toMatchObject({ rows: [{ count: 0 }] });
    expect(await count(world, "bulk")).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("gives back what a refused insert wrote, so the next one that fits is taken", async () => {
    const world = await published("reclaimed");
    // Some megabyte a call.
    const batch = Array.from({ length: 1_000 }, (_, index) =>
      finding(index, { details: { note: "n".repeat(900) } })
    );
    expect(await call(world, "insert", { table: "findings", rows: batch })).toMatchObject({
      inserted: 1_000
    });
    // The limit lies half a call above what the store holds now. The size of a database also
    // moves by files that hold no row, such as the cache of the catalog that Postgres removes
    // and writes again, some hundred kilobytes: a limit a few of them from the size would
    // refuse or take a call by chance.
    const limit = (await sizeOf(world.record.location.database)) + 512 * 1024;
    await db.sql`update data_stores set size_limit_bytes = ${limit} where id = ${world.id}`;

    expect(await refusal(call(world, "insert", { table: "findings", rows: batch }))).toMatchObject({
      code: "CONFLICT",
      details: { reason: "data_store_size_limit", limit }
    });
    // What the refused call wrote is no row of the store. Left where it is, half a call past
    // the limit, it would keep every later insert out although the rows that are kept fit.

    expect(await call(world, "insert", { table: "findings", rows: [finding(1)] })).toMatchObject({
      inserted: 1
    });
    expect(await count(world, "findings")).toMatchObject({ rows: [{ count: 1_001 }] });
  });

  it("skips only on a unique key of all rows that the call gives in full, and names why it does not", async () => {
    const keys: StoreFile = {
      path: "migrations/0002_keys.sql",
      text: `create table loose (run_id text not null, amount numeric, unique (run_id, amount));
        create table tight (run_id text not null, amount numeric, unique nulls not distinct (run_id, amount));
        create table lowered (label text);
        create unique index lowered_label on lowered (lower(label));
        create table blanked (label text not null);
        create unique index blanked_label on blanked (nullif(label, ''));
        create table keyed (id integer primary key, email text unique);
        create table carried (id integer not null, note text);
        create unique index carried_id on carried (id) include (note);
        create table clash (catalyst_row integer primary key, catalyst_value text);
        create table derived (label text not null, slug text generated always as (lower(label)) stored unique);
        create table numbered (id bigint generated by default as identity primary key, note text);
        create table defaulted (id integer not null default (random() * 1000000)::integer, note text, unique nulls not distinct (id));
        create table coalesced (id integer default (random() * 1000000)::integer, note text);
        create unique index coalesced_id on coalesced (coalesce(id, 0));
        create table partly (id integer not null, live boolean not null);
        create unique index partly_live on partly (id) where live;
        create table late (id integer not null, unique (id) deferrable initially deferred);
        create table keyless (note text);`
    };
    const world = await published("skip", [manifest(), init, keys]);
    const skipping = (table: string, row: JsonObject) => () =>
      call(world, "insert", { table, rows: [row], onConflict: "skip" });
    const reasonOf = async (insert: () => Promise<unknown>) => {
      const refused = await refusal(insert());
      return [refused.code, refused.details];
    };
    const twice = async (insert: () => Promise<unknown>, table: string) => {
      expect(await insert(), table).toEqual({ table, inserted: 1, skipped: 0 });
      expect(await insert(), table).toEqual({ table, inserted: 0, skipped: 1 });
    };
    const emptyKey = ["VALIDATION_FAILED", { reason: "nullable_key", row: 1 }];
    const noKey = ["VALIDATION_FAILED", { reason: "skip_without_key" }];

    // A key that is empty in a row never conflicts, so `skip` would add the row twice.
    expect(await reasonOf(skipping("loose", { run_id: "run-1", amount: null }))).toEqual(emptyKey);
    await twice(skipping("loose", { run_id: "run-1", amount: 5 }), "loose");
    await twice(skipping("tight", { run_id: "run-1", amount: null }), "tight");
    // The database works each key out, also where an expression makes it empty.
    expect(await reasonOf(skipping("lowered", { label: null }))).toEqual(emptyKey);
    await twice(skipping("lowered", { label: "Same" }), "lowered");
    expect(await reasonOf(skipping("blanked", { label: "" }))).toEqual(emptyKey);
    await twice(skipping("blanked", { label: "kept" }), "blanked");
    // The primary key binds the row, whatever an optional unique column beside it holds; a
    // column an index only carries is no key; a key the database derives from what was given is.
    await twice(skipping("keyed", { id: 1, email: null }), "keyed");
    await twice(skipping("carried", { id: 1, note: null }), "carried");
    await twice(skipping("clash", { catalyst_row: 1, catalyst_value: "x" }), "clash");
    await twice(skipping("derived", { label: "Same" }), "derived");
    // A key the call leaves to its default is another one every time, whatever the index does
    // with an empty value; an index over a part of the rows binds no row for certain.
    for (const [table, row] of [
      ["numbered", { note: "again" }],
      ["defaulted", { note: "again" }],
      ["coalesced", { note: "again" }],
      ["partly", { id: 1, live: false }],
      ["keyless", { note: "again" }]
    ] as const) {
      expect(await reasonOf(skipping(table, row)), table).toEqual(noKey);
    }
    expect(await reasonOf(skipping("late", { id: 1 }))).toEqual([
      "VALIDATION_FAILED",
      { reason: "skip_deferrable_key" }
    ]);
    expect((await refusal(skipping("keyless", { note: "again" })())).message).toBe(
      "'skip' needs a unique constraint of the table 'keyless' that holds for all rows, is not deferrable, and whose columns every row of the call gives. The table has none. Give the columns of such a key in every row, or leave onConflict out."
    );
    // Without `skip` none of this is asked.
    expect(await call(world, "insert", { table: "keyless", rows: [{ note: "plain" }] })).toEqual({
      table: "keyless",
      inserted: 1,
      skipped: 0
    });
  });
});
