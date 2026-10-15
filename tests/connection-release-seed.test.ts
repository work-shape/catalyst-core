import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineClientInstance } from "@work-shape/catalyst-client-assembly";
import {
  connectionConfigSchema,
  parseClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import {
  createSecretStore,
  egressTargetOfUrl,
  loadSecretKeyring,
  openConnectorContext
} from "@work-shape/catalyst-connections";
import {
  SHARED_CREDENTIAL_SUBJECT,
  asClientInstanceId,
  connectionCallSentence,
  egressOriginOf,
  type JsonObject
} from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { connection } from "./support/connections";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig, setTestAgent } from "./support/fixtures";
import {
  captureProcessOutput,
  createTestConnector,
  dumpDatabaseText,
  findLeak,
  generateSecretStoreKey,
  generateTestSecret,
  type TestConnector
} from "./support/test-connector";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance, getTestExecution } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// The release seed on an assembled instance over real rows. Each test fails without the
// seed: before it no start wrote a Connection, a secret row or a state row.

const clientInstanceId = asClientInstanceId("demo-local");
const KEY_VARIABLE = "CATALYST_SECRET_STORE_KEY";
const TOKEN_VARIABLE = "OUTSIDE_API_TOKEN";
/** A literal public address, so the egress check of these tests asks no resolver. */
const OUTSIDE_HOST = "93.184.216.34";

type Entry = Record<string, unknown>;
const outside = (overrides: Entry = {}): Entry => ({
  connectorType: "test",
  displayName: "Outside",
  settings: { url: `https://${OUTSIDE_HOST}/mcp` },
  authScheme: "bearer",
  secret: TOKEN_VARIABLE,
  operations: [{ name: "echo", effect: "reading", exposure: ["agent"] }],
  ...overrides
});

const configWith = (connections: Record<string, Entry>, further: Entry = {}) =>
  parseClientInstanceConfig({
    ...createTestConfig({
      developmentAuth: {
        enabled: true,
        user: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "User",
          roles: ["user", "admin", "superadmin"]
        }
      }
    }),
    modules: { assetManagement: { enabled: true }, connections: { enabled: true } },
    administration: { agentConfiguration: { enabled: true, allowSkillEditing: true } },
    connections,
    secretStore: { keys: [{ id: "k1", ref: KEY_VARIABLE }] },
    egress: { allow: [{ protocol: "https", host: OUTSIDE_HOST, port: 443 }] },
    ...further
  });

interface Start {
  connections?: Record<string, Entry>;
  env?: Record<string, string>;
  connector?: TestConnector;
  further?: Entry;
}

function world() {
  const key = generateSecretStoreKey();
  const token = generateTestSecret();
  const connector = createTestConnector();
  const env = { [KEY_VARIABLE]: key, [TOKEN_VARIABLE]: token };
  const input = (start: Start = {}) => ({
    config: configWith(start.connections ?? { outside: outside() }, start.further),
    env: start.env ?? env,
    tools: [],
    connectorTypes: [(start.connector ?? connector).type]
  });
  return {
    key,
    token,
    connector,
    env,
    input,
    /** One start of the API process. */
    start: (start: Start = {}) => createTestInstance({ ...input(start), seedAssets: false })
  };
}

const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number(),
  config: z.record(z.string(), z.unknown())
});

const readAssets = () =>
  withTestSql(
    (sql) => sql<{ id: string; name: string; deleted: boolean }[]>`
      select id, name, status <> 'active' as deleted from config_assets
      where kind = 'connection' order by name`
  );
const readRevisions = (name: string) =>
  withTestSql(
    (sql) => sql<{ revision: number }[]>`
      select r.revision from config_asset_revisions r
      join config_assets a on a.id = r.asset_id
      where a.kind = 'connection' and a.name = ${name} order by r.revision`
  ).then((rows) => rows.map((row) => row.revision));
const readSecrets = () =>
  withTestSql(
    (sql) =>
      sql<
        { handle: string; connection_asset_id: string; version: number; source: string }[]
      >`select handle, connection_asset_id, version, source from secrets order by handle`
  );
const readStates = () =>
  withTestSql(
    (sql) => sql<{ connection_asset_id: string; health: string }[]>`
      select connection_asset_id, health from connection_state order by connection_asset_id`
  );

async function startupRefusal(work: Promise<unknown>): Promise<Error> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof Error)) throw new Error("Expected the start to stop");
  return error;
}

describe("the Connector types of a defined client instance", () => {
  // Fails without the change: `defineClientInstance` took no Connector types and handed none
  // on, so a client built with it could not start with a Connection in its release config.
  it("reach the app a client starts, which seeds a Connection of such a type", async () => {
    const w = world();
    const env = { ...w.env, DATABASE_URL: await fileTestDatabaseUrl() };
    const config = w.input().config;
    const root = await mkdtemp(join(tmpdir(), "catalyst-client-"));
    try {
      const client = defineClientInstance({
        rootDir: root,
        workspaceRoot: root,
        loadEnv: false,
        connectorTypes: [w.connector.type]
      });
      const app = await client.createApp({ config, env });
      await app.close();
      expect(await readAssets()).toMatchObject([{ name: "outside", deleted: false }]);

      // A client without the type does not start with that Connection.
      const without = defineClientInstance({ rootDir: root, workspaceRoot: root, loadEnv: false });
      const refused = await startupRefusal(without.createApp({ config, env }));
      expect(refused.message).toContain("test");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("an agent of an assembled instance", () => {
  // Fails without the Connections' tool source in what the agent tools are built with: the
  // model is then not offered the tool and a call of it finds nothing.
  it("calls the Connection operation it lists through the call path, as one Operation Run", async () => {
    const w = world();
    const tool = "connection.outside.echo";
    const { config, ...input } = w.input();
    setTestAgent(config, {
      name: "test_agent",
      displayName: "Test Agent",
      instructions: "Use configured tools only.",
      modelProviderId: "local",
      toolNames: [tool],
      initialPrompts: []
    });
    const instance = await createTestInstance({ ...input, config });

    const created = await instance.call("conversations.create", { payload: { title: "Call" } });
    const conversationId = created.json<{ id: string }>().id;
    const started = await injectStartConversationRun(
      instance,
      conversationId,
      `/tool ${tool} {"text":"hello"}`
    );
    const events = await drainRunEvents(instance, conversationId, started.run.id);

    // The test Connector type ran once, with the input and the credential of the Connection.
    expect(w.connector.calls).toHaveLength(1);
    expect(w.connector.calls[0]).toMatchObject({ operation: "echo", input: { text: "hello" } });
    expect(w.connector.calls[0]?.credential?.secret).toBe(w.token);
    expect(events).toContain("hello");
    const runs = (await instance.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.operation === tool
    );
    expect(runs).toMatchObject([
      {
        status: "done",
        actor: { id: expect.stringMatching(/^usr_/u) },
        origin: { kind: "agent", toolName: tool }
      }
    ]);
    // The credential is in no row and in nothing the run sent to the person.
    expect(findLeak(await dumpDatabaseText(), w.token)).toBeUndefined();
    expect(findLeak(events, w.token)).toBeUndefined();
  });
});

describe("a failed call of a Connection operation by an agent", () => {
  // Fails without the change: the model was handed "egress_denied: 93.184.216.35:443 is not
  // allowed by the instance's egress list", and the run kept the reason only inside that text.
  it("hands the model a sentence that names the Connection, and the run keeps the reason", async () => {
    const w = world();
    const tool = "connection.outside.echo";
    const unlisted = "93.184.216.35";
    const { config, ...input } = w.input({
      connections: {
        outside: outside({
          displayName: "Sample business",
          settings: { url: `https://${unlisted}/mcp` }
        })
      }
    });
    setTestAgent(config, {
      name: "test_agent",
      displayName: "Test Agent",
      instructions: "Use configured tools only.",
      modelProviderId: "local",
      toolNames: [tool],
      initialPrompts: []
    });
    const instance = await createTestInstance({ ...input, config });

    const created = await instance.call("conversations.create", { payload: { title: "Call" } });
    const conversationId = created.json<{ id: string }>().id;
    const started = await injectStartConversationRun(
      instance,
      conversationId,
      `/tool ${tool} {"text":"hello"}`
    );
    const events = await drainRunEvents(instance, conversationId, started.run.id);

    // The deterministic model repeats what it was handed as the result of the tool.
    const sentence = connectionCallSentence("egress_denied", "Sample business");
    expect(sentence).toContain("the connection Sample business");
    expect(events).toContain(sentence);
    expect(events).not.toContain(unlisted);
    // The code is not among what the model reads: it would repeat it to the person.
    expect(events).not.toContain("egress_denied");
    expect(w.connector.calls).toEqual([]);
    const runs = (await instance.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.operation === tool
    );
    expect(runs).toMatchObject([
      { status: "failed", error: { code: "FORBIDDEN", reason: "egress_denied", message: sentence } }
    ]);
    // The run answers the same over the API, to whoever reads runs.
    const read = await instance.call("operations.get_run", {
      params: { runId: required(runs[0]).id }
    });
    expect(read.json<JsonObject>()).toMatchObject({
      error: { code: "FORBIDDEN", reason: "egress_denied", message: sentence }
    });
    expect(findLeak(events, w.token)).toBeUndefined();
  });
});

describe("the release seed of Connections", () => {
  it("stores what release config defines: a read-only Connection, a handle and ciphertext", async () => {
    const w = world();
    const instance = await w.start();

    const listed = await instance.call("assets.get", {
      params: { kind: "connection", name: "outside" }
    });
    const asset = assetSchema.parse(listed.json());
    expect(asset.revision).toBe(1);
    expect(asset.config).toMatchObject({
      name: "outside",
      displayName: "Outside",
      connectorType: "test",
      ownerPrincipalId: "system",
      settings: { url: `https://${OUTSIDE_HOST}/mcp` },
      authScheme: "bearer",
      credentialMode: "shared",
      origin: "release",
      enabled: true,
      operations: [{ name: "echo", effect: "reading", exposure: ["agent"], enabled: true }]
    });
    // The revision holds the handle. The name of the variable stays in release config.
    const [secret] = await readSecrets();
    expect(required(secret)).toMatchObject({
      connection_asset_id: asset.id,
      version: 1,
      source: "bootstrap"
    });
    expect(asset.config.secretHandle).toBe(required(secret).handle);
    expect(JSON.stringify(asset.config)).not.toContain(TOKEN_VARIABLE);
    expect(await readStates()).toEqual([{ connection_asset_id: asset.id, health: "unknown" }]);
  });

  it("leaves the secret and the key in no table and no log line, after the seed and after a rotation", async () => {
    const w = world();
    const output = captureProcessOutput();
    let logs: string;
    const dumps: string[] = [];
    const rotated = generateTestSecret();
    try {
      const first = await w.start();
      dumps.push(await dumpDatabaseText());
      await first.close();
      await w.start({ env: { ...w.env, [TOKEN_VARIABLE]: rotated } });
      dumps.push(await dumpDatabaseText());
    } finally {
      logs = output.stop();
    }
    // The capture and the dump see what they should: the log line of the seed and the rows.
    expect(logs).toContain("Release Connections reconciled");
    expect(logs).toContain('"secretVersions":{"outside":2}');
    for (const dump of dumps) {
      expect(dump).toContain("secret_");
      expect(dump).toContain(`https://${OUTSIDE_HOST}/mcp`);
    }
    expect((await readSecrets()).map((row) => row.version)).toEqual([2]);
    for (const text of [...dumps, logs]) {
      for (const value of [w.token, rotated, w.key]) {
        expect(findLeak(text, value)).toBeUndefined();
      }
    }
  });

  it("writes one revision for two starts with the same config", async () => {
    const w = world();
    const first = await w.start();
    await first.close();
    const second = await w.start();
    expect(await readRevisions("outside")).toEqual([1]);
    expect((await readSecrets()).map((row) => row.version)).toEqual([1]);
    await second.close();
  });

  it("writes once when two API processes start at the same time", async () => {
    const w = world();
    const connections = { outside: outside(), second: outside({ displayName: "Second" }) };
    const started = await Promise.all(Array.from({ length: 4 }, () => w.start({ connections })));
    expect(started).toHaveLength(4);
    expect(await readRevisions("outside")).toEqual([1]);
    expect(await readRevisions("second")).toEqual([1]);
    expect(await readAssets()).toHaveLength(2);
    expect((await readSecrets()).map((row) => row.version)).toEqual([1, 1]);
    expect(await readStates()).toHaveLength(2);
  });

  it("makes a changed entry a new revision and keeps the handle and the secret version", async () => {
    const w = world();
    await (await w.start()).close();
    const [before] = await readSecrets();
    await w.start({ connections: { outside: outside({ displayName: "Outside system" }) } });
    expect(await readRevisions("outside")).toEqual([1, 2]);
    expect(await readSecrets()).toEqual([before]);
  });

  it("makes a changed environment value secret version 2 and no revision", async () => {
    const w = world();
    await (await w.start()).close();
    const [before] = await readSecrets();
    const next = generateTestSecret();
    const instance = await w.start({ env: { ...w.env, [TOKEN_VARIABLE]: next } });
    expect(await readRevisions("outside")).toEqual([1]);
    expect(await readSecrets()).toEqual([{ ...required(before), version: 2 }]);

    const execution = await createTestInstance({
      execution: w.input({ env: { ...w.env, [TOKEN_VARIABLE]: next } })
    });
    const connections = required(getTestExecution(execution).connections);
    const asset = required((await readAssets())[0]);
    expect(
      await required(connections.credentials).resolve({
        handle: required(before).handle,
        binding: { connectionAssetId: asset.id, subject: SHARED_CREDENTIAL_SUBJECT }
      })
    ).toBe(next);
    await instance.close();
  });

  it("removes the asset, its secret and its state when the entry is gone", async () => {
    const w = world();
    const first = await w.start({ connections: { outside: outside(), kept: outside() } });
    expect(await readSecrets()).toHaveLength(2);
    // A grant written on the Connection goes with it, as with every deleted asset.
    const removedId = required((await readAssets()).find((asset) => asset.name === "outside")).id;
    await first.call("assets.list", { params: { kind: "connection" } });
    // Another person than the caller: nobody writes a row of their own.
    const holder = z
      .object({ id: z.string() })
      .parse((await first.call("users.create", { payload: { displayLabel: "Holder" } })).json());
    const granted = await first.call("permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: holder.id,
        action: "connection.use",
        scopeKind: "asset",
        scopeId: removedId
      }
    });
    expect(granted.statusCode).toBe(200);
    const grantsOn = () =>
      withTestSql(
        (sql) => sql<{ action: string }[]>`
          select action from permission_grants where scope_id = ${removedId}`
      );
    expect(await grantsOn()).toHaveLength(1);
    await first.close();
    const instance = await w.start({ connections: { kept: outside() } });
    expect(await readAssets()).toMatchObject([
      { name: "kept", deleted: false },
      { name: "outside", deleted: true }
    ]);
    const kept = required((await readAssets())[0]);
    expect((await readSecrets()).map((row) => row.connection_asset_id)).toEqual([kept.id]);
    expect((await readStates()).map((row) => row.connection_asset_id)).toEqual([kept.id]);
    expect(await grantsOn()).toEqual([]);
    const listed = await instance.call("assets.list", { params: { kind: "connection" } });
    expect(
      z
        .object({ items: z.array(z.object({ name: z.string() })) })
        .parse(listed.json())
        .items.map((item) => item.name)
    ).toEqual(["kept"]);
  });

  it("leaves a Connection that was created on the instance alone, and refuses its name", async () => {
    const w = world();
    const first = await w.start();
    const runtime: JsonObject = connection("made-here", {
      connectorType: "test",
      origin: "runtime",
      secretHandle: undefined,
      authScheme: "none"
    });
    await applyAtCurrentRevisions(first.stores.configAssets, {
      clientInstanceId,
      mutations: [{ type: "upsert", kind: "connection", name: "made-here", config: runtime }]
    });
    await first.close();
    await (await w.start({ connections: {} })).close();
    expect(await readAssets()).toMatchObject([
      { name: "made-here", deleted: false },
      { name: "outside", deleted: true }
    ]);
    const clash = await startupRefusal(w.start({ connections: { "made-here": outside() } }));
    expect(clash.message).toContain("'made-here'");
    expect(await readRevisions("made-here")).toEqual([1]);
  });
});

describe("a seeded Connection is read-only on the instance", () => {
  const readOnly = { reason: "read_only_origin" };
  const errorSchema = z.object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional()
    })
  });

  it("answers read_only_origin to put, delete and revert, and stores nothing", async () => {
    const w = world();
    await (await w.start()).close();
    const instance = await w.start({
      connections: { outside: outside({ displayName: "Outside system" }) }
    });
    const address = { params: { kind: "connection", name: "outside" } };
    const stored = assetSchema.parse((await instance.call("assets.get", address)).json());
    const changed = { ...stored.config, enabled: false };
    const calls = {
      put: instance.call("assets.put", {
        ...address,
        payload: { config: changed, expectedRevision: 2 }
      }),
      same: instance.call("assets.put", {
        ...address,
        payload: { config: stored.config, expectedRevision: 2 }
      }),
      delete: instance.call("assets.delete", { ...address, payload: { expectedRevision: 2 } }),
      revert: instance.call("assets.revert", {
        ...address,
        payload: { revision: 1, expectedRevision: 2 }
      })
    };
    for (const [name, call] of Object.entries(calls)) {
      const response = await call;
      const body = errorSchema.parse(response.json());
      expect({ name, status: response.statusCode, ...body.error }).toMatchObject({
        name,
        status: 403,
        code: "FORBIDDEN",
        details: readOnly
      });
      expect(body.error.message).toMatch(/^read_only_origin: /u);
    }
    const validated = await instance.call("assets.validate", {
      params: { kind: "connection" },
      payload: { config: changed }
    });
    expect(JSON.stringify(validated.json())).toContain("read_only_origin");
    expect(await readRevisions("outside")).toEqual([1, 2]);
    expect(await readAssets()).toMatchObject([{ name: "outside", deleted: false }]);
  });

  it("takes a new Connection on the instance only where the egress list names its host", async () => {
    const w = world();
    const instance = await w.start();
    const create = (url: string) =>
      instance.call("assets.put", {
        params: { kind: "connection", name: "made-here" },
        payload: {
          config: connection("made-here", { connectorType: "test", settings: { url } }),
          expectedRevision: null
        }
      });
    // The list is asked by host and port, without a lookup of the name.
    const refused = errorSchema.parse((await create("https://outside.example.test/mcp")).json());
    expect(refused.error.details).toEqual({
      issues: [
        {
          message:
            "egress_denied: the address outside.example.test:443 is not on this instance's egress list. An operator adds it under 'egress.allow' in release config, or allows every public HTTPS host on port 443 with 'egress.allowPublicHttps: true'",
          path: ["settings"]
        }
      ]
    });
    expect(await readAssets()).toHaveLength(1);
    expect((await create(`https://${OUTSIDE_HOST}/mcp`)).statusCode).toBe(200);
    expect(await readAssets()).toMatchObject([
      { name: "made-here", deleted: false },
      { name: "outside", deleted: false }
    ]);
  });
});

describe("what stops a start, and what a missing or unreadable secret does", () => {
  it("stops with the name of the variable when the Secret Store key is not set", async () => {
    const w = world();
    const error = await startupRefusal(w.start({ env: { [TOKEN_VARIABLE]: w.token } }));
    expect(error.message).toContain(`'${KEY_VARIABLE}'`);
    expect(findLeak(error.message, w.token)).toBeUndefined();
    expect(await readAssets()).toEqual([]);

    const none = await startupRefusal(w.start({ further: { secretStore: { keys: [] } } }));
    expect(none.message).toContain("secretStore.keys");
  });

  it("starts without a key while release config names no Connection", async () => {
    const w = world();
    const instance = await w.start({ connections: {}, env: {}, further: { secretStore: {} } });
    expect(
      (await instance.call("assets.list", { params: { kind: "connection" } })).statusCode
    ).toBe(200);
  });

  it("stops on an entry the Connector type's schema refuses, and stores nothing of the config", async () => {
    const w = world();
    const cases: Array<[Entry, RegExp]> = [
      [
        outside({ connectorType: "absent" }),
        /connections\.outside\.connectorType: connector_type_unknown/u
      ],
      [
        outside({ settings: { url: `https://${OUTSIDE_HOST}/mcp`, note: "x" } }),
        /connections\.outside\.settings/u
      ],
      [outside({ settings: {} }), /connections\.outside\.settings/u],
      [outside({ authScheme: "oauth" }), /connections\.outside\.authScheme/u],
      [
        outside({ secret: undefined }),
        /connections\.outside\.secret: the auth scheme 'bearer' needs/u
      ],
      [
        outside({ authScheme: "none" }),
        /connections\.outside\.secret: the auth scheme 'none' takes no/u
      ]
    ];
    for (const [entry, expected] of cases) {
      const error = await startupRefusal(
        w.start({ connections: { kept: outside(), outside: entry } })
      );
      expect(error.message).toMatch(expected);
    }
    expect(await readAssets()).toEqual([]);

    // A value where only a reference may stand never gets as far as the seed, and the
    // refusal does not repeat it.
    const pasted = generateTestSecret();
    for (const entry of [
      outside({ secret: `Bearer ${pasted}` }),
      outside({ settings: { url: `https://${OUTSIDE_HOST}/mcp`, token: pasted } }),
      outside({ settings: { url: `https://user:${pasted}@${OUTSIDE_HOST}/mcp` } })
    ]) {
      let message = "";
      try {
        await w.start({ connections: { outside: entry } });
      } catch (error) {
        message = error instanceof Error ? `${error.message}${JSON.stringify(error)}` : "";
      }
      expect(message).not.toBe("");
      expect(findLeak(message, pasted)).toBeUndefined();
    }
    expect(await readAssets()).toEqual([]);
  });

  it("marks a Connection whose variable is not set needs_configuration and calls nothing", async () => {
    const w = world();
    const env = { [KEY_VARIABLE]: w.key };
    await (await w.start({ env })).close();
    const asset = required((await readAssets())[0]);
    expect(await readSecrets()).toEqual([]);
    expect(await readStates()).toEqual([
      { connection_asset_id: asset.id, health: "needs_configuration" }
    ]);
    expect(await call(w, env)).toMatchObject({ reason: "connection_not_configured" });
    expect(w.connector.calls).toEqual([]);

    // The value arrives: version 1, the same revision, and the state is open again.
    await (await w.start()).close();
    expect(await readRevisions("outside")).toEqual([1]);
    expect((await readSecrets()).map((row) => row.version)).toEqual([1]);
    expect((await readStates()).map((row) => row.health)).toEqual(["unknown"]);
    expect(await call(w, w.env)).toBeUndefined();
    expect(w.connector.calls).toHaveLength(1);
    expect(required(w.connector.calls[0]).credential?.headers.authorization).toBe(
      `Bearer ${w.token}`
    );

    // And goes again: the stored secret goes with it.
    await (await w.start({ env })).close();
    expect(await readSecrets()).toEqual([]);
    expect((await readStates()).map((row) => row.health)).toEqual(["needs_configuration"]);
  });

  it("marks a secret no configured key opens secret_unreadable and attempts no call", async () => {
    const w = world();
    await (await w.start()).close();
    // As a secret set on the instance later is: the environment does not write over it.
    await withTestSql((sql) => sql`update secrets set source = 'runtime'`);
    const otherKey = { ...w.env, [KEY_VARIABLE]: generateSecretStoreKey() };
    const output = captureProcessOutput();
    let logs: string;
    try {
      await (await w.start({ env: otherKey })).close();
    } finally {
      logs = output.stop();
    }
    expect((await readStates()).map((row) => row.health)).toEqual(["secret_unreadable"]);
    expect((await readSecrets()).map((row) => row.version)).toEqual([1]);
    expect(await call(w, otherKey)).toMatchObject({ reason: "secret_unreadable" });
    expect(w.connector.calls).toEqual([]);
    expect(findLeak(logs, w.token)).toBeUndefined();

    // With the key back the same row opens, and the state is open until a test says more.
    await (await w.start()).close();
    expect((await readStates()).map((row) => row.health)).toEqual(["unknown"]);
    expect(await call(w, w.env)).toBeUndefined();
    expect(w.connector.calls).toHaveLength(1);
  });

  it("leaves a secret that was replaced on the instance alone, also with the same value", async () => {
    // Fails without the source comparison: the replacement stayed bootstrap-owned and the
    // start below, whose variable is gone, deleted it.
    const w = world();
    const first = await w.start();
    const asset = required((await readAssets())[0]);
    const store = createSecretStore({
      clientInstanceId,
      keyring: await loadSecretKeyring({
        keys: [{ id: "k1", ref: KEY_VARIABLE }],
        secrets: { resolve: () => Promise.resolve(w.key) }
      }),
      store: first.stores.connections
    });
    await store.put({
      binding: { connectionAssetId: asset.id, subject: SHARED_CREDENTIAL_SUBJECT },
      value: w.token,
      source: "runtime",
      origin: egressOriginOf(egressTargetOfUrl(`https://${OUTSIDE_HOST}/mcp`))
    });
    await first.close();
    expect(await readSecrets()).toMatchObject([{ version: 2, source: "runtime" }]);

    await (await w.start({ env: { [KEY_VARIABLE]: w.key } })).close();
    await (await w.start({ env: { ...w.env, [TOKEN_VARIABLE]: generateTestSecret() } })).close();
    expect(await readSecrets()).toMatchObject([{ version: 2, source: "runtime" }]);
    expect((await readStates()).map((row) => row.health)).toEqual(["unknown"]);
    expect(await call(w, w.env)).toBeUndefined();
    expect(required(w.connector.calls[0]).credential?.secret).toBe(w.token);
  });

  it("re-seals a bootstrap secret under a new first key", async () => {
    const w = world();
    await (await w.start()).close();
    const newKey = generateSecretStoreKey();
    const further = {
      secretStore: {
        keys: [
          { id: "k2", ref: "CATALYST_SECRET_STORE_KEY_NEXT" },
          { id: "k1", ref: KEY_VARIABLE }
        ]
      }
    };
    const env = { ...w.env, CATALYST_SECRET_STORE_KEY_NEXT: newKey };
    await (await w.start({ env, further })).close();
    const rows = await withTestSql(
      (sql) => sql<{ key_id: string; version: number }[]>`select key_id, version from secrets`
    );
    expect(rows).toEqual([{ key_id: "k2", version: 2 }]);
    expect(await readRevisions("outside")).toEqual([1]);
  });
});

/**
 * One call of the stored Connection through the auth component of an assembled process, as
 * S3-38 will make it. Answers the details of the refusal, or nothing where `execute` ran.
 */
async function call(
  w: ReturnType<typeof world>,
  env: Record<string, string>
): Promise<Record<string, unknown> | undefined> {
  const instance = await createTestInstance({ execution: w.input({ env }) });
  try {
    const connections = required(getTestExecution(instance).connections);
    const stored = required(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: "outside"
      })
    );
    const context = await openConnectorContext({
      type: required(connections.connectorTypes.get("test")),
      connection: {
        id: stored.id,
        revision: stored.revision,
        config: connectionConfigSchema.parse(stored.config)
      },
      egress: connections.egress,
      credentials: required(connections.credentials),
      signal: new AbortController().signal
    });
    await w.connector.type.execute("echo", {}, context);
    return undefined;
  } catch (error) {
    if (typeof error === "object" && error !== null && "details" in error) {
      return z.record(z.string(), z.unknown()).parse(error.details);
    }
    throw error;
  } finally {
    await instance.close();
  }
}
