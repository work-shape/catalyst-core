import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NoopAuditRecorder,
  asClientInstanceId,
  createPlatformId,
  type AuthenticatedUser
} from "@vivd-catalyst/core";
import { accessOf } from "./support/access";
import { eventually, required } from "./support/assertions";
import { init, manifest, useDataStoreWorld } from "./support/data-store-world";

// The one read that answers the state of a store for the screen that shows it, against real
// Postgres: the level, the size against the limit, what the server leaves open in words an
// operator can act on, and how the last migration ended.

const stateSchema = z.object({
  conditions: z.array(z.object({ code: z.string(), message: z.string() }))
});

const reader: AuthenticatedUser = {
  id: "usr_data_store_state",
  externalUserId: "data-store-state",
  displayLabel: "Data Store state",
  roles: ["admin"],
  permissionRefs: [],
  clientInstanceId: asClientInstanceId("data-store-test"),
  authSource: "test"
};

describe("the state of a Data Store", () => {
  const { db, setup, publish, published, recordOf } = useDataStoreWorld("data_store_state");

  type World = Awaited<ReturnType<typeof setup>>;

  async function operationOf(world: World) {
    return required(await world.dataStores.operationSource.resolve("data_store.findings.state"));
  }

  async function stateOf(world: World) {
    const operation = await operationOf(world);
    return operation.execute(operation.inputSchema.parse({}), {
      runId: createPlatformId<"OperationRunId">("opr"),
      actor: reader,
      origin: { kind: "user" },
      correlationId: "data-store-state",
      runtime: {},
      access: accessOf(reader),
      audit: new NoopAuditRecorder()
    });
  }

  it("answers the level, the size against the limit and the last migration of a store in one read", async () => {
    const world = await published("ready");

    const state = await stateOf(world);

    expect(state).toEqual({
      id: world.id,
      name: "findings",
      status: "ready",
      level: 1,
      publishedLevel: 1,
      size: {
        bytes: world.record.sizeBytes,
        measuredAt: world.record.sizeMeasuredAt,
        limitBytes: 5 * 1024 ** 3,
        nearLimit: false
      },
      conditions: world.record.conditions.map((code) => ({
        code,
        message: expect.any(String)
      })),
      lastMigration: { outcome: "applied", migration: { number: 1, name: "init" } }
    });
    expect(world.record.sizeBytes).toBeGreaterThan(0);
  });

  it("declares a read under data_store.read that leaves no run and reaches no database of a store", async () => {
    const world = await published("declared");
    const operation = await operationOf(world);

    expect(operation).toMatchObject({
      name: "data_store.findings.state",
      effect: "reading",
      action: "data_store.read",
      scope: "config_assets:read",
      auth: "principal",
      module: "dataStores"
    });
    expect(operation.recordsEveryCall).toBeUndefined();
    expect(operation.resource({})).toMatchObject({ kind: "data_store", id: world.id });
    // The database of the store is gone, and its state is still answered.
    await world.dataStores.close();
    await db.sql.unsafe(`drop database "${world.record.location.database}" with (force)`);
    expect(await stateOf(world)).toMatchObject({ status: "ready", level: 1 });
  });

  it("says a store is near its limit from 80 percent of it", async () => {
    const world = await published("near");
    const at = (bytes: number) =>
      db.sql`update data_stores set size_bytes = ${bytes}, size_limit_bytes = 1000 where id = ${world.id}`;

    await at(799);
    expect(await stateOf(world)).toMatchObject({
      size: { bytes: 799, limitBytes: 1000, nearLimit: false }
    });
    await at(800);
    expect(await stateOf(world)).toMatchObject({ size: { bytes: 800, nearLimit: true } });
  });

  it("says of each thing the server leaves open what an operator does about it", async () => {
    const world = await published("open");
    await db.sql`update data_stores set conditions = ${db.sql.json([
      "server_databases_open",
      "sessions_open",
      "temp_files_unbounded"
    ])} where id = ${world.id}`;

    const { conditions } = stateSchema.parse(await stateOf(world));

    expect(conditions.map(({ code }) => code)).toEqual([
      "server_databases_open",
      "sessions_open",
      "temp_files_unbounded"
    ]);
    const [databases, sessions, tempFiles] = conditions.map(({ message }) => message);
    expect(databases).toContain("REVOKE CONNECT ON DATABASE <name> FROM PUBLIC");
    expect(databases).toContain("host postgres,template1 /^catalyst_ds_ all reject");
    expect(sessions).toContain("superuser");
    expect(sessions).toContain("end another query of this store");
    expect(tempFiles).toContain("temp_file_limit in postgresql.conf");

    await db.sql`update data_stores set conditions = '[]'::jsonb where id = ${world.id}`;
    expect(await stateOf(world)).toMatchObject({ conditions: [] });
  });

  it("names the migration that failed and why, and the level the store stays at", async () => {
    const world = await published("failed");
    await publish(world, [
      manifest(),
      init,
      { path: "migrations/0002_broken.sql", text: "alter table nowhere add column note text;" },
      { path: "migrations/0003_later.sql", text: "create table later (id integer);" }
    ]);

    // Published and not applied yet: its job has not run.
    expect(await stateOf(world)).toMatchObject({
      level: 1,
      publishedLevel: 3,
      lastMigration: { outcome: "pending", migration: { number: 2, name: "broken" } }
    });

    await eventually(async () => {
      await world.worker.runDue();
      expect((await recordOf(world, world.id)).failure).toBeDefined();
    });
    const state = await stateOf(world);
    expect(state).toMatchObject({
      status: "ready",
      level: 1,
      publishedLevel: 3,
      lastMigration: {
        outcome: "failed",
        migration: { number: 2, name: "broken" },
        failure: { code: "migration_failed", message: expect.stringContaining("42P01") }
      }
    });
    expect(JSON.stringify(state)).not.toContain("nowhere");
  });

  it("answers a store whose database is not there yet, and none for an id no store has", async () => {
    const world = await setup("provisioning");
    const id = await publish(world, [manifest(), init]);

    expect(await stateOf(world)).toEqual({
      id,
      name: "findings",
      status: "provisioning",
      level: 0,
      publishedLevel: 1,
      size: { limitBytes: 5 * 1024 ** 3, nearLimit: false },
      conditions: [],
      lastMigration: { outcome: "pending", migration: { number: 1, name: "init" } }
    });
    expect(
      await world.dataStores.operationSource.resolve("data_store.nowhere.state")
    ).toBeUndefined();
  });
});
