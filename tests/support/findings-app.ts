import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { expect } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { WorkflowAssetKind } from "@work-shape/catalyst-server";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { loadSecretKeyring } from "@work-shape/catalyst-connections";
import {
  DATA_STORE_ASSET_KIND,
  type CollaborationWorkspaceId,
  type DataStoreRecord,
  type JsonObject,
  type Logger,
  type ModuleSnapshot
} from "@work-shape/catalyst-core";
import { createDataStores, type DataStores } from "@work-shape/catalyst-data-stores";
import { createPostgresJobWorker } from "@work-shape/catalyst-postgres-store";
import { clientInstanceId } from "./access-instance";
import {
  action,
  setupAppActions,
  type AppActionsInstance,
  type AppActionsOptions
} from "./app-actions";
import { expectStatus, type AppFile } from "./app-instance";
import { eventually, required } from "./assertions";
import { finding, init, manifest, type StoreFile } from "./data-store-world";
import { fileTestDatabaseUrl } from "./test-database";
import { createTestInstance } from "./test-instance";

// An App that reads a Data Store, on real rows and a real database of the store: the Data
// Store `findings` with its one migration, published as the asset workflow publishes one, and
// the App `findings` whose statements list its rows and add one. What an assembled instance
// wires between the two is wired here: the operations of the stores in the call path, the
// kind `data_store` among the kinds an App's manifest is checked against, and the route that
// says where an App's data comes from.

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

/** The findings of one client, by severity, a page at a time. */
const LIST_FINDINGS_SQL = `-- The findings of the monthly check, in the order they were found.
-- @param client text optional
-- @param severity text optional
-- @param limit integer
-- @param offset integer
select client_id, rule_id, revision, severity, amount, details
from findings
where ($client is null or client_id = $client)
  and ($severity is null or severity = $severity)
order by id
limit $limit offset $offset
`;

/** One finding, as the person who looks at the App records it. */
const ADD_FINDING_SQL = `-- @param run text
-- @param client text
-- @param rule text
-- @param revision integer
-- @param severity text
-- @param amount number optional
insert into findings (run_id, client_id, rule_id, revision, severity, amount)
values ($run, $client, $rule, $revision, $severity, $amount)
`;

/** The id of an App whose build drops `dataStores` from the manifest it answers. */
export const UNLISTED_STORE_APP = "findings-unlisted";

/** What the files of the App `findings` are made of. A test changes one part of it. */
interface FindingsAppParts {
  marker: string;
  id?: string;
  store?: string;
  minSchema?: number;
  /** Reading statement files by action name, beside `list_findings`. */
  statements?: Record<string, string>;
}

/** The App: one statement that lists findings, and one action on a Connection beside it. */
export function findingsApp(parts: FindingsAppParts): AppFile[] {
  const reading = { list_findings: LIST_FINDINGS_SQL, ...parts.statements };
  const statements = { ...reading, add_finding: ADD_FINDING_SQL };
  return [
    {
      path: "app.yaml",
      text: JSON.stringify({
        id: parts.id ?? "findings",
        name: "Findings",
        kit: "1.1.0",
        entry: "index.html",
        connections: ["crm"],
        dataStores: [{ name: parts.store ?? "findings", minSchema: parts.minSchema ?? 1 }],
        actions: Object.keys(statements).map((name) => ({
          name,
          file: `actions/${name}.sql`,
          effect: name in reading ? "reading" : "changing"
        }))
      })
    },
    { path: "index.html", text: `<!doctype html><title>Findings</title><p>${parts.marker}</p>` },
    ...Object.entries(statements).map(([name, text]) => ({ path: `actions/${name}.sql`, text })),
    {
      path: "actions/load.action.yaml",
      text: action([
        "connection: crm",
        "operation: echo",
        "effect: reading",
        "input:",
        "  schema: { type: object, properties: { text: { type: string } }, required: [text] }",
        '  mapping: { text: "{{text}}" }'
      ])
    }
  ];
}

/**
 * The kind `data_store` as the asset workflow registers it, which is what the assembly makes
 * of the package's kind. An App's manifest is checked against the stores this kind reads.
 */
function dataStoreKind(dataStores: DataStores): WorkflowAssetKind {
  return {
    ...dataStores.assetKind,
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ next }) => next,
    missingUpsertRight: () => undefined,
    assertInteractiveUpsertAllowed: () => undefined,
    assertInteractiveDeleteAllowed: () => undefined,
    manifestOfFiles: (files) => dataStores.readFiles(files),
    configOfFiles: ({ manifest }) => manifest,
    onPublish: ({ stores, assetId, revision, config }) =>
      dataStores.publish(stores, { assetId, revision, config }),
    onRemove: ({ stores, assetId }) => dataStores.retire(stores, assetId)
  };
}

export interface FindingsWorld extends AppActionsInstance {
  /** The published store `findings` of the App's workspace, with its database. */
  store: DataStoreRecord;
  /** The ceilings of a statement on a store. A test lowers one and restores it. */
  statementLimits: { statementTimeoutMs?: number; maxRows?: number; maxBytes?: number };
  /**
   * Writes a store's draft from files, as a save does, and publishes nothing. Answers the
   * revision it was written as.
   */
  draftStore(
    name: string,
    files: StoreFile[],
    workspaceId?: CollaborationWorkspaceId
  ): Promise<number>;
  /** Publishes a store from files and waits for its database. Answers its record. */
  publishStore(
    name: string,
    files: StoreFile[],
    workspaceId?: CollaborationWorkspaceId
  ): Promise<DataStoreRecord>;
  /** Removes only a definition to simulate a missing legacy dependency outside asset guards. */
  removeStoreDefinition(name: string): Promise<void>;
  /** Adds rows to `findings` as the platform's own role. */
  addFindings(rows: JsonObject[]): Promise<void>;
  /** Every row of `findings`, as the platform's own role reads them. */
  findingRows(): Promise<JsonObject[]>;
  /** Sets the size limit the platform holds a store to, in bytes. */
  setSizeLimit(storeId: string, bytes: number): Promise<void>;
  /** Turns the module `dataStores` off or on for the calls of a frame. */
  setDataStoresModule(enabled: boolean): void;
  dataStores: DataStores;
  closeAll(): Promise<void>;
}

/**
 * The instance of `setupAppActions` with Data Stores on, the store `findings` holding four
 * rows, and the App `findings` published at revision 1 with a draft at revision 2.
 */
export async function setupFindingsApp(
  options: Pick<AppActionsOptions, "explicitCredentials" | "events"> = {}
): Promise<FindingsWorld> {
  const databaseUrl = await fileTestDatabaseUrl();
  // The stores before the instance: the kind `data_store` is registered when it is set up.
  const own = await createTestInstance({ postgres: { applicationName: "findings_app_stores" } });
  const key = randomBytes(32).toString("base64");
  const statementLimits: FindingsWorld["statementLimits"] = {};
  const dataStores = createDataStores({
    defaultLocale: "en",
    clientInstanceId,
    stores: own.stores,
    databaseUrl,
    keyring: await loadSecretKeyring({
      keys: [{ id: "k1", ref: "FINDINGS_APP_TEST_KEY" }],
      secrets: { resolve: () => Promise.resolve(key) }
    }),
    limits: { sizeLimitBytes: 5 * 1024 ** 3, poolMaxConnections: 5, statement: statementLimits },
    scopes: { mandant: { label: "Mandant", valueType: "text" } },
    logger: silent
  });
  let dataStoresOn = true;
  const t = await setupAppActions({
    modules: { dataStores: { enabled: true } },
    // The CLI signs in with an API key, as on an instance.
    ...options,
    furtherKinds: [dataStoreKind(dataStores)],
    // A build that answers a manifest whose actions reach a store it does not list.
    tamper(built) {
      if (built.status !== "built" || built.manifest.id !== UNLISTED_STORE_APP) return built;
      const { dataStores: _dropped, ...manifest } = built.manifest;
      return { ...built, manifest };
    },
    // As the assembly registers it: the right is asked of the App, inside the read.
    register: (routes) =>
      routes.operation(apiOperations["data_stores.app_sources"], {
        authorize: () => ({ allowed: true }),
        module: "dataStores",
        execute: (input, { access }) => dataStores.appSources(access, input.app, input.revision)
      }),
    server(_stores, config) {
      const { snapshot } = resolveInstanceModules(config, []);
      const modules: ModuleSnapshot = {
        ...snapshot,
        isEnabled: (name) => (name === "dataStores" ? dataStoresOn : snapshot.isEnabled(name))
      };
      return { modules };
    }
  });
  t.operationCalls.registry.addSource(dataStores.operationSource);
  const worker = createPostgresJobWorker({
    stores: t.stores,
    clientInstanceId,
    logger: silent,
    handlers: [...dataStores.jobHandlers]
  });
  worker.start();

  const connections: postgres.Sql[] = [];
  const connect = (record: DataStoreRecord) => {
    const url = new URL(databaseUrl);
    url.pathname = `/${record.location.database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    connections.push(sql);
    return sql;
  };

  const storeConfig = (files: StoreFile[]) =>
    dataStores.readFiles(
      files.map((file) => ({ path: file.path, bytes: new TextEncoder().encode(file.text) }))
    );
  const writeStoreDraft = async (
    name: string,
    config: ReturnType<typeof storeConfig>,
    workspaceId: CollaborationWorkspaceId | undefined
  ) => {
    const assetKey = `${DATA_STORE_ASSET_KIND}:${name}`;
    const current = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name
    });
    const written = await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [assetKey]: current?.revision ?? null },
      mutations: [
        {
          type: "upsert",
          kind: DATA_STORE_ASSET_KIND,
          name,
          config,
          draft: true,
          ...(workspaceId === undefined ? {} : { scope: { kind: "workspace", workspaceId } })
        }
      ]
    });
    return {
      revision: required(written.revisions[assetKey]),
      assetId: required(written.assetIds[assetKey])
    };
  };

  const draftStore: FindingsWorld["draftStore"] = async (name, files, workspaceId) =>
    (await writeStoreDraft(name, storeConfig(files), workspaceId)).revision;

  const publishStore: FindingsWorld["publishStore"] = async (name, files, workspaceId) => {
    const config = storeConfig(files);
    const written = await writeStoreDraft(name, config, workspaceId);
    const { revision } = written;
    const stored = required(
      await t.stores.configAssets.getConfigAssetRevision({
        clientInstanceId,
        kind: DATA_STORE_ASSET_KIND,
        name,
        revision
      })
    );
    const id = await t.stores.transaction(async (stores) => {
      const moved = await stores.configAssets.publishConfigAssetRevision({
        clientInstanceId,
        kind: DATA_STORE_ASSET_KIND,
        name,
        assetId: written.assetId,
        revision,
        revisionId: stored.id
      });
      await dataStores.publish(stores, { assetId: moved.assetId, revision, config });
      return moved.assetId;
    });
    const level = files.filter((file) => file.path.startsWith("migrations/")).length;
    return eventually(async () => {
      const record = required(await t.stores.dataStores.getDataStore({ clientInstanceId, id }));
      expect(record).toMatchObject({ status: "ready", level });
      return record;
    });
  };

  const store = await publishStore("findings", [manifest(), init], t.workspaceId);
  const rowsAs = connect(store);
  const addFindings: FindingsWorld["addFindings"] = async (rows) => {
    for (const { details, ...row } of rows) {
      await rowsAs`insert into findings ${rowsAs({ ...row, details: rowsAs.json(details ?? {}) })}`;
    }
  };
  await addFindings([
    finding(1, { client_id: "client-a", severity: "error", amount: 10 }),
    finding(2, { client_id: "client-a", severity: "warning", amount: 20 }),
    finding(3, { client_id: "client-a", severity: "warning", amount: 30 }),
    finding(4, { client_id: "client-b", severity: "warning", amount: 40 })
  ]);

  expectStatus(await t.putApp(t.admin.id, "findings", findingsApp({ marker: "published" })), 200);
  expectStatus(await t.publish(t.admin.id, "findings", 1), 200);
  expectStatus(await t.putApp(t.admin.id, "findings", findingsApp({ marker: "draft" })), 200);

  return {
    ...t,
    store,
    statementLimits,
    dataStores,
    draftStore,
    publishStore,
    addFindings,
    findingRows: () => rowsAs<JsonObject[]>`select * from findings order by id`,
    // Simulates a missing legacy definition, outside the guarded asset-removal path.
    async removeStoreDefinition(name) {
      const asset = required(
        await t.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: DATA_STORE_ASSET_KIND,
          name
        })
      );
      await t.stores.transaction(async (stores) => {
        await stores.configAssets.applyConfigAssetMutations({
          clientInstanceId,
          baseRevisions: { [`${DATA_STORE_ASSET_KIND}:${name}`]: asset.revision },
          mutations: [{ type: "delete", kind: DATA_STORE_ASSET_KIND, name, scope: asset.scope }]
        });
      });
    },
    async setSizeLimit(storeId, bytes) {
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        await sql`update data_stores set size_limit_bytes = ${bytes} where id = ${storeId}`;
      } finally {
        await sql.end();
      }
    },
    setDataStoresModule(enabled) {
      dataStoresOn = enabled;
    },
    async closeAll() {
      await worker.stop();
      await Promise.all(connections.map((sql) => sql.end({ timeout: 1 })));
      await dataStores.close();
      // Databases and roles are the cluster's, which other suites share: every one this
      // instance made is removed by name.
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      try {
        const records = await sql<
          { database_name: string; app_role: string; migration_role: string }[]
        >`select database_name, app_role, migration_role from data_stores`;
        for (const record of records) {
          await sql.unsafe(`drop database if exists "${record.database_name}" with (force)`);
          await sql.unsafe(`drop role if exists "${record.app_role}"`);
          await sql.unsafe(`drop role if exists "${record.migration_role}"`);
        }
      } finally {
        await sql.end();
      }
      await own.close();
      await t.closeAll();
    }
  };
}
