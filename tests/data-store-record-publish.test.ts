import { describe, expect, it } from "vitest";
import { eventually } from "./support/assertions";
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

  async function rolledBack(world: DataStoreInstance) {
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
    const described = await world.api.call("data_stores.describe", {
      params: { store: "findings" }
    });
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json()).toMatchObject({
      schemaLevel: 1,
      tables: [{ name: "findings", columns: [{ name: "id", primaryKey: true }] }]
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
});
