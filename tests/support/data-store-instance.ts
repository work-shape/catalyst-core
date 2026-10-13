import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterEach, expect } from "vitest";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  DATA_STORE_ASSET_KIND,
  DATA_STORE_MANIFEST_FILE,
  asClientInstanceId,
  type AuthenticatedUser,
  type DataStoreRecord,
  type JsonObject,
  type PolicyValue,
  type UserRole
} from "@vivd-catalyst/core";
import { eventually, required } from "./assertions";
import { createTestConfig } from "./fixtures";
import { fileTestDatabaseUrl } from "./test-database";
import {
  createTestInstance,
  getTestExecution,
  getTestJobs,
  type TestInstance
} from "./test-instance";

// A Data Store on an assembled instance, for the tests that reach it through the asset
// operations, the HTTP routes and the call path.

const KEY_VARIABLE = "DATA_STORE_TEST_KEY";
export const clientInstanceId = asClientInstanceId("demo-local");

const files = [
  {
    path: DATA_STORE_MANIFEST_FILE,
    text: "id: findings\nname: Findings\ndescription: What the monthly check of bookings found.\n"
  },
  {
    path: "migrations/0001_init.sql",
    text: `create table findings (
      run_id text not null,
      client_id text not null,
      rule_id text not null,
      revision integer not null,
      severity text not null,
      amount numeric(14, 2),
      details jsonb not null default '{}'::jsonb
    );`
  }
];
export const finding: JsonObject = {
  run_id: "run-1",
  client_id: "client-secret-7",
  rule_id: "vat-rate",
  revision: 3,
  severity: "warning",
  amount: 119.5,
  details: { booking: 7 }
};

/** One instance of a test: its API process, its rows and its call path. */
export interface DataStoreInstance {
  api: TestInstance;
  stores: TestInstance["stores"];
  execution: ReturnType<typeof getTestExecution>;
}

type StoreFiles = readonly { path: string; text: string }[];
type Answer = ReturnType<TestInstance["call"]>;

/**
 * Call it in the `describe` that holds the tests. After each test it closes the instances the
 * test started and removes every database and role a store of the test made.
 */
export function useDataStoreInstance(): {
  start(
    dataStores: boolean,
    changing?: PolicyValue,
    /** Who may sign in, where a test needs more than the administrator. */
    developmentAuth?: unknown,
    /**
     * The module `knowledge` on beside the Data Stores, with agents that may be created and
     * given Knowledge Bases.
     */
    knowledge?: boolean
  ): Promise<DataStoreInstance>;
  /** Closes the processes of every instance the test started. */
  close(): Promise<unknown>;
  put(world: DataStoreInstance, storeFiles?: StoreFiles, expectedRevision?: number | null): Answer;
  publish(world: DataStoreInstance, revision: number): Answer;
  publishStore(world: DataStoreInstance): Promise<DataStoreRecord>;
  recordOf(world: DataStoreInstance): Promise<DataStoreRecord>;
  settle(world: DataStoreInstance, level: number): Promise<DataStoreRecord>;
  person(world: DataStoreInstance, name: string, roles: UserRole[]): Promise<AuthenticatedUser>;
} {
  const roots: string[] = [];
  const started: TestInstance[] = [];

  const close = () => Promise.all(started.splice(0).map((instance) => instance.close()));

  afterEach(async () => {
    // Databases and roles are the cluster's, which other suites share: every one a test made
    // is removed by name, once the instance that reaches them is closed.
    await close();
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      const records = await sql<
        { database_name: string; app_role: string; migration_role: string }[]
      >`select database_name, app_role, migration_role from data_stores`;
      for (const record of records) {
        // The role of a Knowledge Base on the store is found by what it may connect to.
        const readers = await sql<{ name: string }[]>`
          select rolname as name from pg_roles
          where rolname like 'catalyst_kb_%'
            and has_database_privilege(oid, ${record.database_name}, 'CONNECT')`;
        await sql.unsafe(`drop database if exists "${record.database_name}" with (force)`);
        await sql.unsafe(`drop role if exists "${record.app_role}"`);
        await sql.unsafe(`drop role if exists "${record.migration_role}"`);
        for (const reader of readers) await sql.unsafe(`drop role if exists "${reader.name}"`);
      }
    } finally {
      await sql.end();
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  /**
   * One instance as its two processes see it: the API, which serves the asset operations and
   * the jobs, and the call path as an agent worker or a Workflow step reaches it. Both are
   * assembled on the same database. `changing` is what the instance asks of a changing call
   * on that call path where nothing else names a value; the API keeps the default, so the
   * store of the test is written and published whatever the test asks about.
   */
  async function start(
    dataStores: boolean,
    changing?: PolicyValue,
    developmentAuth?: unknown,
    knowledge = false
  ): Promise<DataStoreInstance> {
    const root = await mkdtemp(join(tmpdir(), "data-store-test-"));
    roots.push(root);
    const base = createTestConfig(developmentAuth === undefined ? {} : { developmentAuth });
    const settings = {
      ...base,
      modules: {
        assetManagement: { enabled: true },
        dataStores: { enabled: dataStores },
        ...(knowledge ? { knowledge: { enabled: true } } : {})
      },
      ...(knowledge
        ? {
            administration: {
              agentConfiguration: {
                enabled: true,
                editableAgentFields: [
                  "displayName",
                  "instructions",
                  "toolNames",
                  "skillNames",
                  "knowledgeBases",
                  "initialPrompts"
                ],
                allowAgentCreation: true
              }
            }
          }
        : {}),
      secretStore: { keys: [{ id: "k1", ref: KEY_VARIABLE }] },
      infrastructure: {
        ...base.infrastructure,
        objectStorage: {
          ...base.infrastructure.objectStorage,
          files: { provider: "filesystem", root }
        }
      }
    };
    const env = { [KEY_VARIABLE]: randomBytes(32).toString("base64") };
    const api = await createTestInstance({
      config: parseClientInstanceConfig(settings),
      env,
      tools: []
    });
    started.push(api);
    const calls = await createTestInstance({
      execution: {
        config: parseClientInstanceConfig({
          ...settings,
          ...(changing ? { policy: { defaults: { reading: "allow", changing } } } : {})
        }),
        env,
        tools: []
      }
    });
    started.push(calls);
    return { api, stores: api.stores, execution: getTestExecution(calls) };
  }

  const put = (
    { api }: DataStoreInstance,
    storeFiles = files,
    expectedRevision: number | null = null
  ) =>
    api.call("assets.put", {
      params: { kind: DATA_STORE_ASSET_KIND, name: "findings" },
      payload: { files: storeFiles, expectedRevision }
    });

  const publish = ({ api }: DataStoreInstance, revision: number) =>
    api.call("assets.publish", {
      params: { kind: DATA_STORE_ASSET_KIND, name: "findings" },
      payload: { revision }
    });

  /** Writes the folder as revision 1 and publishes it. A refusal fails the test where it happens. */
  async function publishStore(world: DataStoreInstance): Promise<DataStoreRecord> {
    expect((await put(world)).statusCode).toBe(200);
    expect((await publish(world, 1)).statusCode).toBe(200);
    return settle(world, 1);
  }

  async function recordOf({ stores }: DataStoreInstance): Promise<DataStoreRecord> {
    return required(
      await stores.dataStores.findDataStoreByName({ clientInstanceId, name: "findings" })
    );
  }

  /** Runs the jobs of the API process until the store is at the level. */
  function settle(world: DataStoreInstance, level: number): Promise<DataStoreRecord> {
    const jobs = getTestJobs(world.api);
    return eventually(async () => {
      await jobs.runDue();
      const record = await recordOf(world);
      expect(record).toMatchObject({ status: "ready", level });
      return record;
    });
  }

  async function person({ stores }: DataStoreInstance, name: string, roles: UserRole[]) {
    const user: AuthenticatedUser = await stores.users.resolveUserIdentity({
      clientInstanceId,
      authSource: "test",
      externalUserId: name,
      displayLabel: name,
      roles,
      permissionRefs: [],
      permissions: [],
      correlationId: "test"
    });
    return user;
  }

  return { start, close, put, publish, publishStore, recordOf, settle, person };
}
