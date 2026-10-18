import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { KNOWLEDGE_BASE_ASSET_KIND, type JsonObject } from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { getTestJobs } from "./support/test-instance";

// The synced source migrations (SRC-0 and SRC-1a) bring a store made
// at level 1 to level 8 at the next start, without a publish, and leaves its rows as they
// were, and the `sources` entry of a Knowledge Base is saved with a draft but not published
// until SRC-1a syncs it. `schedule` is withdrawn. Spec: data-stores-and-knowledge-bases.md, Synced sources, check 71.

const KB = "objektunterlagen";

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

const definition = (extra: JsonObject = {}): JsonObject => ({
  name: KB,
  title: "Objektunterlagen",
  description: "Exposés and plans of the objects, one document per file.",
  methods: ["keyword"],
  ...extra
});

const source: JsonObject = {
  id: "objekte",
  connection: "musterbau-box",
  folders: ["123456789"],
  include: ["*.pdf", "*.docx"],
  exclude: ["**/Personal/**"]
};

describe("KBW-0 records ownership", () => {
  const { start } = useDataStoreInstance();
  it("refuses records in kb.yaml with a pointer to store.yaml and reserves the Workflow source prefix", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);
    const records = await instance.api.call("assets.put", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { config: definition({ records: { table: "properties" } }), expectedRevision: null }
    });
    expect(records.statusCode).toBe(422);
    expect(records.body).toContain("records");
    expect(records.body).toContain("store.yaml");
    const sourceId = await instance.api.call("assets.put", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: {
        config: definition({ sources: [{ ...source, id: "workflow:import" }] }),
        expectedRevision: null
      }
    });
    expect(sourceId.statusCode).toBe(422);
  });
});

describe("catalyst_kb source migrations", () => {
  const { start } = useDataStoreInstance();

  const ownedRecord = (instance: DataStoreInstance) =>
    instance.stores.dataStores.findDataStoreByName({
      clientInstanceId,
      name: `knowledge-base:${KB}`
    });

  /** Runs the jobs of the API process until the owned store is at `level`. */
  const settle = (instance: DataStoreInstance, level: number) => {
    const jobs = getTestJobs(instance.api);
    return eventually(async () => {
      await jobs.runDue();
      const record = await ownedRecord(instance);
      expect(record).toMatchObject({ status: "ready", level });
      return required(record);
    });
  };

  const writeAndPublish = async (instance: DataStoreInstance, revision: number) => {
    const written = await instance.api.call("assets.put", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { config: definition(), expectedRevision: revision === 1 ? null : revision - 1 }
    });
    expect(written.statusCode, written.body).toBe(200);
    const published = await instance.api.call("assets.publish", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { revision }
    });
    expect(published.statusCode, published.body).toBe(200);
  };

  it("upgrades connector cursors unchanged and constrains Workflow source identity (KBW-0)", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);
    await writeAndPublish(instance, 1);
    const made = await settle(instance, 8);
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${made.location.database}`;
    const store = postgres(url.toString(), { max: 1, onnotice() {} });
    try {
      await store.unsafe(`alter table catalyst_kb.source_cursors
        drop constraint source_kind_check, drop column workflow_id, drop column kind,
        alter column cursor set not null;
        delete from catalyst_kb.migrations where number=6;`);
      await store`insert into catalyst_kb.source_cursors(source_id,cursor) values ('box','cursor-1')`;
      await instance.stores.dataStores.putDataStore({
        ...made,
        level: 5,
        migrations: made.migrations.slice(0, 5)
      });
      const platform = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
      try {
        await platform`update platform_jobs set run_after=now() where kind='data_store.upgrade_owned' and client_instance_id=${clientInstanceId} and status='queued'`;
      } finally {
        await platform.end();
      }
      await settle(instance, 8);
      expect(
        await store`select source_id,cursor,kind,workflow_id from catalyst_kb.source_cursors`
      ).toEqual([{ source_id: "box", cursor: "cursor-1", kind: "connector", workflow_id: null }]);
      await store`insert into catalyst_kb.source_cursors(source_id,kind,workflow_id) values ('workflow:import','workflow','import')`;
      expect(
        await store`select cursor from catalyst_kb.source_cursors where source_id='workflow:import'`
      ).toEqual([{ cursor: null }]);
      for (const [sourceId, kind, workflowId, cursor] of [
        ["workflow:other", "workflow", "import", null],
        ["workflow:bad", "connector", null, "cursor"],
        ["import", "workflow", null, null],
        ["box-without-cursor", "connector", null, null],
        ["workflow:withcursor", "workflow", "withcursor", "cursor"]
      ] as const) {
        await expect(
          store`insert into catalyst_kb.source_cursors(source_id,kind,workflow_id,cursor) values (${sourceId},${kind},${workflowId},${cursor})`
        ).rejects.toMatchObject({ code: "23514" });
      }
    } finally {
      await store.end();
    }
  });

  it("brings a store at level 1 to level 8 with its documents, contents and chunks unchanged", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);
    await writeAndPublish(instance, 1);
    const made = await settle(instance, 8);
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${made.location.database}`;
    const store = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      // The store as the release before SRC-0 left it: migration 1 alone, whose SQL is unchanged.
      await store.unsafe(`
        drop trigger source_content_count_changed on catalyst_kb.contents;
        drop function catalyst_kb.source_content_count_changed();
        drop table catalyst_kb.source_counts;
        drop function catalyst_kb.source_item_count_changed() cascade;
        drop function catalyst_kb.source_open_change() cascade;
        drop function catalyst_kb.source_projection(text,text);
        drop function catalyst_kb.move_source_count(text,text,text,text,text,bigint);
        drop trigger source_document_purged on catalyst_kb.documents;
        drop function catalyst_kb.source_document_purged();
        drop trigger source_freshness_changed on catalyst_kb.contents;
        drop function catalyst_kb.source_freshness_changed();
        alter table catalyst_kb.documents drop column source_item_id;
        drop table catalyst_kb.source_cursors, catalyst_kb.sync_runs, catalyst_kb.source_items;
        alter table catalyst_kb.contents drop column document_type, drop column processor_revision, drop column processing_key, drop column requested_processing_key;
        delete from catalyst_kb.migrations where number >= 2;`);
      await instance.stores.dataStores.putDataStore({
        ...made,
        level: 1,
        migrations: made.migrations.slice(0, 1)
      });
      const sha = "a".repeat(64);
      await store`insert into catalyst_kb.contents (sha256, format, state, chunking_revision)
        values (${sha}, 'markdown', 'extracted', 1)`;
      await store`insert into catalyst_kb.documents (id, managed_file_id, content_sha256, title, file_name)
        values ('doc-1', 'file-1', ${sha}, 'Exposé', 'expose.md')`;
      await store`insert into catalyst_kb.chunks (id, content_sha256, chunking_revision, position, text, token_count)
        values ('chunk-1', ${sha}, 1, 0, 'Baujahr 1962', 3)`;
      const rowsOf = async () => ({
        contents:
          await store`select sha256, format, state, chunking_revision from catalyst_kb.contents`,
        documents:
          await store`select id, managed_file_id, content_sha256, title, file_name from catalyst_kb.documents`,
        chunks: await store`select id, content_sha256, position, text from catalyst_kb.chunks`
      });
      const before = await rowsOf();

      // The next start makes the waiting tick of the upgrade due at once, which queues the
      // store's migration to this release's tables: no publish.
      const platform = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
      try {
        await platform`update platform_jobs set run_after = now()
          where kind = 'data_store.upgrade_owned' and client_instance_id = ${clientInstanceId}
          and status = 'queued'`;
      } finally {
        await platform.end();
      }
      const migrated = await settle(instance, 8);

      expect(migrated.migrations.map(({ number, name }) => ({ number, name }))).toEqual([
        { number: 1, name: "documents" },
        { number: 2, name: "sources" },
        { number: 3, name: "source_fetch_claims" },
        { number: 4, name: "source_counts" },
        { number: 5, name: "source_withdrawal" },
        { number: 6, name: "workflow_sources" },
        { number: 7, name: "document_processors" },
        { number: 8, name: "source_superseded" }
      ]);
      expect(
        (await store`select number from catalyst_kb.migrations order by number`).map(
          (row) => row.number
        )
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(await rowsOf()).toEqual(before);
      // A document added by hand names no item.
      expect(await store`select source_item_id from catalyst_kb.documents`).toEqual([
        { source_item_id: null }
      ]);
      const tables = await store<{ name: string }[]>`
        select tablename as name from pg_tables where schemaname = 'catalyst_kb' order by 1`;
      expect(tables.map((table) => table.name)).toEqual([
        "chunks",
        "contents",
        "documents",
        "index_generations",
        "migrations",
        "source_counts",
        "source_cursors",
        "source_items",
        "sync_runs"
      ]);
      expect(
        await instance.stores.audit.listAuditEvents({
          clientInstanceId,
          type: "data_store.migrated"
        })
      ).toContainEqual(
        expect.objectContaining({
          subject: made.id,
          metadata: expect.objectContaining({ level: 8, appliedCount: 7 })
        })
      );

      // A document of a synced source names its item; an item is one row per source and id.
      await store`insert into catalyst_kb.source_items
        (id, source_id, item_id, version, path, name, mime, size, modified_at)
        values ('item-1', 'objekte', 'box-1', 'v1', '/expose.md', 'expose.md', 'text/markdown', 12, now())`;
      await store`update catalyst_kb.documents set source_item_id = 'item-1' where id = 'doc-1'`;
      await expect(
        store`insert into catalyst_kb.source_items
          (id, source_id, item_id, version, path, name, mime, size, modified_at)
          values ('item-2', 'objekte', 'box-1', 'v2', '/expose.md', 'expose.md', 'text/markdown', 12, now())`
      ).rejects.toThrow(/source_items_source_id_item_id_key/u);
      // One running sync per source.
      await store`insert into catalyst_kb.sync_runs (id, source_id, mode, operation_run_id)
        values ('run-1', 'objekte', 'initial', 'oprun-1')`;
      await expect(
        store`insert into catalyst_kb.sync_runs (id, source_id, mode, operation_run_id)
          values ('run-2', 'objekte', 'changes', 'oprun-2')`
      ).rejects.toThrow(/sync_runs_running_idx/u);
    } finally {
      await store.end();
    }
  });
});

describe("the sources entry of a Knowledge Base", () => {
  const { start } = useDataStoreInstance();

  const put = (
    instance: Awaited<ReturnType<typeof start>>,
    config: JsonObject,
    expectedRevision: number | null = null
  ) =>
    instance.api.call("assets.put", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { config, expectedRevision }
    });

  it("is saved with a draft and refuses a missing source Connection at publish", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);

    const written = await put(instance, definition({ sources: [source] }));
    expect(written.statusCode, written.body).toBe(200);

    const published = await instance.api.call("assets.publish", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { revision: 1 }
    });
    expect(published.statusCode, published.body).toBe(404);
    expect(published.json<ErrorBody>().error.message).toContain("Connection");

    // Without the source it publishes.
    const without = await put(instance, definition(), 1);
    expect(without.statusCode, without.body).toBe(200);
    const again = await instance.api.call("assets.publish", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { revision: 2 }
    });
    expect(again.statusCode, again.body).toBe(200);
    // Its store is made before the test ends, so the cleanup finds the database it names.
    const jobs = getTestJobs(instance.api);
    await eventually(async () => {
      await jobs.runDue();
      const record = await instance.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      });
      expect(record).toMatchObject({ status: "ready", level: 8 });
    });
  });

  it("refuses schedule on push with the reason", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);

    const written = await put(instance, definition({ schedule: "0 2 * * *" }));
    expect(written.statusCode, written.body).toBe(422);
    expect(written.body).toContain("'schedule' is withdrawn");
    expect(written.body).toContain("abgleichen");
  });

  it("refuses a malformed source on push", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);

    const refusals: [JsonObject, string][] = [
      [definition({ sources: [source, source] }), "A source id is named once"],
      [definition({ sources: [{ ...source, folders: [] }] }), "folders"],
      [definition({ sources: [{ ...source, folders: ["1", "1"] }] }), "A folder is named once"],
      [definition({ sources: [{ ...source, path: "/Objekte" }] }), "path"],
      [definition({ sources: [{ ...source, schedule: "daily" }] }), "schedule"],
      [
        definition({
          methods: ["structured"],
          backend: { dataStore: "objekte" },
          tables: [{ name: "objekt", description: "One object." }],
          sources: [source]
        }),
        "syncs no source"
      ]
    ];
    for (const [config, expected] of refusals) {
      const written = await put(instance, config);
      expect(written.statusCode, written.body).toBe(422);
      expect(written.body).toContain(expected);
    }
  });
});
