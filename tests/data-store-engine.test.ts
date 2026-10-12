import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DATA_STORE_ASSET_KIND,
  DATA_STORE_JOB_KINDS,
  DATA_STORE_PREVIEW_ROW_LIMIT,
  dataStoreOperationName,
  isAppError,
  type JsonObject
} from "@vivd-catalyst/core";
import { eventually, required } from "./support/assertions";
import {
  INIT_SQL,
  finding,
  init,
  manifest,
  refusal,
  useDataStoreWorld,
  type StoreFile
} from "./support/data-store-world";

// A Data Store against real Postgres, at the seam of its package: what a publish provisions,
// how its migrations move forward and what its two operations do as the app role. What each
// role can and cannot do is in `data-store-roles.test.ts`. Rights, policy and the run of a
// call are the call path's and are in `data-store-api.test.ts`.

const countSchema = z.array(z.object({ count: z.number() }));

describe("a Data Store on Postgres", () => {
  const { db, setup, publish, recordOf, settle, published, call, connect } =
    useDataStoreWorld("data_stores");

  it("reads a folder into a definition and refuses what does not belong in one", async () => {
    const { dataStores } = await setup("definition");
    const read = (files: StoreFile[]) =>
      dataStores.readFiles(
        files.map((file) => ({ path: file.path, bytes: new TextEncoder().encode(file.text) }))
      );

    expect(
      read([manifest("sizeLimit: 2GB\n"), init, { path: "seed/rows.csv", text: "a" }])
    ).toEqual({
      name: "findings",
      title: "Findings",
      description: "What the monthly check of bookings found.",
      sizeLimitBytes: 2 * 1024 ** 3,
      migrations: [
        {
          number: 1,
          name: "init",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          sql: INIT_SQL
        }
      ]
    });

    const issuesOf = (files: StoreFile[]) => {
      try {
        read(files);
      } catch (error) {
        if (!isAppError(error)) throw error;
        return z
          .object({ issues: z.array(z.object({ message: z.string() })) })
          .parse(error.details)
          .issues.map((issue) => issue.message);
      }
      throw new Error("Expected the files to be refused");
    };
    expect(issuesOf([manifest(), { path: "migrations/0002_later.sql", text: "select 1" }])).toEqual(
      ["Migrations are numbered from 0001 without a gap: expected 0001, found 0002"]
    );
    expect(issuesOf([manifest(), { path: "migrations/init.sql", text: "select 1" }])[0]).toContain(
      "is not named as a migration"
    );
    expect(issuesOf([manifest(), { path: "tables.yaml", text: "a: 1" }])[0]).toContain(
      "is no file of a Data Store"
    );
    // `store.yaml` is strict: a key it does not know is refused, never ignored.
    expect(issuesOf([manifest("tables: []\n"), init])[0]).toContain("tables");
    expect(read([manifest("scope: instance\n"), init])).toMatchObject({ scope: "instance" });
    expect(issuesOf([manifest("scope: everyone\n"), init])[0]).toContain("scope");
    // The schema `catalyst` is the platform's in every store: a migration that names it is refused.
    for (const touching of [
      "create table catalyst.notes (id integer);",
      'insert into "catalyst".migrations values (9, $$x$$, $$y$$);',
      "set search_path = Catalyst;"
    ]) {
      expect(issuesOf([manifest(), { path: "migrations/0001_init.sql", text: touching }])).toEqual([
        "'migrations/0001_init.sql' names the schema 'catalyst', which the platform keeps for itself in every store (DATA_STORE_RESERVED_SCHEMA). A migration creates and changes objects in other schemas."
      ]);
    }
    // A migration runs in the one transaction the platform opens and ends, as the role the
    // platform gave it: text that would end the transaction or change a role is refused.
    const refusedText = (text: string) =>
      issuesOf([manifest(), { path: "migrations/0001_init.sql", text }]);
    for (const control of [
      "create table half_a (id integer); commit; create table half_b (id integer);",
      "create table a (id integer);\nROLLBACK;",
      "begin; create table a (id integer);",
      "start transaction; create table a (id integer);",
      "savepoint s; create table a (id integer); rollback to savepoint s;",
      "do $$ begin create table a (id integer); commit; end $$;"
    ]) {
      expect(refusedText(control), control).toEqual([
        "'migrations/0001_init.sql' holds transaction control. A migration runs in one transaction, which the platform opens and ends: take 'begin', 'commit', 'rollback' and 'savepoint' out of it."
      ]);
    }
    for (const role of [
      "alter role current_user password 'x';",
      "ALTER USER current_user set statement_timeout = 0;",
      "create role helper;",
      "set role none;",
      "set local role postgres;",
      "reset role;",
      "set session authorization default;"
    ]) {
      expect(refusedText(role), role).toEqual([
        "'migrations/0001_init.sql' creates, changes or takes a role. A migration runs as the migration role of its store and leaves every role as it is."
      ]);
    }
    // A plpgsql block and a column named for a role are neither.
    expect(
      read([
        manifest(),
        {
          path: "migrations/0001_init.sql",
          text: "create table people (role text, begin_date date);\ndo $$ begin perform 1; end $$;"
        }
      ])
    ).toMatchObject({ migrations: [{ number: 1 }] });
    // Naming it in a comment or a value touches nothing.
    expect(
      read([
        manifest(),
        {
          path: "migrations/0001_init.sql",
          text: "-- not the catalyst schema\ncreate table notes (source text default 'catalyst');"
        }
      ])
    ).toMatchObject({ migrations: [{ number: 1 }] });
    expect(
      issuesOf([manifest(), { path: "migrations/0001_big.sql", text: "-".repeat(262_145) }])[0]
    ).toContain("DATA_STORE_MIGRATION_MAX_BYTES");
    expect(issuesOf([{ ...manifest(), text: `id: x\n#${"-".repeat(16_384)}` }, init])[0]).toContain(
      "DATA_STORE_MANIFEST_MAX_BYTES"
    );
  });

  it("provisions a database with an app role and a migration role when a store is published", async () => {
    const world = await setup("provision");
    const id = await publish(world, [manifest(), init]);
    expect(await recordOf(world, id)).toMatchObject({ status: "provisioning", level: 0 });

    const record = await settle(world, id, 1);

    expect(record.location.database).toMatch(/^catalyst_ds_[0-9a-f]{24}$/u);
    expect(record.migrations).toEqual([
      { number: 1, name: "init", sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }
    ]);
    const roles = await db.sql<
      { rolname: string; rolconnlimit: number; rolconfig: string[]; privileged: boolean }[]
    >`
      select rolname, rolconnlimit, rolconfig,
        rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls as privileged
      from pg_roles where rolname in (${record.roles.app}, ${record.roles.migration})
      order by rolname`;
    expect(roles).toEqual([
      {
        rolname: record.roles.app,
        rolconnlimit: 10,
        rolconfig: ["statement_timeout=15000", "idle_in_transaction_session_timeout=60000"],
        privileged: false
      },
      {
        rolname: record.roles.migration,
        rolconnlimit: 2,
        rolconfig: ["statement_timeout=600000", "idle_in_transaction_session_timeout=60000"],
        privileged: false
      }
    ]);
    // Neither role owns anything: the database is the platform's.
    const [owner] = await db.sql<{ owner: string }[]>`
      select pg_get_userbyid(datdba) as owner from pg_database
      where datname = ${record.location.database}`;
    expect(owner?.owner).toBe(new URL(db.databaseUrl).username);
    // The password of a role is in no statement and in no row: the Secret Store holds ciphertext.
    const secrets = await db.sql<{ subject: string }[]>`
      select subject from secrets where connection_asset_id = ${id} order by subject`;
    expect(secrets.map((secret) => secret.subject)).toEqual([
      "data_store:app",
      "data_store:ledger",
      "data_store:migration"
    ]);
    // A store's database is no platform migration: the migration state reads as before.
    expect(await db.store.readiness()).toMatchObject({ status: "ready" });
    const audit = await db.store.audit.listAuditEvents({
      clientInstanceId: world.clientInstanceId
    });
    expect(audit.map((event) => [event.type, event.subject, event.metadata])).toEqual(
      expect.arrayContaining([
        ["data_store.provisioned", id, { name: "findings" }],
        ["data_store.migrated", id, { name: "findings", level: 1, appliedCount: 1 }]
      ])
    );
  });

  it("inserts rows and reads them back as the app role", async () => {
    const world = await published("round_trip");

    expect(
      await call(world, "insert", { table: "findings", rows: [finding(1), finding(2)] })
    ).toEqual({ table: "findings", inserted: 2, skipped: 0 });
    const rows = await call(world, "query", {
      sql: "select client_id, severity, amount, details from findings where rule_id = $1 order by client_id",
      // A bare value leaves its type to the database; a declared one is bound as that type.
      parameters: ["vat-rate"]
    });
    const typed = await call(world, "query", {
      sql: "select count(*)::integer as count from findings where revision = $1 and client_id = any($2)",
      parameters: [
        { type: "integer", value: 3 },
        { type: "text[]", value: ["client-1", "client-9"] }
      ]
    });

    expect(typed).toMatchObject({ rows: [{ count: 1 }] });
    expect(rows).toEqual({
      // The product's own type beside the type as the store's database names it.
      columns: [
        { name: "client_id", type: "text", nativeType: "text" },
        { name: "severity", type: "text", nativeType: "text" },
        { name: "amount", type: "number", nativeType: "numeric" },
        { name: "details", type: "other", nativeType: "jsonb" }
      ],
      rows: [
        { client_id: "client-1", severity: "warning", amount: "119.50", details: { booking: 1 } },
        { client_id: "client-2", severity: "warning", amount: "119.50", details: { booking: 2 } }
      ],
      truncated: false
    });
  });

  it("skips or refuses a row a unique constraint of the table holds already, as onConflict says", async () => {
    const unique: StoreFile = {
      path: "migrations/0002_one_finding.sql",
      text: "create unique index one_finding on findings (run_id, client_id, rule_id);"
    };
    const world = await published("on_conflict", [manifest(), init, unique]);
    await call(world, "insert", { table: "findings", rows: [finding(1), finding(2)] });
    const rerun = { table: "findings", rows: [finding(2), finding(3)] };

    // Left out, a conflict refuses the whole call and adds no row of it.
    expect(await refusal(call(world, "insert", rerun))).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "The insert would store a value twice that must be unique (SQLSTATE 23505)."
    });
    expect(await refusal(call(world, "insert", { ...rerun, onConflict: "fail" }))).toMatchObject({
      details: { sqlState: "23505" }
    });
    expect(
      await call(world, "query", { sql: "select count(*)::integer as count from findings" })
    ).toMatchObject({ rows: [{ count: 2 }] });

    // The rerun of a run, and next month's run over the same findings, add only what is new.
    expect(await call(world, "insert", { ...rerun, onConflict: "skip" })).toEqual({
      table: "findings",
      inserted: 1,
      skipped: 1
    });
    expect(await call(world, "insert", { ...rerun, onConflict: "skip" })).toEqual({
      table: "findings",
      inserted: 0,
      skipped: 2
    });
  });

  it("refuses load, which is reserved, as not supported yet and changes nothing", async () => {
    const world = await published("load");

    const refused = await refusal(
      call(world, "load", {
        table: "findings",
        dataset: { $dataset: "ds_1", rowCount: 2, bytes: 120 }
      })
    );

    expect(refused).toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "data_store.findings.load is not supported yet: a dataset of a Workflow Run cannot be loaded into a Data Store by this release. Add rows with data_store.findings.insert.",
      details: { reason: "not_supported_yet" }
    });
    expect(
      await call(world, "query", { sql: "select count(*)::integer as count from findings" })
    ).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("describes the tables of a store at its level and previews at most 50 rows of one", async () => {
    const commented: StoreFile = {
      path: "migrations/0002_comments.sql",
      text: `comment on table findings is 'One row per finding of a check.';
        comment on column findings.amount is 'In EUR.';`
    };
    const world = await published("describe", [manifest(), init, commented]);
    await call(world, "insert", {
      table: "findings",
      rows: Array.from({ length: 60 }, (_, index) => finding(index))
    });

    const schema = z
      .object({
        schemaLevel: z.number(),
        tables: z.array(
          z.object({
            name: z.string(),
            comment: z.string().optional(),
            rowEstimate: z.number(),
            columns: z.array(z.record(z.string(), z.unknown()))
          })
        )
      })
      .parse(await call(world, "describe", {}));

    expect(schema.schemaLevel).toBe(2);
    expect(schema.tables.map((table) => [table.name, table.comment])).toEqual([
      ["findings", "One row per finding of a check."]
    ]);
    expect(schema.tables[0]?.columns).toEqual([
      {
        name: "id",
        type: "integer",
        nativeType: "bigint",
        nullable: false,
        primaryKey: true
      },
      { name: "run_id", type: "text", nativeType: "text", nullable: false, primaryKey: false },
      { name: "client_id", type: "text", nativeType: "text", nullable: false, primaryKey: false },
      { name: "rule_id", type: "text", nativeType: "text", nullable: false, primaryKey: false },
      {
        name: "revision",
        type: "integer",
        nativeType: "integer",
        nullable: false,
        primaryKey: false
      },
      { name: "severity", type: "text", nativeType: "text", nullable: false, primaryKey: false },
      {
        name: "amount",
        type: "number",
        nativeType: "numeric(14,2)",
        nullable: true,
        primaryKey: false,
        comment: "In EUR."
      },
      {
        name: "details",
        type: "other",
        nativeType: "jsonb",
        nullable: false,
        default: "'{}'::jsonb",
        primaryKey: false
      }
    ]);

    const preview = z
      .object({ rows: z.array(z.unknown()), truncated: z.boolean() })
      .parse(await call(world, "preview_rows", { table: "findings" }));
    expect([preview.rows.length, preview.truncated]).toEqual([DATA_STORE_PREVIEW_ROW_LIMIT, true]);
    expect(await call(world, "preview_rows", { table: "findings", limit: 2 })).toMatchObject({
      columns: expect.arrayContaining([{ name: "amount", type: "number", nativeType: "numeric" }]),
      rows: [{ client_id: "client-0" }, { client_id: "client-1" }],
      truncated: true
    });
    const preview_ = required(
      await world.dataStores.operationSource.resolve(
        dataStoreOperationName("findings", "preview_rows")
      )
    );
    expect(preview_.inputSchema.safeParse({ table: "findings", limit: 51 }).success).toBe(false);
    expect(await refusal(call(world, "preview_rows", { table: "bookings" }))).toMatchObject({
      message: "The store has no table 'bookings'"
    });
    // Both are reads as the app role: neither reaches what the platform keeps in the store.
    expect(JSON.stringify(schema)).not.toContain("migrations");
    expect(await refusal(call(world, "preview_rows", { table: "migrations" }))).toMatchObject({
      message: "The store has no table 'migrations'"
    });
  });

  it("binds a parameter as a value: SQL inside one changes no statement", async () => {
    const world = await published("injection");
    await call(world, "insert", { table: "findings", rows: [finding(1), finding(2)] });

    const injected = await call(world, "query", {
      sql: "select client_id from findings where client_id = $1",
      parameters: ["client-1' or '1'='1"]
    });
    const stored = await call(world, "insert", {
      table: "findings",
      rows: [finding(3, { client_id: "x'); drop table findings; --" })]
    });

    expect(injected).toMatchObject({ rows: [] });
    expect(stored).toEqual({ table: "findings", inserted: 1, skipped: 0 });
    expect(
      await call(world, "query", { sql: "select count(*)::integer as count from findings" })
    ).toMatchObject({ rows: [{ count: 3 }] });
  });

  it("refuses a second statement and a write through query", async () => {
    const world = await published("read_only");
    await call(world, "insert", { table: "findings", rows: [finding(1)] });

    expect(
      await refusal(call(world, "query", { sql: "select 1; delete from findings" }))
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Queries must contain a single statement"
    });
    expect(await refusal(call(world, "query", { sql: "delete from findings" }))).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Queries must be read-only SELECT or WITH statements"
    });
    // What the screening lets through, the read-only transaction refuses.
    expect(
      await refusal(
        call(world, "query", {
          sql: "with gone as (select nextval(pg_get_serial_sequence('findings', 'id'))) select * from gone"
        })
      )
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "The query tried to change data. Queries run in a read-only transaction."
    });
    expect(
      await call(world, "query", { sql: "select count(*)::integer as count from findings" })
    ).toMatchObject({ rows: [{ count: 1 }] });
  });

  it("bounds a batch by rows and bytes and a result by rows and bytes", async () => {
    const world = await published("limits");
    const operation = required(
      await world.dataStores.operationSource.resolve(dataStoreOperationName("findings", "insert"))
    );
    const batch = (count: number, overrides: JsonObject = {}) =>
      Array.from({ length: count }, (_, index) => finding(index, overrides));

    expect(operation.inputSchema.safeParse({ table: "findings", rows: batch(1_001) }).success).toBe(
      false
    );
    expect(
      await refusal(
        call(world, "insert", {
          table: "findings",
          rows: batch(600, { details: { note: "n".repeat(2_000) } })
        })
      )
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { cap: "DATA_STORE_INSERT_MAX_BYTES" }
    });
    expect(
      await refusal(
        call(world, "insert", { table: "findings", rows: [finding(1), { run_id: "run-1" }] })
      )
    ).toMatchObject({ code: "VALIDATION_FAILED", details: { reason: "rows_differ" } });

    await call(world, "insert", { table: "findings", rows: batch(1_000) });
    await call(world, "insert", { table: "findings", rows: batch(1) });
    const byRows = z
      .object({ rows: z.array(z.unknown()), truncated: z.boolean() })
      .parse(await call(world, "query", { sql: "select id from findings" }));
    expect([byRows.rows.length, byRows.truncated]).toEqual([1_000, true]);

    // 1,000 rows of 3 kB each pass the byte cap of a result before they pass its row cap.
    const byBytes = z
      .object({ rows: z.array(z.unknown()), truncated: z.boolean() })
      .parse(await call(world, "query", { sql: "select repeat('x', 3000) as wide from findings" }));
    expect(byBytes.truncated).toBe(true);
    expect(byBytes.rows.length).toBeLessThan(1_000);
  });

  it("answers a failure of the database with its SQLSTATE and no value", async () => {
    const world = await published("failures");

    const check = await refusal(
      call(world, "insert", {
        table: "findings",
        rows: [finding(1, { severity: "secret-severity-value" })]
      })
    );
    const type = await refusal(
      call(world, "insert", {
        table: "findings",
        rows: [finding(1, { revision: "secret-number" })]
      })
    );

    expect(check).toEqual({
      code: "VALIDATION_FAILED",
      message: "The insert breaks a check of its table (SQLSTATE 23514).",
      details: { sqlState: "23514" }
    });
    expect(type.message).toBe(
      "The insert holds a value that does not fit the type of its column (SQLSTATE 22P02)."
    );
    expect(
      await refusal(call(world, "insert", { table: "bookings", rows: [finding(1)] }))
    ).toMatchObject({ message: "The store has no table 'bookings'" });
    expect(
      await refusal(call(world, "insert", { table: "findings", rows: [{ nope: 1 }] }))
    ).toMatchObject({ message: "The table 'findings' has no column 'nope' that an insert sets" });
    expect(await refusal(call(world, "query", { sql: "select * from bookings" }))).toMatchObject({
      message: "The query names a table or view that does not exist (SQLSTATE 42P01)."
    });
    // What the database does not do for this statement is the caller's to change, not a fault.
    expect(
      await refusal(call(world, "query", { sql: "select * from elsewhere.public.findings" }))
    ).toEqual({
      code: "VALIDATION_FAILED",
      message: "The query asks for something the database does not support (SQLSTATE 0A000).",
      details: { sqlState: "0A000" }
    });
  });

  it("skips only where a key cannot hold NULL, and says so where it can", async () => {
    const keys: StoreFile = {
      path: "migrations/0002_keys.sql",
      text: `create table loose (run_id text not null, amount numeric, unique (run_id, amount));
        create table tight (run_id text not null, amount numeric, unique nulls not distinct (run_id, amount));`
    };
    const world = await published("null_keys", [manifest(), init, keys]);
    const row = { run_id: "run-1", amount: null };

    // Two rows with NULL in a key never conflict, so `skip` would add the same row twice.
    expect(
      await refusal(call(world, "insert", { table: "loose", rows: [row], onConflict: "skip" }))
    ).toEqual({
      code: "VALIDATION_FAILED",
      message:
        "The table 'loose' has a unique constraint over the column 'amount', which may be empty: rows that are empty there never conflict, so 'skip' would add the same row again. Make the column NOT NULL, or the constraint NULLS NOT DISTINCT.",
      details: { reason: "nullable_key", column: "amount" }
    });
    const insert = () => call(world, "insert", { table: "tight", rows: [row], onConflict: "skip" });
    expect(await insert()).toEqual({ table: "tight", inserted: 1, skipped: 0 });
    expect(await insert()).toEqual({ table: "tight", inserted: 0, skipped: 1 });
  });

  it("takes the size ceiling from release config, which a manifest lowers and never raises", async () => {
    const world = await setup("ceiling", { sizeLimitBytes: 2 * 1024 ** 3 });
    const limitOf = async (extra: string) =>
      (await recordOf(world, await publish(world, [manifest(extra), init]))).sizeLimitBytes;

    expect(await limitOf("")).toBe(2 * 1024 ** 3);
    expect(await limitOf("sizeLimit: 500MB\n")).toBe(500 * 1024 ** 2);
    expect(await limitOf("sizeLimit: 9GB\n")).toBe(2 * 1024 ** 3);
  });

  it("refuses the publish of a store whose manifest names another scope than its owner", async () => {
    const world = await setup("scope");

    // The stores of this suite belong to the instance.
    await expect(publish(world, [manifest("scope: workspace\n"), init])).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "'store.yaml' says scope 'workspace' and the store belongs to the instance. Write the store for a workspace, or change 'scope'.",
      details: { reason: "scope_mismatch" }
    });
    const id = await publish(world, [manifest("scope: instance\n"), init]);
    expect(await recordOf(world, id)).toMatchObject({ status: "provisioning" });
  });

  it("measures a store when it is provisioned and migrated, so the size limit holds from the first insert", async () => {
    const world = await published("size", [manifest("sizeLimit: 1MB\n"), init]);
    const measured = await eventually(async () => {
      const record = await recordOf(world, world.id);
      expect(record.sizeBytes).toBeGreaterThan(1024 ** 2);
      return record;
    });

    // An empty database is larger than 1 MB: no row is added, from the first call on.
    expect(await refusal(call(world, "insert", { table: "findings", rows: [finding(1)] }))).toEqual(
      {
        code: "CONFLICT",
        message: `The Data Store 'findings' holds ${measured.sizeBytes} bytes and its size limit is 1048576 bytes (sizeLimit). No rows are added until it is smaller or the limit is raised; reading keeps working.`,
        details: { reason: "data_store_size_limit", limit: 1024 ** 2, actual: measured.sizeBytes }
      }
    );
    expect(
      await call(world, "query", { sql: "select count(*)::integer as count from findings" })
    ).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("measures again on an insert when the stored size is older than a minute", async () => {
    const world = await published("size_stale", [manifest("sizeLimit: 1MB\n"), init]);
    // As if the last measurement were an hour old and had found the store nearly empty.
    await db.sql`
      update data_stores set size_bytes = 10, size_measured_at = now() - interval '1 hour'
      where id = ${world.id}`;

    expect(
      await refusal(call(world, "insert", { table: "findings", rows: [finding(1)] }))
    ).toMatchObject({ details: { reason: "data_store_size_limit" } });
    const record = await recordOf(world, world.id);
    expect(record.sizeBytes).toBeGreaterThan(1024 ** 2);
    expect(Date.now() - Date.parse(required(record.sizeMeasuredAt))).toBeLessThan(60_000);

    // A measurement of this minute is believed: no second one is made for the next insert.
    await db.sql`update data_stores set size_bytes = 10 where id = ${world.id}`;
    expect(await call(world, "insert", { table: "findings", rows: [finding(1)] })).toMatchObject({
      inserted: 1
    });
    expect(world.dataStores.schedules.map((schedule) => schedule.kind.kind)).toEqual([
      DATA_STORE_JOB_KINDS.measureSize
    ]);
  });

  it("keeps the database and its rows when the store is retired, and holds its id", async () => {
    const world = await published("retire");
    const { id, record, clientInstanceId, dataStores } = world;
    await call(world, "insert", { table: "findings", rows: [finding(1), finding(2)] });

    await db.store.transaction((stores) => dataStores.retire(stores, id));

    expect(await recordOf(world, id)).toMatchObject({ status: "retired", level: 1 });
    expect(
      await dataStores.operationSource.resolve(dataStoreOperationName("findings", "query"))
    ).toBeUndefined();
    expect((await dataStores.operationSource.list({})).operations).toEqual([]);
    const inStore = connect(record.location.database);
    expect(
      countSchema.parse(await inStore`select count(*)::integer as count from findings`)
    ).toEqual([{ count: 2 }]);

    // The asset is gone and another one takes the name: its publish is refused while the
    // retired database is there.
    const asset = required(
      await db.store.configAssets.getConfigAsset({
        clientInstanceId,
        kind: DATA_STORE_ASSET_KIND,
        name: "findings"
      })
    );
    await db.store.configAssets.removeConfigAsset({
      clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name: "findings",
      assetId: asset.id,
      expectedRevision: asset.revision
    });
    await expect(publish(world, [manifest(), init])).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "data_store_id_held" }
    });
  });
});
