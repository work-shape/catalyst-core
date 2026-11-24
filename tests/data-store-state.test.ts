import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NoopAuditRecorder,
  asClientInstanceId,
  createPlatformId,
  asUserId,
  type ActorAccess,
  type AuthenticatedUser,
  type PermissionGrant
} from "@work-shape/catalyst-core";
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

/** A row of the reader's on the whole instance, as the Access page writes it. */
function instanceRow(action: string, effect: "allow" | "deny"): PermissionGrant {
  return {
    id: `grant_${action}_${effect}`,
    clientInstanceId: reader.clientInstanceId,
    holderKind: "user",
    holderId: reader.id,
    action,
    effect,
    scopeKind: "instance",
    grantedBy: asUserId("usr_root"),
    createdAt: "2026-10-24T00:00:00.000Z"
  };
}

/** The reader holding `system.view` (RIGHTS-1e), as who runs the database server does. */
const operator = accessOf(reader, { grants: [instanceRow("system.view", "allow")] });

describe("the state of a Data Store", () => {
  const { db, setup, publish, published, recordOf } = useDataStoreWorld("data_store_state");

  type World = Awaited<ReturnType<typeof setup>>;

  async function operationOf(world: World) {
    return required(await world.dataStores.operationSource.resolve("data_store.findings.state"));
  }

  async function stateOf(
    world: World,
    access: ActorAccess = operator,
    actor: AuthenticatedUser = reader
  ) {
    const operation = await operationOf(world);
    return operation.execute(operation.inputSchema.parse({}), {
      runId: createPlatformId<"OperationRunId">("opr"),
      actor,
      origin: { kind: "user" },
      correlationId: "data-store-state",
      runtime: {},
      access,
      audit: new NoopAuditRecorder()
    });
  }

  it("answers the level, the size against the limit, the conditions for their audience and the last migration in one read, also without the store's database", async () => {
    const world = await published("ready");

    expect(await stateOf(world)).toEqual({
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

    // Near its limit from 80 percent of it.
    const at = (bytes: number) =>
      db.sql`update data_stores set size_bytes = ${bytes}, size_limit_bytes = 1000 where id = ${world.id}`;
    await at(799);
    expect(await stateOf(world)).toMatchObject({
      size: { bytes: 799, limitBytes: 1000, nearLimit: false }
    });
    await at(800);
    expect(await stateOf(world)).toMatchObject({ size: { bytes: 800, nearLimit: true } });

    // What the server leaves open is shown to a signed-in holder of system.view, and hidden
    // from a deny or a personal key.
    await db.sql`update data_stores set conditions = ${db.sql.json([
      "server_databases_open",
      "sessions_open",
      "temp_files_unbounded"
    ])} where id = ${world.id}`;
    const codes = async (access: ActorAccess, actor: AuthenticatedUser = reader) =>
      stateSchema.parse(await stateOf(world, access, actor)).conditions.map(({ code }) => code);
    expect(await codes(operator)).toEqual([
      "server_databases_open",
      "sessions_open",
      "temp_files_unbounded"
    ]);
    // An admin reads the store and does not see how the instance runs.
    expect(await codes(accessOf(reader))).toEqual([]);
    expect(
      await codes(
        accessOf(reader, {
          grants: [instanceRow("system.view", "allow"), instanceRow("system.view", "deny")]
        })
      )
    ).toEqual([]);
    expect(await codes(accessOf({ ...reader, roles: ["user", "superadmin"] }))).toEqual([
      "server_databases_open",
      "sessions_open",
      "temp_files_unbounded"
    ]);
    // A model-check scope cannot disclose server details through an authoring read.
    const keyOwner = { ...reader, keyScopes: ["data_store.read", "system.view"] };
    const keyAccess = accessOf(keyOwner, { grants: [instanceRow("system.view", "allow")] });
    expect(keyAccess.authorize("system.view").allowed).toBe(true);
    expect(await codes(keyAccess, keyOwner)).toEqual([]);
    // The rest of the state is the same for both.
    const { conditions: _shown, ...forOperator } = z
      .record(z.string(), z.unknown())
      .parse(await stateOf(world));
    const { conditions: _hidden, ...forAdmin } = z
      .record(z.string(), z.unknown())
      .parse(await stateOf(world, accessOf(reader)));
    expect(forAdmin).toEqual(forOperator);

    // A read under data_store.read that leaves no run and reaches no database of a store.
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
    await world.dataStores.close();
    await db.sql.unsafe(`drop database "${world.record.location.database}" with (force)`);
    expect(await stateOf(world)).toMatchObject({ status: "ready", level: 1 });
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
