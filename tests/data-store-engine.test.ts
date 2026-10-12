import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DATA_STORE_ASSET_KIND,
  DATA_STORE_JOB_KINDS,
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
  const { db, jobs, setup, publish, recordOf, settle, published, call, connect } =
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
    expect(issuesOf([manifest("tables: []\n"), init])[0]).toContain("tables");
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
    ).toEqual({ table: "findings", insertedCount: 2 });
    const rows = await call(world, "query", {
      sql: "select client_id, severity, amount, details from findings where rule_id = $1 order by client_id",
      parameters: ["vat-rate"]
    });

    expect(rows).toEqual({
      columns: [
        { name: "client_id", type: "text" },
        { name: "severity", type: "text" },
        { name: "amount", type: "numeric" },
        { name: "details", type: "jsonb" }
      ],
      rows: [
        { client_id: "client-1", severity: "warning", amount: "119.50", details: { booking: 1 } },
        { client_id: "client-2", severity: "warning", amount: "119.50", details: { booking: 2 } }
      ],
      truncated: false
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
    expect(stored).toEqual({ table: "findings", insertedCount: 1 });
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
  });

  it("applies new migrations forward and never changes an applied one", async () => {
    const world = await published("migrations");
    const { id } = world;
    await call(world, "insert", { table: "findings", rows: [finding(1)] });
    const second: StoreFile = {
      path: "migrations/0002_reviewed.sql",
      text: "alter table findings add column reviewed boolean not null default false;"
    };

    await publish(world, [manifest(), init, second]);
    const atTwo = await settle(world, id, 2);
    expect(atTwo.migrations.map((migration) => migration.name)).toEqual(["init", "reviewed"]);
    expect(await call(world, "query", { sql: "select reviewed from findings" })).toMatchObject({
      rows: [{ reviewed: false }]
    });

    // A changed file that the store has applied refuses the publish, and nothing moves.
    const changed = { ...init, text: `${INIT_SQL}\n-- changed` };
    await expect(publish(world, [manifest(), changed, second])).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "The store has applied 'migrations/0001_init.sql' and the revision holds 'migrations/0001_init.sql' with other content. An applied migration is never changed: add a new migration instead.",
      details: { reason: "applied_migration_changed" }
    });
    await expect(publish(world, [manifest(), init])).rejects.toMatchObject({
      message: expect.stringContaining("has applied 'migrations/0002_reviewed.sql'")
    });
    const asset = await db.store.configAssets.getConfigAsset({
      clientInstanceId: world.clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name: "findings"
    });
    expect(asset?.publishedRevision).toBe(atTwo.targetRevision);
    expect(await recordOf(world, id)).toMatchObject({
      level: 2,
      targetRevision: atTwo.targetRevision
    });

    // A migration that fails leaves the level and says which file failed, without its SQL.
    const failing: StoreFile = {
      path: "migrations/0003_owner.sql",
      text: "alter table findings add column owner text; alter table nowhere add column x text;"
    };
    await publish(world, [manifest(), init, second, failing]);
    const failed = await eventually(async () => {
      await world.worker.runDue();
      const record = await recordOf(world, id);
      expect(record.failure).toBeDefined();
      return record;
    });
    expect(failed).toMatchObject({
      status: "ready",
      level: 2,
      failure: {
        code: "migration_failed",
        message:
          "'migrations/0003_owner.sql' names a table or view that does not exist (SQLSTATE 42P01)."
      }
    });
    // The failed file left nothing behind: its first statement was rolled back with it.
    expect(
      await refusal(call(world, "query", { sql: "select owner from findings" }))
    ).toMatchObject({
      message: "The query names a column that does not exist (SQLSTATE 42703)."
    });

    const fixed = { ...failing, text: "alter table findings add column owner text;" };
    await publish(world, [manifest(), init, second, fixed]);
    const atThree = await settle(world, id, 3);
    expect(atThree.failure).toBeUndefined();
    expect(
      await call(world, "query", { sql: "select owner, reviewed from findings" })
    ).toMatchObject({
      rows: [{ owner: null, reviewed: false }]
    });
  });

  it("refuses an insert at the size limit and keeps answering queries", async () => {
    const world = await published("size", [manifest("sizeLimit: 1MB\n"), init]);
    const { id } = world;
    await call(world, "insert", { table: "findings", rows: [finding(1)] });
    expect(await recordOf(world, id)).toMatchObject({ sizeLimitBytes: 1024 ** 2 });

    const measure = jobs.worker(
      db.store,
      world.clientInstanceId,
      [...world.dataStores.jobHandlers],
      [...world.dataStores.schedules]
    );
    measure.start();
    const measured = await eventually(async () => {
      const record = await recordOf(world, id);
      expect(record.sizeBytes).toBeGreaterThan(1024 ** 2);
      return record;
    });
    await measure.stop();

    expect(world.dataStores.schedules.map((schedule) => schedule.kind.kind)).toEqual([
      DATA_STORE_JOB_KINDS.measureSize
    ]);
    expect(await refusal(call(world, "insert", { table: "findings", rows: [finding(2)] }))).toEqual(
      {
        code: "CONFLICT",
        message: `The Data Store 'findings' holds ${measured.sizeBytes} bytes and its size limit is 1048576 bytes (sizeLimit). No rows are added until it is smaller or the limit is raised; reading keeps working.`,
        details: { reason: "data_store_size_limit", limit: 1024 ** 2, actual: measured.sizeBytes }
      }
    );
    expect(
      await call(world, "query", { sql: "select count(*)::integer as count from findings" })
    ).toMatchObject({ rows: [{ count: 1 }] });
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
      expectedRevision: asset.revision
    });
    await expect(publish(world, [manifest(), init])).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "data_store_id_held" }
    });
  });
});
