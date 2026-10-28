import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, afterEach, expect } from "vitest";
import {
  PLATFORM_TOOL_NAMES,
  type ClientInstanceCapability
} from "@work-shape/catalyst-client-assembly";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  DATA_STORE_ASSET_KIND,
  DATA_STORE_MANIFEST_FILE,
  defineModule,
  asClientInstanceId,
  type AuthenticatedUser,
  type DataStoreRecord,
  type JsonObject,
  type PolicyValue,
  type UserRole
} from "@work-shape/catalyst-core";
import { eventually, required } from "./assertions";
import { createTestConfig, setTestAgent } from "./fixtures";
import { fileTestDatabaseUrl, resetFileTestDatabase } from "./test-database";
import {
  createTestInstance,
  getTestExecution,
  getTestJobs,
  type TestInstance
} from "./test-instance";

// A Data Store on an assembled instance, for the tests that reach it through the asset
// operations, the HTTP routes and the call path.

const KEY_VARIABLE = "DATA_STORE_TEST_KEY";
const EMBEDDING_KEY_VARIABLE = "EMBEDDING_TEST_KEY";

/** The model of the embedding binding on the OpenAI-compatible provider of a test. */
export const TEST_EMBEDDING_MODEL = "text-embedding-test";
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

interface AgentOptions {
  capability?: ClientInstanceCapability;
  provider?: string;
  locale?: "en" | "de";
}

/** One instance of a test: its API process, its rows and its call path. */
export interface DataStoreInstance {
  api: TestInstance;
  stores: TestInstance["stores"];
  execution: ReturnType<typeof getTestExecution>;
  /** The directory of the instance's store of files (`infrastructure.objectStorage.files`). */
  filesRoot: string;
  /** A test may publish its own store on a suite instance. */
  storeName?: string;
}

type StoreFiles = readonly { path: string; text: string }[];

interface KnowledgeOptions {
  /** Also register the live Connection seam for cross-resource availability tests. */
  connections?: true;
  defaultLocale?: "de" | "en";
  apiAccess?: true;
  knowledgeWorker?: "in_process" | "separate";
  embedding?: true;
  /**
   * With `embedding`: the binding is on an OpenAI-compatible provider in region `eu` at this
   * base URL instead of the deterministic adapter, at 8 dimensions with the model
   * `TEST_EMBEDDING_MODEL`. The test answers its `/embeddings` by stubbing `fetch`.
   */
  embeddingBaseUrl?: string;
  /**
   * With `embeddingBaseUrl`: more embedding bindings on the same provider, each behind its own
   * model and dimensions, which a Knowledge Base may name in `indexing.embedding.binding`.
   */
  extraEmbeddingBindings?: readonly { id: string; model: string; dimensions: number }[];
  /** `usage.safeguards` of release config. */
  usageSafeguards?: { modelCallsPerDay?: number };
  attachments?: ClientInstanceCapability;
  /** `knowledge.maxDocuments` of release config. */
  maxDocuments?: number;
  /** `knowledge.maxPagesPerDocument` of release config, shared by API and execution assembly. */
  maxPagesPerDocument?: number;
  /**
   * The module `documents` on, shipped by a test capability with no code of its own: the API
   * process then takes PDF and DOCX, whose extraction a test serves with a worker of its own.
   */
  documents?: true;
}

/** Ships the module `documents` and nothing else. */
const documentsModuleCapability: ClientInstanceCapability = {
  name: "documents-module-test",
  modules: [defineModule({ name: "documents" })],
  create: () => ({})
};
type Answer = ReturnType<TestInstance["call"]>;

/**
 * Call it in the `describe` that holds the tests. It closes the instances and removes the
 * databases and roles after each test, or at suite teardown when `scope` is `suite`.
 */
export function useDataStoreInstance(
  options: { scope?: "test" | "suite"; resetStateOnCleanup?: true } = {}
): {
  start(
    dataStores: boolean,
    changing?: PolicyValue,
    /** Who may sign in, where a test needs more than the administrator. */
    developmentAuth?: unknown,
    /** The guardrails of release config of both processes, as `guardrails` holds them. */
    guardrails?: Record<string, unknown>,
    /**
     * The module `knowledge` on beside the Data Stores, with agents that may be created and
     * given Knowledge Bases. `embedding` also approves an embedding model on the instance, so
     * a Knowledge Base may search by meaning. `attachments` is a capability the API process
     * stores the files of Conversations with.
     */
    knowledge?: boolean | KnowledgeOptions,
    workflows?: true,
    /** A platform-tool agent, `platform-agent`, as `startWithAgent` starts one. */
    agent?: AgentOptions
  ): Promise<DataStoreInstance>;
  /** A platform-tool agent on the same isolated store fixture. */
  startWithAgent(agent?: AgentOptions): Promise<DataStoreInstance>;
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

  const cleanup = options.scope === "suite" ? afterAll : afterEach;
  cleanup(async () => {
    // Another fixture in this file may own stores even when this one was never started.
    if (roots.length === 0) return;

    // Databases and roles are the cluster's, which other suites share: every one a test made
    // is removed by name, once the instance that reaches them is closed.
    await close();
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      const records = await sql<
        { database_name: string; app_role: string; migration_role: string }[]
      >`select database_name, app_role, migration_role from data_stores`;
      for (const record of records) {
        // The role of a Knowledge Base on the store is found by what it may connect to. A store
        // whose provisioning job never ran has a record and no database: by name,
        // `has_database_privilege` would fail on it as soon as any `catalyst_kb_` role exists
        // on the shared server, and the file's tables would not be reset.
        const readers = await sql<{ name: string }[]>`
          select r.rolname as name from pg_roles r
          join pg_database d on d.datname = ${record.database_name}
          where r.rolname like 'catalyst_kb_%'
            and has_database_privilege(r.oid, d.oid, 'CONNECT')`;
        await sql.unsafe(`drop database if exists "${record.database_name}" with (force)`);
        await sql.unsafe(`drop role if exists "${record.app_role}"`);
        await sql.unsafe(`drop role if exists "${record.migration_role}"`);
        for (const reader of readers) await sql.unsafe(`drop role if exists "${reader.name}"`);
      }
    } finally {
      await sql.end();
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    // Mixed files retain their suite fixture globally. Their per-test fixtures explicitly
    // remove state after closing, including when a shuffled suite ran before them.
    if (options.resetStateOnCleanup) await resetFileTestDatabase();
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
    guardrails?: Record<string, unknown>,
    knowledge: boolean | KnowledgeOptions = false,
    workflows?: true,
    agent?: AgentOptions
  ): Promise<DataStoreInstance> {
    const root = await mkdtemp(join(tmpdir(), "data-store-test-"));
    roots.push(root);
    const options = {
      ...(typeof knowledge === "object" ? knowledge : {}),
      ...(agent?.locale ? { defaultLocale: agent.locale } : {})
    };
    const base = createTestConfig({
      ...(agent ? { toolNames: [...PLATFORM_TOOL_NAMES] } : {}),
      ...(developmentAuth === undefined ? {} : { developmentAuth }),
      ...(options.embeddingBaseUrl === undefined
        ? {}
        : {
            modelProviders: [
              { id: "local", type: "deterministic", model: "local" },
              {
                id: "azure-eu",
                type: "openai-compatible",
                model: TEST_EMBEDDING_MODEL,
                baseUrl: options.embeddingBaseUrl,
                credentialSecret: EMBEDDING_KEY_VARIABLE,
                region: "eu"
              }
            ]
          }),
      ...(options.usageSafeguards ? { usageSafeguards: options.usageSafeguards } : {})
    });
    const settings = {
      ...base,
      ...(options.defaultLocale
        ? { localization: { defaultLocale: options.defaultLocale, supportedLocales: ["en", "de"] } }
        : {}),
      modules: {
        assetManagement: { enabled: true },
        ...(typeof knowledge === "object" && knowledge.connections
          ? { connections: { enabled: true } }
          : {}),
        dataStores: { enabled: dataStores },
        ...(workflows ? { workflows: { enabled: true } } : {}),
        ...(options.apiAccess ? { personalApiKeys: { enabled: true } } : {}),
        ...(knowledge ? { knowledge: { enabled: true } } : {}),
        ...(typeof knowledge === "object" && knowledge.documents
          ? { documents: { enabled: true } }
          : {})
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
      ...(typeof knowledge === "object" && knowledge.embedding
        ? {
            // The deterministic adapter, which keeps every text inside the instance.
            modelBindings: [
              {
                id: "embedding",
                providerId: knowledge.embeddingBaseUrl === undefined ? "local" : "azure-eu",
                kind: "embedding",
                dimensions: 8
              },
              ...(knowledge.extraEmbeddingBindings ?? []).map((binding) => ({
                ...binding,
                providerId: "azure-eu",
                kind: "embedding"
              }))
            ]
          }
        : {}),
      ...(typeof knowledge === "object"
        ? {
            knowledge: {
              ...(knowledge.embedding ? { defaultEmbeddingBinding: "embedding" } : {}),
              ...(knowledge.maxDocuments === undefined
                ? {}
                : { maxDocuments: knowledge.maxDocuments }),
              ...(knowledge.maxPagesPerDocument === undefined
                ? {}
                : { maxPagesPerDocument: knowledge.maxPagesPerDocument })
            }
          }
        : {}),
      secretStore: { keys: [{ id: "k1", ref: KEY_VARIABLE }] },
      infrastructure: {
        ...base.infrastructure,
        ...(agent?.provider
          ? { models: { local: { provider: agent.provider, model: "local" } } }
          : {}),
        objectStorage: {
          ...base.infrastructure.objectStorage,
          files: { provider: "filesystem", root }
        }
      }
    };
    const env = {
      ...(options.apiAccess
        ? { SERVICE_ACCESS_TOKEN_SECRET: randomBytes(32).toString("base64") }
        : {}),
      [KEY_VARIABLE]: randomBytes(32).toString("base64"),
      [EMBEDDING_KEY_VARIABLE]: "embedding-test-key"
    };
    const capabilities = [
      ...(agent?.capability ? [agent.capability] : []),
      ...(typeof knowledge === "object" && knowledge.attachments ? [knowledge.attachments] : []),
      ...(typeof knowledge === "object" && knowledge.documents ? [documentsModuleCapability] : [])
    ];
    const apiConfig = parseClientInstanceConfig({
      ...settings,
      ...(guardrails ? { guardrails } : {})
    });
    if (agent)
      setTestAgent(apiConfig, {
        name: "platform-agent",
        displayName: "Platform agent",
        instructions: "Use configured tools only.",
        modelProviderId: "local",
        toolNames: [...PLATFORM_TOOL_NAMES],
        skillNames: [],
        initialPrompts: []
      });
    const api = await createTestInstance({
      config: apiConfig,
      env,
      tools: [],
      knowledgeWorker: options.knowledgeWorker,
      capabilities
    });
    started.push(api);
    const calls = await createTestInstance({
      execution: {
        config: parseClientInstanceConfig({
          ...settings,
          ...(changing ? { policy: { defaults: { reading: "allow", changing } } } : {}),
          ...(guardrails ? { guardrails } : {})
        }),
        env,
        tools: [],
        capabilities: [
          ...(agent?.capability ? [agent.capability] : []),
          ...(typeof knowledge === "object" && knowledge.attachments
            ? [knowledge.attachments]
            : []),
          ...(typeof knowledge === "object" && knowledge.documents
            ? [documentsModuleCapability]
            : [])
        ]
      }
    });
    started.push(calls);
    return { api, stores: api.stores, execution: getTestExecution(calls), filesRoot: root };
  }

  const put = (
    { api, storeName = "findings" }: DataStoreInstance,
    storeFiles = files,
    expectedRevision: number | null = null
  ) =>
    api.call("assets.put", {
      params: { kind: DATA_STORE_ASSET_KIND, name: storeName },
      payload: {
        files: storeFiles.map((file) =>
          file.path === DATA_STORE_MANIFEST_FILE
            ? { ...file, text: file.text.replace(/^id: findings$/m, `id: ${storeName}`) }
            : file
        ),
        expectedRevision
      }
    });

  const publish = ({ api, storeName = "findings" }: DataStoreInstance, revision: number) =>
    api.call("assets.publish", {
      params: { kind: DATA_STORE_ASSET_KIND, name: storeName },
      payload: { revision }
    });

  /** Writes the folder as revision 1 and publishes it. A refusal fails the test where it happens. */
  async function publishStore(world: DataStoreInstance): Promise<DataStoreRecord> {
    expect((await put(world)).statusCode).toBe(200);
    expect((await publish(world, 1)).statusCode).toBe(200);
    return settle(world, 1);
  }

  async function recordOf({
    stores,
    storeName = "findings"
  }: DataStoreInstance): Promise<DataStoreRecord> {
    return required(
      await stores.dataStores.findDataStoreByName({ clientInstanceId, name: storeName })
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

  return {
    start,
    startWithAgent: (agent = {}) =>
      start(true, undefined, undefined, undefined, false, undefined, agent),
    close,
    put,
    publish,
    publishStore,
    recordOf,
    settle,
    person
  };
}
