import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { eventually, waitUntil } from "./support/assertions";
import { fileTestDatabaseUrl } from "./support/test-database";
import { useDataStoreInstance, type DataStoreInstance } from "./support/data-store-instance";
import { getTestJobs } from "./support/test-instance";

const schema = {
  path: "migrations/0001_init.sql",
  text: "create table findings (id text primary key);"
};
const dropKey = {
  path: "migrations/0002_drop_key.sql",
  text: "alter table findings drop constraint findings_pkey; create table should_roll_back (id text);"
};
const manifest = (withRules: boolean) => ({
  path: "store.yaml",
  text: `id: findings\n${withRules ? "records:\n  - table: findings\n    key: { column: id, fromField: id }\n" : ""}`
});

describe("records keys across publishes over HTTP", () => {
  const { start, put, publish, settle, recordOf } = useDataStoreInstance();

  async function revision(
    world: DataStoreInstance,
    number: number,
    withRules: boolean,
    migrations = [schema]
  ) {
    const saved = await put(
      world,
      [manifest(withRules), ...migrations],
      number === 1 ? null : number - 1
    );
    expect(saved.statusCode, saved.body).toBe(200);
    const published = await publish(world, number);
    expect(published.statusCode, published.body).toBe(200);
  }

  async function rolledBack(world: DataStoreInstance, primaryKey = true) {
    await eventually(async () => {
      await getTestJobs(world.api).runDue();
      expect(await recordOf(world)).toMatchObject({
        level: 1,
        migrations: [{ number: 1 }],
        failure: {
          code: "record_key_invalid",
          message: expect.stringContaining("records.findings.key.id")
        }
      });
    });
    const state = await world.api.call("data_stores.get", { params: { store: "findings" } });
    expect(state.statusCode, state.body).toBe(200);
    expect(state.body).toContain("Nothing of it was applied.");
    expect(state.body).toContain("0002_");
    const described = await world.api.call("data_stores.describe", {
      params: { store: "findings" }
    });
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json()).toMatchObject({
      schemaLevel: 1,
      tables: [{ name: "findings", columns: [{ name: "id", primaryKey }] }]
    });
    expect(described.body).not.toContain("should_roll_back");
  }

  it("refuses an invalid rule without pending DDL with HTTP 422 and keeps the published pointer", async () => {
    const world = await start(true);
    await revision(world, 1, false);
    await settle(world, 1);
    const invalid = manifest(true);
    invalid.text = invalid.text.replace("table: findings", "table: absent");
    const saved = await put(world, [invalid, schema], 1);
    expect(saved.statusCode, saved.body).toBe(200);
    const refused = await publish(world, 2);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("records.absent.key.id"),
        details: { reason: "record_key_invalid" }
      }
    });
    expect((await recordOf(world)).targetRevision).toBe(1);
  });

  it("rolls back a migration that drops a published records key, including its other DDL", async () => {
    const world = await start(true);
    // The schema and rules can be published in one step.
    await revision(world, 1, true);
    expect((await settle(world, 1)).failure).toBeUndefined();
    await revision(world, 2, true, [schema, dropKey]);
    await rolledBack(world);
    // It is still the real unique key, not just a stale platform mirror.
    await revision(world, 3, true, [schema, dropKey]);
    await rolledBack(world);
  });

  it.each([
    ["unrelated", "create table should_not_run (id text);"],
    ["failing", "select 1 / 0;"]
  ])("rolls back 0002 dropping an existing unique records key before %s 0003", async (_, sql) => {
    const world = await start(true);
    const uniqueSchema = {
      ...schema,
      text: "create table findings (objekt_nr text unique);"
    };
    const rules = manifest(true);
    rules.text = rules.text.replaceAll(
      "column: id, fromField: id",
      "column: objekt_nr, fromField: objekt_nr"
    );
    expect((await put(world, [rules, uniqueSchema], null)).statusCode).toBe(200);
    expect((await publish(world, 1)).statusCode).toBe(200);
    expect((await settle(world, 1)).failure).toBeUndefined();
    const migrations = [
      uniqueSchema,
      {
        path: "migrations/0002_drop_key.sql",
        text: "alter table findings drop constraint findings_objekt_nr_key; create table should_roll_back (id text);"
      },
      { path: "migrations/0003_later.sql", text: sql }
    ];
    expect((await put(world, [rules, ...migrations], 1)).statusCode).toBe(200);
    expect((await publish(world, 2)).statusCode).toBe(200);
    await eventually(async () => {
      await getTestJobs(world.api).runDue();
      expect(await recordOf(world)).toMatchObject({
        level: 1,
        migrations: [{ number: 1 }],
        failure: {
          code: "record_key_invalid",
          message: expect.stringContaining(
            "'migrations/0002_drop_key.sql' violates 'records.findings.key.objekt_nr'"
          )
        }
      });
    });
    const described = await world.api.call("data_stores.describe", {
      params: { store: "findings" }
    });
    expect(described.statusCode, described.body).toBe(200);
    expect(described.body).not.toContain("should_roll_back");
    expect(described.body).not.toContain("should_not_run");
    // Publishing the same rules without pending DDL rechecks the real unique index.
    expect((await put(world, [rules, uniqueSchema], 2)).statusCode).toBe(200);
    const rechecked = await publish(world, 3);
    expect(rechecked.statusCode, rechecked.body).toBe(200);
  });

  it("reports a records key not created yet when the batch fails before its key-adding file", async () => {
    const world = await start(true);
    await revision(world, 1, true, [
      { ...schema, text: "create table findings (id text);" },
      { path: "migrations/0002_failing.sql", text: "select 1 / 0;" },
      { path: "migrations/0003_key.sql", text: "alter table findings add primary key (id);" }
    ]);
    await eventually(async () => {
      await getTestJobs(world.api).runDue();
      expect(await recordOf(world)).toMatchObject({
        level: 1,
        migrations: [{ number: 1 }],
        failure: {
          code: "migration_failed",
          message: expect.stringContaining("0002_failing.sql")
        }
      });
    });
    const state = await world.api.call("data_stores.get", { params: { store: "findings" } });
    expect(state.statusCode, state.body).toBe(200);
    expect(state.body).toContain("A records key is not there yet:");
    expect(state.body).toContain("records.findings.key.id");
  });

  it("allows a table and its records key to be created in separate migrations of one publish", async () => {
    const world = await start(true);
    await revision(world, 1, true, [
      { ...schema, text: "create table findings (id text);" },
      { path: "migrations/0002_key.sql", text: "alter table findings add primary key (id);" }
    ]);
    const completed = await settle(world, 2);
    expect(completed.failure).toBeUndefined();
    expect(completed).toMatchObject({
      level: 2,
      targetRevision: 1,
      migrations: [{ number: 1 }, { number: 2 }]
    });
    const described = await world.api.call("data_stores.describe", {
      params: { store: "findings" }
    });
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json()).toMatchObject({
      tables: [{ name: "findings", columns: [{ name: "id", primaryKey: true }] }]
    });
  });

  it("rolls back the final migration when the batch never creates its records key", async () => {
    const world = await start(true);
    await revision(world, 1, true, [
      { ...schema, text: "create table findings (id text);" },
      { path: "migrations/0002_incomplete.sql", text: "create table should_roll_back (id text);" }
    ]);
    await rolledBack(world, false);
  });

  it("checks rules published while an earlier migration is queued against its resulting schema", async () => {
    const world = await start(true);
    await revision(world, 1, false);
    await settle(world, 1);
    await revision(world, 2, false, [schema, dropKey]);
    // No jobs have run: ready describes the old schema, while revision 2's DDL is queued.
    expect(await recordOf(world)).toMatchObject({ status: "ready", level: 1, targetRevision: 2 });
    await revision(world, 3, true, [schema, dropKey]);
    expect(await recordOf(world)).toMatchObject({ targetRevision: 3 });
    await rolledBack(world);
  });

  it("keeps the latest publish and rolls back 0003 when rules arrive during a running batch", async () => {
    const world = await start(true);
    await revision(world, 1, false);
    const record = await settle(world, 1);
    const platformUrl = await fileTestDatabaseUrl();
    const storeUrl = new URL(platformUrl);
    storeUrl.pathname = `/${record.location.database}`;
    const store = postgres(storeUrl.toString(), { max: 2, onnotice: () => undefined });
    const platform = postgres(platformUrl, { max: 1, onnotice: () => undefined });
    const holder = await store.reserve();
    const hold = 74003;
    let running: Promise<unknown> | undefined;
    let publishing: ReturnType<typeof publish> | undefined;
    try {
      await holder`select pg_advisory_lock(${hold})`;
      const migrations = [
        schema,
        {
          path: "migrations/0002_slow.sql",
          text: `select pg_advisory_xact_lock(${hold}); create table slow_done (id text);`
        },
        { ...dropKey, path: "migrations/0003_drop_key.sql" }
      ];
      await revision(world, 2, false, migrations);
      running = getTestJobs(world.api).runDue();
      await waitUntil(
        async () =>
          (
            await store`
        select 1 from pg_locks where locktype = 'advisory'
          and database = (select oid from pg_database where datname = current_database())
          and objid = ${hold} and not granted`
          ).length > 0,
        "0002 is running and waiting for the test's lock"
      );
      expect((await put(world, [manifest(true), ...migrations], 2)).statusCode).toBe(200);
      let published = false;
      publishing = publish(world, 3).then((response) => {
        published = true;
        return response;
      });
      // With the migration lock, publish queues behind 0002. Without it, publish
      // completes now and 0002 overwrites targetRevision with its stale store row.
      await waitUntil(
        async () =>
          published ||
          (
            await platform`
        select 1 from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query like '%data_stores%'
          and pid <> pg_backend_pid()`
          ).length > 0,
        "publish has reached the store row held by 0002"
      );
      await holder`select pg_advisory_unlock(${hold})`;
      const response = await publishing;
      expect(response.statusCode, response.body).toBe(200);
      await running;
      await eventually(async () => {
        expect(await recordOf(world)).toMatchObject({
          targetRevision: 3,
          level: 2,
          migrations: [{ number: 1 }, { number: 2 }],
          failure: {
            code: "record_key_invalid",
            message: expect.stringContaining("0003_drop_key.sql")
          }
        });
      });
      const described = await world.api.call("data_stores.describe", {
        params: { store: "findings" }
      });
      expect(described.statusCode, described.body).toBe(200);
      expect(described.json()).toMatchObject({
        schemaLevel: 2,
        tables: expect.arrayContaining([
          expect.objectContaining({
            name: "findings",
            columns: [expect.objectContaining({ name: "id", primaryKey: true })]
          }),
          expect.objectContaining({ name: "slow_done" })
        ])
      });
      expect(described.body).not.toContain("should_roll_back");
    } finally {
      await holder`select pg_advisory_unlock_all()`;
      holder.release();
      await Promise.allSettled([running, publishing]);
      await Promise.all([store.end(), platform.end()]);
    }
  });
});
