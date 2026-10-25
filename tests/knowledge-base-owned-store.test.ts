import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  KNOWLEDGE_BASE_ASSET_KIND,
  knowledgeQueryOperationName,
  type DataStoreRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { getTestJobs } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// A Knowledge Base without a backend through the assembled instance: its publish makes a Data
// Store it owns with the platform's tables, pgvector only where it searches by meaning, and
// deleting it drops the store. Spec: data-stores-and-knowledge-bases.md, checks 8 (built-in
// half), 13 (the extension and the roles of a store) and 34.

const KB = "objektunterlagen";

const documents = (extra: JsonObject = {}): JsonObject => ({
  name: KB,
  title: "Objektunterlagen",
  description: "Exposés and plans of the objects, one document per file.",
  ...extra
});

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

const stateSchema = z.object({
  status: z.string(),
  tables: z.array(z.unknown()),
  problem: z.string().optional()
});

describe("the store a Knowledge Base owns", () => {
  const { start } = useDataStoreInstance();

  const put = (
    { api }: DataStoreInstance,
    config: JsonObject,
    expectedRevision: number | null = null
  ) =>
    api.call("assets.put", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { config, expectedRevision }
    });
  const publish = ({ api }: DataStoreInstance, revision: number) =>
    api.call("assets.publish", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { revision }
    });
  const remove = ({ api }: DataStoreInstance, expectedRevision: number) =>
    api.call("assets.delete", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { expectedRevision }
    });

  const ownedRecord = ({ stores }: DataStoreInstance) =>
    stores.dataStores.findDataStoreByName({ clientInstanceId, name: `knowledge-base:${KB}` });

  /** Runs the jobs of the API process until the owned store has the platform's tables. */
  function settle(world: DataStoreInstance): Promise<DataStoreRecord> {
    const jobs = getTestJobs(world.api);
    return eventually(async () => {
      await jobs.runDue();
      const record = await ownedRecord(world);
      expect(record).toMatchObject({ status: "ready", level: 14 });
      return required(record);
    });
  }

  /** Writes the definition as revision 1, publishes it and waits for its store. */
  async function published(world: DataStoreInstance, config: JsonObject) {
    const written = await put(world, config);
    expect(written.statusCode, written.body).toBe(200);
    const made = await publish(world, 1);
    expect(made.statusCode, made.body).toBe(200);
    return settle(world);
  }

  /** A connection of the test's own to a database of the server, as its superuser. */
  async function connect(database: string) {
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${database}`;
    return postgres(url.toString(), { max: 1, onnotice: () => undefined });
  }

  async function inDatabase<T>(database: string, read: (sql: postgres.Sql) => Promise<T>) {
    const sql = await connect(database);
    try {
      return await read(sql);
    } finally {
      await sql.end();
    }
  }

  const vectorIn = (database: string) =>
    inDatabase(database, async (sql) =>
      (await sql<{ name: string }[]>`select extname as name from pg_extension`).map(
        (row) => row.name
      )
    );

  it.each(["de"] as const)(
    "refuses a token cap below the extraction reserve at publish in %s, and accepts the reserve",
    async (locale) => {
      const instance = await start(true, undefined, undefined, undefined, {
        defaultLocale: locale
      });
      const config = (maxTokensPerDocument: number) =>
        documents({ methods: ["keyword"], extraction: { budget: { maxTokensPerDocument } } });
      const draft = await put(instance, config(511));
      expect(draft.statusCode).toBe(200);
      const refused = await publish(instance, 1);
      expect(refused.statusCode).toBe(422);
      const body = refused.json<ErrorBody>();
      expect(body.error.message).toContain("extraction.budget.maxTokensPerDocument");
      expect(body.error.message).toContain("511");
      expect(body.error.message).toContain("512");
      expect(body.error.message).toContain("kleiner als das Minimum");
      expect(await ownedRecord(instance)).toBeUndefined();
      expect((await put(instance, config(512), 1)).statusCode).toBe(200);
      expect((await publish(instance, 2)).statusCode).toBe(200);
      await settle(instance);
    }
  );

  it("is made on publish with the platform's tables and pgvector where the Knowledge Base searches by meaning", async () => {
    const instance = await start(true, undefined, undefined, undefined, { embedding: true });

    // No methods: search by meaning and by words, the default pair.
    const record = await published(instance, documents());

    expect(record).toMatchObject({
      id: required(
        await instance.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: KNOWLEDGE_BASE_ASSET_KIND,
          name: KB
        })
      ).id,
      ownerKnowledgeBaseId: KB,
      migrations: [
        expect.objectContaining({ number: 1, name: "documents" }),
        expect.objectContaining({ number: 2, name: "sources" }),
        expect.objectContaining({ number: 3, name: "source_fetch_claims" }),
        expect.objectContaining({ number: 4, name: "source_counts" }),
        expect.objectContaining({ number: 5, name: "source_withdrawal" }),
        expect.objectContaining({ number: 6, name: "workflow_sources" }),
        expect.objectContaining({ number: 7, name: "document_processors" }),
        expect.objectContaining({ number: 8, name: "record_content_hash" }),
        expect.objectContaining({ number: 9, name: "source_superseded" }),
        expect.objectContaining({ number: 10, name: "field_extraction_budget" }),
        expect.objectContaining({ number: 11, name: "record_content_hash_upgrade" }),
        expect.objectContaining({ number: 12, name: "record_projection_frame" }),
        expect.objectContaining({ number: 13, name: "workflow_ingest" }),
        expect.objectContaining({ number: 14, name: "item_removal_hold" })
      ]
    });
    const { database } = record.location;
    const tables = await inDatabase(
      database,
      (sql) =>
        sql<{ name: string; owner: string }[]>`
        select tablename as name, tableowner as owner from pg_tables
        where schemaname = 'catalyst_kb' order by tablename`
    );
    expect(tables.map((table) => table.name)).toEqual([
      "chunks",
      "contents",
      "documents",
      "field_budgets",
      "index_generations",
      "ingest_failures",
      "ingest_items",
      "ingest_waiting",
      "migrations",
      "source_counts",
      "source_cursors",
      "source_items",
      "sync_runs"
    ]);
    // The platform's role owns them; no role of the store does.
    for (const table of tables) {
      expect([record.roles.app, record.roles.migration]).not.toContain(table.owner);
    }
    const searchColumns = await inDatabase(
      database,
      (sql) =>
        sql<{ name: string }[]>`
        select table_name || '.' || column_name as name from information_schema.columns
        where table_schema = 'catalyst_kb' and is_generated = 'ALWAYS' order by 1`
    );
    expect(searchColumns.map((column) => column.name)).toEqual([
      "chunks.search_de",
      "chunks.search_en",
      "documents.title_search"
    ]);
    expect(await vectorIn(database)).toContain("vector");

    // No role of the store is a superuser, may create in its database, or reads the tables.
    const roles = await inDatabase(
      database,
      (sql) =>
        sql<{ name: string; superuser: boolean; create: boolean; usage: boolean }[]>`
        select rolname as name, rolsuper as superuser,
          has_database_privilege(oid, ${database}, 'CREATE') as create,
          has_schema_privilege(oid, 'catalyst_kb', 'USAGE') as usage
        from pg_roles where rolname = any(${[record.roles.app, record.roles.migration]})`
    );
    expect(roles).toHaveLength(2);
    for (const role of roles) {
      expect(role, role.name).toMatchObject({ superuser: false, create: false, usage: false });
    }

    // The check of the published revision finds the store ready.
    const checked = await instance.api.call("knowledge_bases.check", {
      params: { knowledgeBase: KB }
    });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(stateSchema.parse(checked.json())).toEqual({ status: "ok", tables: [] });

    // Listed among the stores, as owned; it has no operations of a store and no SQL query.
    const listed = await instance.api.call("data_stores.list", {});
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [
        {
          id: record.id,
          name: `knowledge-base:${KB}`,
          title: "Objektunterlagen",
          status: "ready",
          level: 14,
          ownedBy: { knowledgeBase: KB }
        }
      ]
    });
    expect(
      await instance.execution.operationCalls.registry.resolve(knowledgeQueryOperationName(KB))
    ).toBeUndefined();
    expect(
      (
        await instance.api.call("knowledge_bases.query", {
          params: { knowledgeBase: KB },
          payload: { sql: "select 1" }
        })
      ).statusCode
    ).toBe(404);
  });

  it.each([false, true])(
    "upgrades release 10 with content_sha256 present=%s and reapplies no release",
    async (present) => {
      const instance = await start(true, undefined, undefined, undefined, true);
      const made = await published(instance, documents({ methods: ["keyword"] }));
      const { database } = made.location;
      await inDatabase(database, async (sql) => {
        await sql`delete from catalyst_kb.migrations where number=11`;
        if (!present) await sql`alter table catalyst.record_fields drop column content_sha256`;
      });
      await instance.stores.dataStores.putDataStore({
        ...made,
        level: 10,
        migrations: made.migrations.filter(({ number }) => number !== 11)
      });
      expect((await put(instance, documents({ methods: ["keyword"] }), 1)).statusCode).toBe(200);
      expect((await publish(instance, 2)).statusCode).toBe(200);
      await settle(instance);
      const ledger = await inDatabase(database, async (sql) => {
        expect(
          await sql`select count(*)::int as count from information_schema.columns
        where table_schema='catalyst' and table_name='record_fields' and column_name='content_sha256'`
        ).toEqual([{ count: 1 }]);
        return sql`select * from catalyst_kb.migrations order by number`;
      });
      expect(ledger.map(({ number }) => number)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14
      ]);
      const audits = await instance.stores.audit.listAuditEvents({
        clientInstanceId,
        type: "data_store.migrated"
      });
      expect((await put(instance, documents({ methods: ["keyword"] }), 2)).statusCode).toBe(200);
      expect((await publish(instance, 3)).statusCode).toBe(200);
      await settle(instance);
      expect(
        await inDatabase(
          database,
          (sql) => sql`select * from catalyst_kb.migrations order by number`
        )
      ).toEqual(ledger);
      expect(
        await instance.stores.audit.listAuditEvents({
          clientInstanceId,
          type: "data_store.migrated"
        })
      ).toEqual(audits);
    }
  );

  it("is being set up, not in need of attention, until its store is made, and then ready without a check", async () => {
    const instance = await start(true, undefined, undefined, undefined, { embedding: true });
    const state = async () => {
      const read = await instance.api.call("knowledge_bases.get", {
        params: { knowledgeBase: KB }
      });
      expect(read.statusCode, read.body).toBe(200);
      return stateSchema.parse(read.json());
    };

    const written = await put(instance, documents());
    expect(written.statusCode, written.body).toBe(200);
    const made = await publish(instance, 1);
    expect(made.statusCode, made.body).toBe(200);
    const record = await ownedRecord(instance);
    expect(record).toMatchObject({ status: "provisioning" });
    // The store has the id of the Knowledge Base's asset.
    const assetId = required(record).id;
    const kept = () =>
      instance.stores.knowledgeBases.getKnowledgeBaseState({ clientInstanceId, assetId });

    // Nothing is wrong while the store is made: it says so, and nothing of it is kept.
    expect(await state()).toMatchObject({ status: "preparing" });
    expect(await kept()).toBeUndefined();

    // Once the store is made, the next read finds it ready, and keeps that.
    await settle(instance);
    expect(await state()).toEqual({ status: "ok", tables: [] });
    expect(await kept()).toMatchObject({ status: "ok", revision: 1 });
  });

  it("has no pgvector where the Knowledge Base searches by words alone", async () => {
    const instance = await start(true, undefined, undefined, undefined, { embedding: true });

    const record = await published(instance, documents({ methods: ["keyword"] }));

    expect(await vectorIn(record.location.database)).not.toContain("vector");
    expect(
      await inDatabase(
        record.location.database,
        (sql) =>
          sql`select 1 from pg_tables where schemaname = 'catalyst_kb' and tablename = 'chunks'`
      )
    ).toHaveLength(1);
  });

  it("summarizes every retained document on the first page, including ingestion beyond that page", async () => {
    const instance = await start(true, undefined, undefined, undefined, { documents: true });
    const record = await published(instance, documents({ methods: ["keyword"] }));
    const summary = async () => {
      const response = await instance.api.call("knowledge_bases.list_documents", {
        params: { knowledgeBase: KB },
        query: { limit: "1" }
      });
      expect(response.statusCode, response.body).toBe(200);
      return z
        .object({
          documents: z.array(z.unknown()),
          summary: z.object({
            count: z.number(),
            state: z.string(),
            lastIngestedAt: z.string().optional()
          })
        })
        .parse(response.json());
    };
    expect((await summary()).summary).toEqual({ count: 0, state: "indexed" });
    await inDatabase(record.location.database, async (sql) => {
      for (const [index, state] of ["extracted", "pending", "failed", "extracted"].entries()) {
        const hash = String(index + 1).repeat(64);
        await sql`insert into catalyst_kb.contents (sha256, format, state, updated_at)
          values (${hash}, 'txt', ${state}, ${`2026-10-0${index + 1}T12:00:00Z`})`;
        await sql`insert into catalyst_kb.documents
          (id, managed_file_id, content_sha256, title, file_name, added_at, withdrawn_at)
          values (${`doc-${index}`}, ${`file-${index}`}, ${hash}, 'Document', 'document.txt',
          ${`2026-10-0${index + 1}T12:00:00Z`}, ${index === 3 ? "2026-10-05T12:00:00Z" : null})`;
      }
    });
    const page = await summary();
    expect(page.documents).toHaveLength(1);
    expect(page.summary).toEqual({
      count: 3,
      state: "failed",
      lastIngestedAt: "2026-10-01T12:00:00.000Z"
    });
    await inDatabase(record.location.database, async (sql) => {
      await sql`update catalyst_kb.documents set withdrawn_at = now() where id = 'doc-2'`;
    });
    expect((await summary()).summary).toMatchObject({ count: 2, state: "pending" });
    await inDatabase(record.location.database, async (sql) => {
      await sql`update catalyst_kb.contents set state = 'extracted', updated_at = '2026-10-06T12:00:00Z' where state = 'pending'`;
    });
    expect((await summary()).summary).toEqual({
      count: 2,
      state: "indexed",
      lastIngestedAt: "2026-10-06T12:00:00.000Z"
    });
  });

  it("is dropped with every row and role when the Knowledge Base is deleted", async () => {
    const instance = await start(true, undefined, undefined, undefined, { embedding: true });
    const record = await published(instance, documents());
    const { database } = record.location;
    await inDatabase(
      database,
      (sql) =>
        sql`insert into catalyst_kb.contents (sha256, format) values (${"a".repeat(64)}, 'text')`
    );

    const deleted = await remove(instance, 1);
    expect(deleted.statusCode, deleted.body).toBe(200);
    // Until the job ran, the store is held: the Knowledge Base brought back waits for it.
    const revived = await put(instance, documents(), 2);
    expect(revived.statusCode, revived.body).toBe(200);
    const early = await publish(instance, 3);
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json<ErrorBody>().error.details).toMatchObject({
      reason: "knowledge_store_dropping"
    });

    const jobs = getTestJobs(instance.api);
    // The drop job drops a database, which forces a checkpoint: on a busy machine that takes
    // longer than a condition usually gets.
    await eventually(async () => {
      await jobs.runDue();
      expect(
        await instance.stores.dataStores.getDataStore({ clientInstanceId, id: record.id })
      ).toBeUndefined();
    }, 60_000);
    const server = await connect("postgres");
    try {
      expect(await server`select 1 from pg_database where datname = ${database}`).toHaveLength(0);
      expect(
        await server`select 1 from pg_roles where rolname = any(${[record.roles.app, record.roles.migration]})`
      ).toHaveLength(0);
    } finally {
      await server.end();
    }
    const audit = await instance.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "data_store.dropped"
    });
    expect(audit).toContainEqual(
      expect.objectContaining({ type: "data_store.dropped", subject: record.id })
    );

    // The store is gone: the Knowledge Base brought back gets a new, empty one.
    expect((await publish(instance, 3)).statusCode).toBe(200);
    const again = await settle(instance);
    expect(again.id).toBe(record.id);
    expect(
      await inDatabase(database, (sql) => sql`select 1 from catalyst_kb.contents`)
    ).toHaveLength(0);
  }, 120_000);

  it("refuses search by meaning on an instance with no embedding model, and searches by words there", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);

    const pair = await put(instance, documents());
    const semantic = await put(instance, documents({ methods: ["semantic"] }));
    for (const refused of [pair, semantic]) {
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.body).toContain("names no 'knowledge.defaultEmbeddingBinding'");
    }

    const record = await published(instance, documents({ methods: ["keyword"] }));
    expect(await vectorIn(record.location.database)).not.toContain("vector");
  });

  it("keeps its backend once published", async () => {
    const instance = await start(true, undefined, undefined, undefined, { embedding: true });
    await published(instance, documents());

    const written = await put(
      instance,
      documents({
        methods: ["structured"],
        backend: { dataStore: "findings" },
        tables: [{ name: "findings", description: "One row per finding." }]
      }),
      1
    );
    expect(written.statusCode, written.body).toBe(200);
    const refused = await publish(instance, 2);

    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<ErrorBody>().error.details).toMatchObject({
      reason: "knowledge_backend_changed"
    });
    expect(await ownedRecord(instance)).toMatchObject({ status: "ready" });
  });
});
