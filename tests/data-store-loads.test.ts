import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPlatformId, type JsonObject } from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import {
  init,
  manifest,
  refusal,
  useDataStoreWorld,
  type StoreFile
} from "./support/data-store-world";

// What a load of a dataset into a Data Store holds to, against real Postgres: one transaction
// for all its rows, the size limit of the store, the key that tells two rows apart, and the
// bound on one call.

/** The findings of each month, one per client and rule. */
const keyed: StoreFile = {
  path: "migrations/0002_month_findings.sql",
  text: `create table month_findings (
    month text not null,
    client_id text not null,
    rule_id text not null,
    severity text not null default 'warning',
    amount numeric(14, 2),
    note text,
    primary key (month, client_id, rule_id)
  );`
};

const found = (index: number, overrides: JsonObject = {}): JsonObject => ({
  month: "2026-09",
  client_id: `client-${index}`,
  rule_id: "vat-rate",
  amount: 119.5,
  ...overrides
});

const many = (count: number, overrides: JsonObject = {}, from = 0) =>
  Array.from({ length: count }, (_, index) => found(from + index, overrides));

type Parts = () => AsyncIterable<readonly JsonObject[]>;

/** The datasets of one test, as the slice that brings datasets will answer them. */
function datasetsOfTest() {
  const held = new Map<string, Parts>();
  let reads = 0;
  return {
    reader: {
      read(reference: { $dataset: string }) {
        reads += 1;
        return required(held.get(reference.$dataset))();
      }
    },
    reads: () => reads,
    /** A dataset of these parts. `between` runs after the first part was taken. */
    put(id: string, parts: JsonObject[][], between?: () => Promise<void>) {
      held.set(id, async function* () {
        for (const [index, part] of parts.entries()) {
          if (index === 1) await between?.();
          yield part;
        }
      });
      const rows = parts.flat();
      return { $dataset: id, rowCount: rows.length, bytes: JSON.stringify(rows).length };
    }
  };
}

describe("a load into a Data Store", () => {
  const { db, published, call } = useDataStoreWorld("data_store_loads");

  async function store(label: string, files: StoreFile[] = [manifest(), init, keyed]) {
    const datasets = datasetsOfTest();
    return { ...(await published(label, files, datasets.reader)), datasets };
  }

  type World = Awaited<ReturnType<typeof store>>;

  const KEY = ["month", "client_id", "rule_id"];

  const load = (world: World, dataset: unknown, options: JsonObject = {}) =>
    call(world, "load", { table: "month_findings", dataset, ...options });

  const rowsOf = async (world: World, sql: string) =>
    z
      .object({ rows: z.array(z.record(z.string(), z.unknown())) })
      .parse(await call(world, "query", { sql })).rows;

  const count = async (world: World, where = "true") =>
    (await rowsOf(world, `select count(*)::integer as count from month_findings where ${where}`))[0]
      ?.count;

  it("takes the rows of a dataset in one call, however the dataset is cut into parts", async () => {
    const world = await store("many");
    const rows = many(5_000);
    const dataset = world.datasets.put("ds_many", [
      rows.slice(0, 1),
      rows.slice(1, 2_600),
      rows.slice(2_600)
    ]);

    expect(await load(world, dataset)).toEqual({
      table: "month_findings",
      inserted: 5_000,
      updated: 0,
      skipped: 0,
      deleted: 0
    });
    expect(await count(world)).toBe(5_000);
    expect(
      await rowsOf(world, "select amount::float8 as amount, severity from month_findings limit 1")
    ).toEqual([{ amount: 119.5, severity: "warning" }]);
  });

  it("maps the fields of a row onto columns and leaves the other fields out", async () => {
    const world = await store("mapped");
    const dataset = world.datasets.put("ds_mapped", [
      [
        { Monat: "2026-09", Mandant: "4711", Regel: "vat-rate", Betrag: 12.5, intern: "x" },
        { Monat: "2026-09", Mandant: "4712", Regel: "vat-rate", intern: "y" }
      ]
    ]);

    expect(
      await load(world, dataset, {
        columns: { Monat: "month", Mandant: "client_id", Regel: "rule_id", Betrag: "amount" }
      })
    ).toMatchObject({ inserted: 2 });
    expect(
      await rowsOf(
        world,
        "select client_id, amount::float8 as amount from month_findings order by client_id"
      )
    ).toEqual([
      { client_id: "4711", amount: 12.5 },
      { client_id: "4712", amount: null }
    ]);
  });

  it("adds no row of a load that a unique constraint refuses, also where the row comes late", async () => {
    const world = await store("fail");
    await load(world, world.datasets.put("ds_first", [[found(4_200)]]));
    const rows = many(4_201);

    expect(
      await refusal(
        load(world, world.datasets.put("ds_again", [rows.slice(0, 3_000), rows.slice(3_000)]))
      )
    ).toMatchObject({ code: "VALIDATION_FAILED", details: { sqlState: "23505" } });
    expect(await count(world)).toBe(1);
  });

  it("skips the rows whose key is stored, so a load of the same dataset again adds nothing", async () => {
    const world = await store("skip");
    const options = { key: KEY, onConflict: "skip" };
    await load(world, world.datasets.put("ds_first", [many(1_500)]), options);

    expect(
      await load(world, world.datasets.put("ds_more", [many(2_000, { amount: 1 })]), options)
    ).toEqual({ table: "month_findings", inserted: 500, updated: 0, skipped: 1_500, deleted: 0 });
    expect(await count(world, "amount = 1")).toBe(500);
  });

  it("updates the rows whose key is stored and adds the others", async () => {
    const world = await store("update");
    const options = { key: KEY, onConflict: "update" };
    await load(world, world.datasets.put("ds_first", [many(1_500, { note: "first" })]), options);

    expect(
      await load(world, world.datasets.put("ds_more", [many(2_000, { amount: 1 })]), options)
    ).toEqual({ table: "month_findings", inserted: 500, updated: 1_500, skipped: 0, deleted: 0 });
    expect(await count(world, "amount = 1")).toBe(2_000);
    // A column the dataset does not give keeps what is stored.
    expect(await count(world, "note = 'first'")).toBe(1_500);
  });

  it("replaces the rows of a month in one transaction: a reader sees the old rows whole, then the new", async () => {
    const world = await store("replace");
    await load(
      world,
      world.datasets.put("ds_old", [
        [...many(1_200, { note: "old" }), ...many(3, { month: "2026-08", note: "old" })]
      ])
    );
    const seen: unknown[] = [];
    const next = many(1_500, { note: "new" }, 600);
    const dataset = world.datasets.put(
      "ds_new",
      [next.slice(0, 1_000), next.slice(1_000)],
      // The first thousand rows are written and the old ones deleted, and nothing is kept yet.
      async () => {
        seen.push(await count(world, "note = 'old' and month = '2026-09'"), await count(world));
      }
    );

    expect(await load(world, dataset, { key: KEY, replace: { by: ["month"] } })).toEqual({
      table: "month_findings",
      inserted: 1_500,
      updated: 0,
      skipped: 0,
      deleted: 1_200
    });
    expect(seen).toEqual([1_200, 1_203]);
    expect(await count(world, "month = '2026-09' and note = 'new'")).toBe(1_500);
    expect(await count(world, "month = '2026-09' and note = 'old'")).toBe(0);
    // Another month is no row of the dataset's: it stays.
    expect(await count(world, "month = '2026-08'")).toBe(3);
  });

  it("clears only the explicit month and client when a rerun has no findings", async () => {
    const world = await store("empty-scoped");
    await load(
      world,
      world.datasets.put("ds_old", [
        [found(1), found(1, { rule_id: "second" }), found(2), found(1, { month: "2026-08" })]
      ])
    );
    const replace = {
      key: KEY,
      replace: {
        by: ["month", "client_id"],
        values: { month: "2026-09", client_id: "client-1" }
      }
    };
    expect(await load(world, world.datasets.put("ds_empty", []), replace)).toEqual({
      table: "month_findings",
      inserted: 0,
      updated: 0,
      skipped: 0,
      deleted: 2
    });
    expect(await count(world)).toBe(2);
    expect(await count(world, "client_id = 'client-2' or month = '2026-08'")).toBe(2);
    expect(await load(world, world.datasets.put("ds_empty_again", [[]]), replace)).toMatchObject({
      deleted: 0
    });
  });

  it("keeps all rows when a scoped replacement contains a row outside its group", async () => {
    const world = await store("outside-scope");
    await load(world, world.datasets.put("ds_old", [[found(1), found(2)]]));
    const replace = {
      key: KEY,
      replace: {
        by: ["client_id", "month"],
        values: { client_id: "client-1", month: "2026-09" }
      }
    };
    expect(
      await refusal(
        load(
          world,
          world.datasets.put("ds_mixed", [
            [found(1, { note: "new" })],
            [found(2, { note: "new" })]
          ]),
          replace
        )
      )
    ).toMatchObject({ details: { reason: "replace_scope_mismatch" } });
    expect(await count(world)).toBe(2);
    expect(await count(world, "note = 'new'")).toBe(0);
    expect(
      await load(world, world.datasets.put("ds_valid", [[found(1, { note: "new" })]]), replace)
    ).toMatchObject({ inserted: 1, deleted: 1 });
    expect(await count(world)).toBe(2);
  });

  it("compares mapped replacement groups using the table's column types", async () => {
    const world = await store("mapped-scope");
    await load(
      world,
      world.datasets.put("ds_old", [
        [
          found(1, { client_id: "1001" }),
          found(2),
          found(1, { client_id: "1001", month: "2026-08" })
        ]
      ])
    );
    expect(
      await load(
        world,
        world.datasets.put("ds_mapped", [
          [
            {
              Mandant: 1001,
              Monat: "2026-09",
              Regel: "new-rule",
              Betrag: 2
            }
          ]
        ]),
        {
          key: KEY,
          columns: { Mandant: "client_id", Monat: "month", Regel: "rule_id", Betrag: "amount" },
          replace: { by: ["client_id", "month"], values: { client_id: "1001", month: "2026-09" } }
        }
      )
    ).toMatchObject({ inserted: 1, deleted: 1 });
    expect(await count(world)).toBe(3);
    expect(
      await count(world, "client_id = '1001' and month = '2026-09' and rule_id = 'new-rule'")
    ).toBe(1);
  });

  it("an empty dataset without an explicit scope clears no inferred group", async () => {
    const world = await store("empty-inferred");
    await load(world, world.datasets.put("ds_old", [[found(1)]]));
    expect(
      await load(world, world.datasets.put("ds_empty", []), {
        key: KEY,
        replace: { by: ["month"] }
      })
    ).toMatchObject({ inserted: 0, deleted: 0 });
    expect(await count(world)).toBe(1);
  });

  it.each(["inferred", "scope-first", "scope-second"])(
    "serializes concurrent replacements (%s)",
    async (mode) => {
      const world = await store("at-once");
      await load(world, world.datasets.put("ds_stored", [many(50, { note: "stored" })]));
      const replace = { key: KEY, replace: { by: ["month"] } };
      const scoped = { key: KEY, replace: { by: ["month"], values: { month: "2026-09" } } };
      const waiting = async () =>
        (
          await db.sql<{ count: number }[]>`
          select count(*)::integer as count from pg_stat_activity
          where datname = ${world.record.location.database} and wait_event_type = 'Lock'`
        )[0]?.count;
      let later: Promise<unknown> | undefined;
      // Load B starts once load A has deleted the stored rows and written its first thousand,
      // and A goes on only when B waits for it.
      const first = world.datasets.put(
        "ds_a",
        [many(1_100, { note: "a" }, 1_000), many(1_400, { note: "a" }, 2_100)],
        async () => {
          later = load(
            world,
            world.datasets.put("ds_b", [many(10, { note: "b" }, 10_000)]),
            mode === "scope-second" ? scoped : replace
          );
          await eventually(async () => expect(await waiting()).toBe(1));
        }
      );

      expect(await load(world, first, mode === "scope-first" ? scoped : replace)).toMatchObject({
        inserted: 2_500,
        deleted: 50
      });
      // B replaced what A stored, and says what it deleted.
      expect(await later).toMatchObject({ inserted: 10, deleted: 2_500 });
      expect(await count(world)).toBe(10);
      expect(await count(world, "note = 'b'")).toBe(10);
    }
  );

  it.each(["rows", "bytes"])(
    "completes replacements with reversed groups across %s chunks",
    async (chunkLimit) => {
      const world = await store("reversed-groups");
      await load(
        world,
        world.datasets.put("ds_stored", [
          [...many(50), ...many(50, { month: "2026-10" }), found(0, { month: "2026-08" })]
        ])
      );
      const replace = { key: KEY, replace: { by: ["month"] } };
      // Large notes cross the byte boundary before 1,000 rows; short notes cross the row
      // boundary. Both leave the first group's transaction lock held before the next part.
      const note = chunkLimit === "bytes" ? "n".repeat(1_100) : "n";
      let later: Promise<PromiseSettledResult<unknown>[]> | undefined;
      const first = world.datasets.put(
        "ds_a",
        [
          many(1_100, { note: `a${note}` }, 1_000),
          many(1_400, { month: "2026-10", note: `a${note}` }, 2_100)
        ],
        async () => {
          later = Promise.allSettled([
            load(
              world,
              world.datasets.put("ds_b", [
                many(1_100, { month: "2026-10", note: `b${note}` }, 10_000),
                many(1_400, { note: `b${note}` }, 11_100)
              ]),
              replace
            )
          ]);
          // Before serialization B holds October and waits for A's September. With
          // serialization B waits before taking any group lock. Neither needs a sleep.
          await eventually(async () => {
            const [waiting] = await db.sql<{ count: number }[]>`
              select count(*)::integer as count from pg_stat_activity
              where datname = ${world.record.location.database} and wait_event_type = 'Lock'`;
            expect(waiting?.count).toBe(1);
          });
        }
      );

      const [earlier] = await Promise.allSettled([load(world, first, replace)]);
      const [second] = await required(later);
      if (earlier?.status === "rejected") throw earlier.reason;
      if (second?.status === "rejected") throw second.reason;
      expect(earlier).toMatchObject({
        status: "fulfilled",
        value: { inserted: 2_500, deleted: 100 }
      });
      expect(second).toMatchObject({
        status: "fulfilled",
        value: { inserted: 2_500, deleted: 2_500 }
      });
      expect(await count(world)).toBe(2_501);
      expect(await count(world, "left(note, 1) = 'b'")).toBe(2_500);
      expect(await count(world, "month = '2026-08'")).toBe(1);
    }
  );

  it("refuses a dataset that holds one key twice, in one part or in two, and keeps none of its rows", async () => {
    const world = await store("twice");
    for (const mode of ["skip", "update", "fail"]) {
      const rows = [...many(1_400), found(7, { amount: 2 })];
      for (const parts of [[rows], [rows.slice(0, 1_200), rows.slice(1_200)]]) {
        expect(
          await refusal(
            load(world, world.datasets.put("ds_twice", parts), { key: KEY, onConflict: mode })
          ),
          mode
        ).toMatchObject({
          code: "VALIDATION_FAILED",
          message: expect.stringContaining("Row 1401"),
          details: { reason: "duplicate_key", row: 1_401 }
        });
      }
    }
    expect(await count(world)).toBe(0);
  });

  it("refuses a key no row can be found again by", async () => {
    const world = await store("keys", [
      manifest(),
      init,
      keyed,
      {
        path: "migrations/0003_loose.sql",
        text: `create table loose (client_id text, rule_id text, amount numeric, unique (client_id, rule_id));
          create unique index loose_open on loose (rule_id) where amount > 0;`
      }
    ]);
    const into = (table: string, rows: JsonObject[], options: JsonObject) =>
      refusal(
        call(world, "load", { table, dataset: world.datasets.put("ds_k", [rows]), ...options })
      );

    // No unique constraint over exactly these columns.
    expect(
      await into("month_findings", many(2), { key: ["month", "client_id"], onConflict: "skip" })
    ).toMatchObject({ code: "VALIDATION_FAILED", details: { reason: "key_without_constraint" } });
    // An index over a part of the rows binds no row for certain.
    expect(
      await into("loose", [{ client_id: "1", rule_id: "a" }], {
        key: ["rule_id"],
        onConflict: "skip"
      })
    ).toMatchObject({ details: { reason: "key_without_constraint" } });
    // A key the dataset does not give.
    expect(
      await into("loose", [{ client_id: "1" }], {
        key: ["client_id", "rule_id"],
        onConflict: "skip"
      })
    ).toMatchObject({ details: { reason: "key_not_loaded" } });
    // An empty key never meets the row that is stored.
    expect(
      await into(
        "loose",
        [
          { client_id: "1", rule_id: "a" },
          { client_id: "2", rule_id: null }
        ],
        { key: ["client_id", "rule_id"], onConflict: "update" }
      )
    ).toMatchObject({ details: { reason: "nullable_key", row: 2 } });
    expect(await rowsOf(world, "select count(*)::integer as count from loose")).toEqual([
      { count: 0 }
    ]);
  });

  it("names the table, the column and the row a load cannot take", async () => {
    const world = await store("names");
    const dataset = (rows: JsonObject[]) => world.datasets.put("ds_n", [rows]);

    expect(
      await refusal(call(world, "load", { table: "nowhere", dataset: dataset(many(1)) }))
    ).toMatchObject({ details: { reason: "table_unknown" } });
    expect(await refusal(load(world, dataset([found(1, { colour: "red" })])))).toMatchObject({
      message: expect.stringContaining("'colour'"),
      details: { reason: "column_unknown" }
    });
    expect(
      await refusal(
        load(world, dataset(many(1)), { columns: { month: "month", client_id: "month" } })
      )
    ).toMatchObject({ details: { reason: "column_twice" } });
    expect(
      await refusal(load(world, dataset([found(1), { month: "2026-09", client_id: "2" }])))
    ).toMatchObject({
      message: expect.stringContaining("Row 2"),
      details: { reason: "rows_differ" }
    });
    expect(await count(world)).toBe(0);
  });

  it("rolls a load back that takes the store past its size limit, and the store takes rows again", async () => {
    const world = await store("size");
    const [size] = await db.sql<
      { bytes: string }[]
    >`select pg_database_size(${world.record.location.database}::name)::text as bytes`;
    const limit = Number(required(size).bytes) + 4 * 1024 ** 2;
    await db.sql`update data_stores set size_limit_bytes = ${limit} where id = ${world.id}`;
    const parts = Array.from({ length: 20 }, (_, part) =>
      many(1_000, { note: "n".repeat(700) }, part * 1_000)
    );

    const refused: unknown = await load(world, world.datasets.put("ds_large", parts)).then(
      () => undefined,
      (error: unknown) => error
    );
    // It says that nothing of it stayed, so the call path runs the same step run again.
    expect(refused).toMatchObject({
      code: "CONFLICT",
      changedNothing: true,
      details: { reason: "data_store_size_limit", limit }
    });
    expect(await count(world)).toBe(0);
    // What the refused load wrote was given back: a small load fits again.
    expect(await load(world, world.datasets.put("ds_small", [many(10)]))).toMatchObject({
      inserted: 10
    });
  });

  it("takes at most 100000 rows and 67108864 bytes in one call, whatever the reference says", async () => {
    const world = await store("bound");
    const small = world.datasets.put("ds_bound", [many(1)]);

    // What the reference says is refused before a row is read.
    expect(await refusal(load(world, { ...small, rowCount: 100_001 }))).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("dataStores.load.rows"),
      details: { reason: "load_too_large", cap: "dataStores.load.rows", actual: 100_001 }
    });
    expect(await refusal(load(world, { ...small, bytes: 67_108_865 }))).toMatchObject({
      details: { reason: "load_too_large", cap: "dataStores.load.bytes" }
    });
    expect(world.datasets.reads()).toBe(0);

    // A dataset that holds more than its reference says is refused where it passes the bound.
    const rows = Array.from({ length: 101 }, (_, part) => many(1_000, {}, part * 1_000));
    const understated = { ...world.datasets.put("ds_rows", rows), rowCount: 10, bytes: 10 };
    expect(await refusal(load(world, understated))).toMatchObject({
      details: { reason: "load_too_large", cap: "dataStores.load.rows" }
    });
    const heavy = Array.from({ length: 65 }, (_, index) => [
      found(index, { note: "n".repeat(1024 ** 2) })
    ]);
    expect(
      await refusal(load(world, { ...world.datasets.put("ds_bytes", heavy), offset: 0, bytes: 10 }))
    ).toMatchObject({ details: { reason: "load_too_large", cap: "dataStores.load.bytes" } });
    expect(await count(world)).toBe(0);
  });

  it("refuses an oversized known view before reading, using its own parts rather than its parent's bytes", async () => {
    const world = await store("view-bound");
    const small = world.datasets.put("ds_view_bound", [[found(1)]]);
    const largeBytes = 67_108_865;
    const metadata = vi.spyOn(db.store.workflowRunDatasets, "get").mockResolvedValue({
      id: small.$dataset,
      clientInstanceId: world.clientInstanceId,
      runId: createPlatformId<"WorkflowRunId">("wfr"),
      stepRunId: createPlatformId<"WorkflowStepRunId">("wfs"),
      field: "rows",
      rowSchema: { type: "object" },
      state: "complete",
      rowCount: 3,
      bytes: largeBytes + small.bytes,
      parts: [
        { key: "large", rows: 2, bytes: largeBytes, hash: "large" },
        { key: "small", rows: 1, bytes: small.bytes, hash: "small" }
      ]
    });
    try {
      for (const rowCount of [2, 3]) {
        expect(
          await refusal(
            load(world, { ...small, offset: 0, rowCount, bytes: largeBytes + small.bytes })
          )
        ).toMatchObject({ details: { reason: "load_too_large", cap: "dataStores.load.bytes" } });
      }
      expect(world.datasets.reads()).toBe(0);
      // The small part fits, even though its parent is over the byte ceiling.
      expect(
        await load(world, { ...small, offset: 2, bytes: largeBytes + small.bytes })
      ).toMatchObject({ inserted: 1 });
      // A cut inside a part has no known size; the streaming count still decides.
      expect(
        await load(
          world,
          { ...small, offset: 1, bytes: largeBytes + small.bytes },
          { key: KEY, onConflict: "skip" }
        )
      ).toMatchObject({ skipped: 1 });
    } finally {
      metadata.mockRestore();
    }
  });

  it("takes the whole bound in one call", async () => {
    const world = await store("whole");
    const rows = Array.from({ length: 100 }, (_, part) => many(1_000, {}, part * 1_000));

    expect(await load(world, world.datasets.put("ds_whole", rows))).toMatchObject({
      inserted: 100_000
    });
    expect(await count(world)).toBe(100_000);
  });
});
