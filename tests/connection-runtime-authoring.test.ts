import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSecretStore, loadSecretKeyring } from "@vivd-catalyst/connections";
import { SHARED_CREDENTIAL_SUBJECT } from "@vivd-catalyst/core";
import { errorSchema } from "./support/access-instance";
import { required } from "./support/assertions";
import { URL_OF_HOST, fixture } from "./support/connection-operations";
import { connection } from "./support/connections";
import {
  OUTSIDE_HOST,
  clientInstanceId,
  detail,
  discoveryJobs,
  runJobs,
  storedState,
  world
} from "./support/connection-discovery-world";
import { generateSecretStoreKey, generateTestSecret } from "./support/test-connector";
import type { TestInstance } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// A Connection made on an assembled instance, over real rows: created and changed through the
// asset operations, its key entered once through `connections.set_secret`, its tools read by
// the discovery job and accepted by a write. Every test fails without the change: before it a
// Connection could not be created on the instance, and no operation took a secret.

const NAME = "made-here";
const URL = `https://${OUTSIDE_HOST}/mcp`;

const started: TestInstance[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((instance) => instance.close()));
});

async function start(w = world()) {
  const instance = await w.start();
  started.push(instance);
  return instance;
}

/** The definition a person writes in Build: no origin, no owner, no handle. */
function definition(overrides: Record<string, unknown> = {}) {
  return {
    name: NAME,
    displayName: "Made here",
    connectorType: "discovering",
    settings: { url: URL },
    authScheme: "bearer",
    operations: [],
    enabled: true,
    ...overrides
  };
}

const put = (
  instance: TestInstance,
  config: Record<string, unknown>,
  expectedRevision: number | null
) =>
  instance.call("assets.put", {
    params: { kind: "connection", name: NAME },
    payload: { config, expectedRevision }
  });

const setSecret = (instance: TestInstance, value: string, expectedVersion: number | null) =>
  instance.call("connections.set_secret", {
    params: { name: NAME },
    payload: { value, expectedVersion }
  });

const discoveredSchema = z.object({
  discovered: z.array(
    z.object({ name: z.string(), proposedEffect: z.string(), fingerprint: z.string() })
  )
});

async function discovered(instance: TestInstance) {
  const response = await instance.call("connections.get", { params: { name: NAME } });
  expect(response.statusCode).toBe(200);
  return discoveredSchema.parse(response.json()).discovered;
}

/** The stored secret versions of the Connection made here, not those of release config. */
const secretsOfConnection = () =>
  withTestSql(
    (sql) => sql<{ version: number; ciphertext: Buffer; handle: string }[]>`
      select s.version, s.ciphertext, s.handle from secrets s
      join config_assets a on a.id = s.connection_asset_id
      where a.name = ${NAME} order by s.version`
  );

/** Everything the instance keeps that a secret must never stand in. */
async function everythingStored(): Promise<string> {
  const rows = await withTestSql(async (sql) => ({
    revisions: await sql`select config from config_asset_revisions`,
    runs: await sql`select * from operation_runs`,
    audit: await sql`select * from audit_events`,
    jobs: await sql`select * from platform_jobs`,
    state: await sql`select * from connection_state`
  }));
  return JSON.stringify(rows);
}

describe("a Connection made on the instance", () => {
  it("is created, takes its key once, has its tools read and accepts one for agents", async () => {
    const w = world();
    const instance = await start(w);
    expect((await put(instance, definition(), null)).statusCode).toBe(200);
    // The scheme needs a key and none is stored: nothing is read from the system yet.
    expect((await storedState(instance, NAME)).state?.health).toBe("needs_configuration");
    expect((await discoveryJobs()).filter((job) => job.subject === NAME)).toEqual([]);

    const key = generateTestSecret();
    const entered = await setSecret(instance, key, null);
    expect(entered.statusCode).toBe(200);
    expect(entered.json()).toEqual({ state: "set", version: 1 });
    expect(entered.body).not.toContain(key);

    // The key asks for a discovery, which reads the tools with it.
    expect((await discoveryJobs()).map((job) => job.subject)).toContain(NAME);
    await runJobs(instance);
    expect(w.connector.handed).toContain(key);
    const tools = await discovered(instance);
    expect(tools.map((tool) => [tool.name, tool.proposedEffect])).toEqual([
      ["lookup", "reading"],
      ["list", "reading"]
    ]);
    expect((await detail(instance, NAME)).operations).toEqual([]);

    // Accepting is a write of the definition with the fingerprint that was shown.
    const lookup = required(tools.find((tool) => tool.name === "lookup"));
    const accepted = definition({
      operations: [
        {
          name: "lookup",
          effect: "reading",
          exposure: ["agent"],
          enabled: true,
          schemaFingerprint: lookup.fingerprint
        }
      ]
    });
    expect((await put(instance, accepted, 1)).statusCode).toBe(200);
    expect((await detail(instance, NAME)).operations).toMatchObject([
      { name: "lookup", status: "ready" }
    ]);
    expect((await discovered(instance)).map((tool) => tool.name)).toEqual(["list"]);
    const offered = await instance.call("connections.list_tools");
    expect(JSON.stringify(offered.json())).toContain(`connection.${NAME}.lookup`);

    // The key is in no answer, revision, run, audit row, job or state, and not in plain text
    // in its own row.
    const everything = await everythingStored();
    expect(everything).not.toContain(key);
    expect(everything).toContain("connections.set_secret");
    const rows = await secretsOfConnection();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ciphertext.toString("utf8")).not.toContain(key);
    const read = await instance.call("assets.get", {
      params: { kind: "connection", name: NAME }
    });
    expect(read.body).not.toContain(key);
  });

  it("takes a new key over the version it was read at and refuses one written over another", async () => {
    const instance = await start();
    await put(instance, definition(), null);
    await setSecret(instance, generateTestSecret(), null);
    expect((await setSecret(instance, generateTestSecret(), 1)).json()).toEqual({
      state: "set",
      version: 2
    });
    // A writer who read version 1 meets version 2: nothing is stored.
    const stale = await setSecret(instance, generateTestSecret(), 1);
    expect(stale.statusCode).toBe(409);
    expect(errorSchema.parse(stale.json()).error.details).toEqual({
      reason: "secret_write_conflict"
    });
    expect((await detail(instance, NAME)).operations).toEqual([]);
    expect((await secretsOfConnection()).map((row) => row.version)).toEqual([2]);
  });

  it("takes no key for a release Connection or for one that sends none", async () => {
    const instance = await start();
    // `outside` is the world's release Connection.
    const release = await instance.call("connections.set_secret", {
      params: { name: "outside" },
      payload: { value: generateTestSecret(), expectedVersion: 1 }
    });
    expect(release.statusCode).toBe(403);
    expect(errorSchema.parse(release.json()).error.details).toEqual({
      reason: "read_only_origin"
    });
    await put(instance, definition({ authScheme: "none" }), null);
    const none = await setSecret(instance, generateTestSecret(), null);
    expect(none.statusCode).toBe(409);
    expect(errorSchema.parse(none.json()).error.details).toEqual({
      reason: "connection_takes_no_secret"
    });
    const missing = await instance.call("connections.set_secret", {
      params: { name: "nowhere" },
      payload: { value: generateTestSecret(), expectedVersion: null }
    });
    expect(missing.statusCode).toBe(404);
  });

  it("makes a test stale and drops what another address listed when the address changes", async () => {
    const instance = await start();
    await put(instance, definition(), null);
    await setSecret(instance, generateTestSecret(), null);
    await runJobs(instance);
    expect((await storedState(instance, NAME)).catalog).toBeDefined();
    const tested = await instance.call("connections.test", { params: { name: NAME } });
    expect(tested.statusCode).toBe(200);
    expect((await storedState(instance, NAME)).state?.health).toBe("ok");

    // The same server under another path is another address: the catalog belongs to the old.
    await put(instance, definition({ settings: { url: `${URL}/v2` } }), 1);
    const changed = await storedState(instance, NAME);
    expect(changed.state?.health).toBe("unknown");
    expect(changed.catalog).toBeUndefined();
    expect((await discoveryJobs()).filter((job) => job.subject === NAME).length).toBeGreaterThan(1);
    // The origin is the one the key was entered for, so the key stays.
    expect(await secretsOfConnection()).toHaveLength(1);

    // Without a credential the stored key goes.
    await put(instance, definition({ authScheme: "none", settings: { url: `${URL}/v2` } }), 2);
    expect(await secretsOfConnection()).toEqual([]);
  });

  it("drops the key when the Connection goes to another origin: a writer never sends it elsewhere", async () => {
    const w = world();
    const elsewhere = "93.184.216.35";
    const instance = await w.start({
      egress: [
        { protocol: "https", host: OUTSIDE_HOST, port: 443 },
        { protocol: "https", host: elsewhere, port: 443 }
      ]
    });
    started.push(instance);
    await put(instance, definition(), null);
    const key = generateTestSecret();
    await setSecret(instance, key, null);
    await runJobs(instance);
    const handedBefore = w.connector.handed.length;

    await put(instance, definition({ settings: { url: `https://${elsewhere}/mcp` } }), 1);
    expect(await secretsOfConnection()).toEqual([]);
    expect((await storedState(instance, NAME)).state?.health).toBe("needs_configuration");
    await runJobs(instance);
    expect(w.connector.handed.slice(handedBefore)).not.toContain(key);
    // A key entered for the new origin is taken as the first one.
    expect((await setSecret(instance, generateTestSecret(), null)).statusCode).toBe(200);
  });

  it("keeps the handle the key is stored under when an earlier revision is restored", async () => {
    const instance = await start();
    await put(instance, definition(), null);
    await put(instance, definition({ authScheme: "none" }), 1);
    await put(instance, definition(), 2);
    await setSecret(instance, generateTestSecret(), null);
    const handleNow = (await secretsOfConnection())[0]?.handle;
    expect(handleNow).toBeDefined();

    const reverted = await instance.call("assets.revert", {
      params: { kind: "connection", name: NAME },
      payload: { revision: 1, expectedRevision: 3 }
    });
    expect(reverted.statusCode).toBe(200);
    const read = await instance.call("assets.get", { params: { kind: "connection", name: NAME } });
    expect(read.json()).toMatchObject({ config: { secretHandle: handleNow, origin: "runtime" } });
    const tested = await instance.call("connections.test", { params: { name: NAME } });
    expect(tested.statusCode).toBe(200);
    expect((await storedState(instance, NAME)).state?.health).toBe("ok");
  });

  it("refuses an address the egress list does not name, and asks for a discovery by hand", async () => {
    const instance = await start();
    const refused = await put(
      instance,
      definition({ settings: { url: "https://elsewhere.example.test/mcp" } }),
      null
    );
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.json())).toContain("egress_denied");
    expect(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: NAME
      })
    ).toBeUndefined();

    await put(instance, definition({ authScheme: "none" }), null);
    await runJobs(instance);
    const asked = await instance.call("connections.discover", { params: { name: NAME } });
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toEqual({ status: "queued" });
    expect(
      (await discoveryJobs()).filter((job) => job.subject === NAME && job.status === "queued")
    ).toHaveLength(1);
    const missing = await instance.call("connections.discover", { params: { name: "nowhere" } });
    expect(missing.statusCode).toBe(404);
  });

  it("goes with its key and its state when it is deleted", async () => {
    const instance = await start();
    await put(instance, definition(), null);
    await setSecret(instance, generateTestSecret(), null);
    const deleted = await instance.call("assets.delete", {
      params: { kind: "connection", name: NAME },
      payload: { expectedRevision: 1 }
    });
    expect(deleted.statusCode).toBe(200);
    expect(await secretsOfConnection()).toEqual([]);
    expect(
      await withTestSql(
        (sql) => sql`select 1 from connection_state s join config_assets a
          on a.id = s.connection_asset_id where a.name = ${NAME}`
      )
    ).toHaveLength(0);
  });
});

describe("the rights over a Connection made on the instance", () => {
  it("are connection.write to change it and enter its key: reading or using it is not enough", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", { origin: "runtime" });
    const crm = { params: { kind: "connection", name: "crm" } };
    const changed = {
      ...crm,
      payload: {
        config: connection("crm", {
          connectorType: "test",
          settings: { url: URL_OF_HOST },
          origin: "runtime",
          enabled: false
        })
      }
    };
    const key = { params: { name: "crm" }, payload: { value: "replaced", expectedVersion: 1 } };
    const discover = { params: { name: "crm" } };
    for (const action of ["connection.read", "connection.use"]) {
      const grantId = await t.grant(t.kai.id, action, { assetId });
      for (const [operation, input] of [
        ["assets.put", changed],
        ["connections.set_secret", key],
        ["connections.discover", discover]
      ] as const) {
        const refused = await t.call(t.kai.id, operation, input);
        expect(refused.statusCode, `${operation} with ${action}`).toBe(403);
        expect(JSON.stringify(refused.json())).toContain("connection.write");
        expect(refused.body).not.toContain("replaced");
      }
      const removed = await t.call(t.kai.id, "assets.delete", {
        ...crm,
        payload: { expectedRevision: 1 }
      });
      expect(removed.statusCode).toBe(403);
      await t.call(t.admin.id, "permissions.revoke", { params: { grantId } });
    }
    // The administrator holds them, and is told only the version of the key.
    await t.expectOk(t.admin.id, "assets.put", changed);
    const entered = await t.expectOk(t.admin.id, "connections.set_secret", key);
    expect(entered.json()).toEqual({ state: "set", version: 2 });
    await t.expectOk(t.admin.id, "connections.discover", discover);
    // Each run of a write of the key, refused or done, keeps a mark where the value was.
    const runs = await t.stores.operationRuns.list({ clientInstanceId });
    const written = runs.filter((run) => run.operation === "connections.set_secret");
    expect(written.map((run) => run.status).sort()).toEqual(["denied", "denied", "done"]);
    expect(JSON.stringify(written)).not.toContain("replaced");
  });

  it("refuses a key over a version another writer stored after it was read", async () => {
    const t = await fixture();
    const connectionAssetId = await t.seed("crm", { origin: "runtime" });
    const binding = { connectionAssetId, subject: SHARED_CREDENTIAL_SUBJECT };
    // The other writer: its own key, so its row is one the instance cannot open.
    const other = createSecretStore({
      clientInstanceId,
      keyring: await loadSecretKeyring({
        keys: [{ id: "other", ref: "OTHER_KEY" }],
        secrets: { resolve: () => Promise.resolve(generateSecretStoreKey()) }
      }),
      store: t.stores.connections
    });
    const find = t.stores.connections.findSecret.bind(t.stores.connections);
    let lands = true;
    vi.spyOn(t.stores.connections, "findSecret").mockImplementation(async (input) => {
      const found = await find(input);
      if (lands) {
        // Version 2 lands right after this writer read version 1.
        lands = false;
        await other.put({ binding, value: generateTestSecret(), source: "runtime" });
      }
      return found;
    });
    const refused = await t.call(t.admin.id, "connections.set_secret", {
      params: { name: "crm" },
      payload: { value: generateTestSecret(), expectedVersion: 1 }
    });
    expect(refused.statusCode).toBe(409);
    expect(errorSchema.parse(refused.json()).error.details).toEqual({
      reason: "secret_write_conflict"
    });
    expect(await find({ clientInstanceId, binding })).toMatchObject({ version: 2 });
  });

  it("are refused on a surface that is not allowed the target, before anything is stored", async () => {
    const t = await fixture();
    t.state.hostAllowed = false;
    const refused = await t.call(t.admin.id, "assets.put", {
      params: { kind: "connection", name: "crm" },
      payload: {
        config: connection("crm", { connectorType: "test", settings: { url: URL_OF_HOST } })
      }
    });
    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.json())).toContain("egress_denied");
    expect(t.sequence).not.toContain("check egress");
  });
});
