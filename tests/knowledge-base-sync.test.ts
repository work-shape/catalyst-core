import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import { createFixtureDocumentSource, loadSecretKeyring } from "@work-shape/catalyst-connections";
import { createDataStores, createKnowledgeBases } from "@work-shape/catalyst-data-stores";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import {
  StoreBackedAuditRecorder,
  enqueueKnowledgeIndex,
  DocumentSourceError,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_FILE_MAX_BYTES,
  knowledgeSyncJob,
  knowledgeFetchJob,
  knowledgeSourceKey,
  knowledgeExtractionKey,
  readObjectBytes,
  knowledgeExtractionResultSchema,
  type ConnectorContext,
  type DocumentSourceCapability,
  type KnowledgeFiles,
  type Logger
} from "@work-shape/catalyst-core";
import { eventually, required, waitUntil } from "./support/assertions";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { getTestJobs } from "./support/test-instance";

const KB = "sync-test";
const SOURCE = "source";
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const target = {
  protocol: "https",
  host: "fixture.invalid",
  port: 443,
  address: "192.0.2.1",
  family: 4,
  network: "public"
} as const;
function context(signal: AbortSignal): ConnectorContext {
  return {
    connection: {
      id: "fixture",
      name: "fixture",
      revision: 1,
      settings: {},
      authScheme: "bearer",
      operations: []
    },
    target,
    checkEgress: async () => target,
    credentialFor: () => ({ scheme: "bearer", secret: "test", headers: {} }),
    signal
  };
}

describe("initial and full source import (KB 72, 73)", () => {
  const { start } = useDataStoreInstance();
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
  });

  async function setup(
    wrap: (source: DocumentSourceCapability) => DocumentSourceCapability = (source) => source
  ) {
    const instance = await start(true, undefined, undefined, undefined, { embedding: true });
    const definition = {
      name: KB,
      title: "Source",
      description: "Synced test documents",
      methods: ["keyword", "semantic"]
    };
    expect(
      (
        await instance.api.call("assets.put", {
          params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
          payload: { config: definition, expectedRevision: null }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await instance.api.call("assets.publish", {
          params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
          payload: { revision: 1 }
        })
      ).statusCode
    ).toBe(200);
    const jobs = getTestJobs(instance.api);
    const record = await eventually(async () => {
      await jobs.runDue();
      const row = await instance.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      });
      expect(row?.status).toBe("ready");
      expect(row?.level).toBe(3);
      return required(row);
    });
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    cleanups.push(() => sql.end());
    const platform = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    cleanups.push(() => platform.end());
    // SRC-1b owns the publishing principal and operations. Exercise SRC-1a below that gate.
    expect(
      (
        await instance.api.call("assets.put", {
          params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
          payload: {
            config: {
              ...definition,
              sources: [{ id: SOURCE, connection: "fixture", folders: ["folder", "other"] }]
            },
            expectedRevision: 1
          }
        })
      ).statusCode
    ).toBe(200);
    const revision = required(
      await instance.stores.configAssets.getConfigAssetRevision({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: KB,
        revision: 2
      })
    );
    await instance.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind: KNOWLEDGE_BASE_ASSET_KIND,
      name: KB,
      assetId: record.id,
      revision: 2,
      revisionId: revision.id
    });
    const fixture = createFixtureDocumentSource({ secret: "test", pageSize: 100 });
    const capability = wrap(fixture.capability);
    const objects = createFilesystemObjectStorage(instance.filesRoot);
    const files: KnowledgeFiles = { objects, open: async () => undefined };
    const dataStores = createDataStores({
      clientInstanceId,
      stores: instance.stores,
      databaseUrl: await fileTestDatabaseUrl(),
      keyring: await loadSecretKeyring({
        keys: [{ id: "test", ref: "test" }],
        secrets: { resolve: async () => randomBytes(32).toString("base64") }
      }),
      limits: { sizeLimitBytes: 1024 ** 3, poolMaxConnections: 3 },
      logger: silent
    });
    cleanups.push(() => dataStores.close());
    const embed = vi.fn(async ({ texts }: { texts: readonly string[] }) => ({
      vectors: texts.map(() => Array.from({ length: 8 }, () => 0.25))
    }));
    const knowledge = createKnowledgeBases({
      clientInstanceId,
      stores: instance.stores,
      backend: dataStores.knowledgeBackend,
      embedding: {
        defaultBinding: "embedding",
        models: [{ bindingId: "embedding", model: "test", dimensions: 8 }]
      },
      documentFormats: ["txt", "markdown"],
      maxDocuments: 10000,
      logger: silent
    });
    const fileJobs = knowledge.fileJobs(
      files,
      new StoreBackedAuditRecorder({ clientInstanceId, store: instance.stores.audit }),
      embed
    );
    const handlers = dataStores.knowledgeSourceJobs({
      files,
      documentFormats: ["txt", "markdown"],
      maxDocuments: 10000,
      openSource: async (_name, signal) => ({ capability, context: context(signal) })
    });
    const worker = createJobWorker({
      clientInstanceId,
      stores: instance.stores,
      handlers: [...handlers, ...fileJobs.handlers],
      logger: silent
    });
    cleanups.push(() => worker.stop());
    let runNumber = 0;
    async function sync(mode: "initial" | "full" = "initial") {
      const syncRunId = `sync-${++runNumber}`;
      await sql`insert into catalyst_kb.sync_runs (id, source_id, mode, operation_run_id) values (${syncRunId}, ${SOURCE}, ${mode}, 'operation')`;
      await instance.stores.jobs.enqueue(
        knowledgeSyncJob,
        { knowledgeBaseId: record.id, sourceId: SOURCE, syncRunId, operationRunId: "operation" },
        {
          clientInstanceId,
          subject: record.id,
          concurrencyKey: knowledgeSourceKey(record.id, SOURCE)
        }
      );
      return syncRunId;
    }
    async function drain(run: string) {
      return vi.waitFor(
        async () => {
          // Advance only this test's scheduled retries, without depending on wall-clock sleeps.
          await platform`update platform_jobs set run_after = now() where status = 'queued' and kind in ('knowledge_base.sync', 'knowledge_base.fetch')`;
          await worker.runDue();
          const [pending] =
            await sql`select count(*)::int as n from catalyst_kb.source_items where state = 'discovered'`;
          const [runRow] = await sql`select state from catalyst_kb.sync_runs where id = ${run}`;
          expect(pending?.n).toBe(0);
          expect(runRow?.state).toBe("done");
          const [unindexed] =
            await sql`select count(*)::int as n from catalyst_kb.contents where state = 'pending'`;
          expect(unindexed?.n).toBe(0);
        },
        { timeout: 180_000 }
      );
    }
    return {
      ...fixture,
      instance,
      sql,
      platform,
      worker,
      jobs: worker,
      embed,
      sync,
      drain,
      objects,
      record
    };
  }

  it("finishes an exhausted batch after every document insert fails and permits another sync", async () => {
    const world = await setup();
    for (let i = 0; i < 2; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode("text")
      });
    await world.sql
      .unsafe(`create function reject_document() returns trigger language plpgsql as $$ begin raise exception 'rejected'; end $$;
      create trigger reject_document before insert on catalyst_kb.documents for each row execute function reject_document()`);
    const run = await world.sync();
    await world.worker.runDue();
    for (let attempt = 0; attempt < knowledgeFetchJob.maxAttempts; attempt++) {
      await world.platform`update platform_jobs set run_after=now() where kind='knowledge_base.fetch' and status='queued'`;
      await world.worker.runDue();
    }
    expect(
      await world.sql`select state, failure_code, failed, ended_at is not null as ended from catalyst_kb.sync_runs where id=${run}`
    ).toEqual([
      { state: "failed", failure_code: "knowledge_fetch_failed", failed: 2, ended: true }
    ]);
    expect(
      await world.sql`select state, failure_code, attempts from catalyst_kb.source_items order by item_id`
    ).toEqual([
      {
        state: "failed",
        failure_code: "knowledge_fetch_failed",
        attempts: knowledgeFetchJob.maxAttempts
      },
      { state: "failed", failure_code: "knowledge_fetch_failed", attempts: 0 }
    ]);
    expect(
      await world.platform`select count(*)::int as n from managed_files where owner_id=${world.record.id}`
    ).toEqual([{ n: 0 }]);
    expect((await world.objects.list(`knowledge-bases/${world.record.id}/`)).objects).toHaveLength(
      0
    );
    await expect(world.sync("full")).resolves.toBeTypeOf("string");
  });

  it("refuses local removal of a synced document and keeps it through a full pass", async () => {
    const world = await setup();
    world.world.put({
      folderId: "folder",
      name: "source.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("text")
    });
    await world.drain(await world.sync());
    const [document] = await world.sql`select id from catalyst_kb.documents`;
    // The list names the source, so the documents page offers no Remove for it.
    const listed = await world.instance.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: KB }
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(JSON.parse(listed.body)).toMatchObject({
      documents: [{ id: String(required(document).id), sourceId: SOURCE }]
    });
    const response = await world.instance.api.call("knowledge_bases.remove_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [String(required(document).id)] }
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.body).toContain("knowledge_synced_document_remove_refused");
    await world.drain(await world.sync("full"));
    expect(
      await world.sql`select d.id from catalyst_kb.documents d join catalyst_kb.source_items i on i.document_id=d.id where i.state='fetched' and d.withdrawn_at is null`
    ).toEqual([document]);
  });

  it("queues 1000 ids once across listing 429 resumes and claims duplicate batches without orphan copies", async () => {
    let listCalls = 0;
    let release = false;
    let unblock = () => {};
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const calls = new Map<string, number>();
    const world = await setup((source) => ({
      ...source,
      list(input, ctx) {
        if (++listCalls % 2 === 0)
          throw new DocumentSourceError("rate_limited", "Wait", { retryAfterMs: 60000 });
        return source.list(input, ctx);
      },
      async *fetch(input, ctx) {
        if (!release)
          throw new DocumentSourceError("rate_limited", "Wait", { retryAfterMs: 60000 });
        calls.set(input.itemId, (calls.get(input.itemId) ?? 0) + 1);
        await gate;
        yield* source.fetch(input, ctx);
      }
    }));
    for (let i = 0; i < 1000; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode("shared text")
      });
    const run = await world.sync();
    for (let page = 0; page < 10; page++) {
      await world.platform`update platform_jobs set run_after=now() where kind='knowledge_base.sync' and status='queued'`;
      await world.worker.runDue();
    }
    const queued =
      await world.platform`select payload from platform_jobs where kind='knowledge_base.fetch' and status='queued'`;
    expect(queued).toHaveLength(10);
    const payloads = queued.map((row) => knowledgeFetchJob.payloadSchema.parse(row.payload));
    expect(payloads.flatMap((payload) => payload.sourceItemIds)).toHaveLength(1000);
    // Park the normal queue, then start two identical batches together. Hold their
    // streams until both handlers reach fetch: the claim must let them fetch different
    // items, and removing the claim predicate must produce duplicate calls.
    await world.platform`update platform_jobs set run_after=now()+interval '1 day' where kind='knowledge_base.fetch' and status='queued'`;
    const payload = required(payloads[0]);
    for (let duplicate = 0; duplicate < 2; duplicate++)
      await world.instance.stores.jobs.enqueue(knowledgeFetchJob, payload, { clientInstanceId });
    release = true;
    const racing = world.worker.runDue();
    try {
      await eventually(() =>
        expect([...calls.values()].reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(2)
      );
    } finally {
      unblock();
      await racing;
    }
    await world.drain(run);
    expect(calls.size).toBe(1000);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    expect(
      await world.platform`select count(*)::int as n from managed_files where owner_id=${world.record.id}`
    ).toEqual([{ n: 1000 }]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toEqual([
      { n: 1000 }
    ]);
  }, 180000);

  it("waits for the owned document lock before borrowing the platform transaction", async () => {
    const world = await setup();
    world.world.put({
      folderId: "folder",
      name: "lock.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("text")
    });
    await world.sync();
    await world.worker.runDue();
    let active = 0;
    const original = world.instance.stores.transaction.bind(world.instance.stores);
    const spy = vi.spyOn(world.instance.stores, "transaction").mockImplementation(async (work) => {
      active++;
      try {
        return await original(work);
      } finally {
        active--;
      }
    });
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${world.record.location.database}`;
    const blocker = postgres(url.toString(), { max: 1, onnotice() {} });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocking = blocker.begin(async (sql) => {
      await sql`lock table catalyst_kb.documents in share row exclusive mode`;
      locked();
      await held;
    });
    await ready;
    const fetching = world.worker.runDue();
    try {
      await eventually(async () => {
        const [row] =
          await world.sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event='relation' and query like '%lock table catalyst_kb.documents%'`;
        expect(row?.n).toBeGreaterThan(0);
      });
      expect(active).toBe(0);
    } finally {
      release();
      await blocking;
      await fetching;
      spy.mockRestore();
      await blocker.end();
    }
  });

  it("stores fixture paths relative to the boundary folder", async () => {
    const world = await setup();
    world.world.put({
      folderId: "folder",
      name: "relative.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("text")
    });
    await world.drain(await world.sync());
    expect(await world.sql`select path from catalyst_kb.source_items`).toEqual([
      { path: "/relative.txt" }
    ]);
  });

  it("imports a source of many pages and batches, isolates three failed fetches, and makes zero fetch or embedding calls on the second full pass", async () => {
    // 1,250 items cross 13 listing pages of 100, the last one short, and queue 13 fetch
    // batches of 100: every paging and batching path a 10,000-item source takes. Fetching runs
    // at some 65 items a second, so 10,000 items took about 176 seconds, at the drain limit.
    const items = 1250;
    let fetches = 0;
    let pages = 0;
    const world = await setup((source) => ({
      ...source,
      list(input, ctx) {
        pages++;
        return source.list(input, ctx);
      },
      async *fetch(input, ctx) {
        fetches++;
        if (input.itemId === "f1")
          throw new DocumentSourceError("unavailable", "Fixture unavailable");
        yield* source.fetch(input, ctx);
      }
    }));
    for (let i = 0; i < items; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode("Shared searchable text")
      });
    await world.drain(await world.sync());
    expect(
      await world.sql`select state, attempts, failure_code from catalyst_kb.source_items where item_id = 'f1'`
    ).toMatchObject([{ state: "failed", attempts: 3, failure_code: "knowledge_fetch_failed" }]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.source_items`).toMatchObject([
      { n: items }
    ]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toMatchObject([
      { n: items - 1 }
    ]);
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.contents where state = 'extracted'`
    ).toMatchObject([{ n: 1 }]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.chunks`).toMatchObject([
      { n: 1 }
    ]);
    expect(pages).toBe(13);
    expect(fetches).toBe(items + 2);
    expect(world.embed).toHaveBeenCalledTimes(1);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.embeddings_1`).toEqual([
      { n: 1 }
    ]);
    const extractions = await world.objects.list(`knowledge-bases/${world.record.id}/extracted/`);
    expect(extractions.objects).toHaveLength(1);
    const before = world.embed.mock.calls.length;
    fetches = 0;
    await world.drain(await world.sync("full"));
    expect(fetches).toBe(0);
    expect(world.embed.mock.calls.length).toBe(before);
    expect(await world.objects.list(`knowledge-bases/${world.record.id}/extracted/`)).toEqual(
      extractions
    );
  }, 240_000);

  it("resumes after SIGKILL with one platform connection and no duplicate items, documents, contents or chunks", async () => {
    const world = await setup();
    for (let i = 0; i < 300; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode("Resumed content")
      });
    const run = await world.sync();
    const child = spawn(
      process.execPath,
      ["--experimental-import-meta-resolve", "tests/support/knowledge-sync-worker.mjs"],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          SRC1A_DATABASE_URL: await fileTestDatabaseUrl(),
          SRC1A_FILES_ROOT: world.instance.filesRoot
        }
      }
    );
    let interrupted = false;
    let errorText = "";
    child.stderr?.on("data", (chunk) => {
      errorText += String(chunk);
    });
    child.on("message", (message) => {
      if (message === "interrupt") interrupted = true;
    });
    try {
      await waitUntil(
        () => {
          if (child.exitCode !== null) throw new Error(errorText);
          return interrupted;
        },
        "the worker reaches a partially committed fetch batch",
        60000
      );
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const [committed] = await world.sql`select count(*)::int as n from catalyst_kb.documents`;
      expect(committed?.n).toBeGreaterThan(0);
      expect(committed?.n).toBeLessThan(300);
      // The lease of a dead process expires; the replacement claims the same persisted job.
      await world.platform`update platform_jobs set lease_expires_at = now() - interval '1 second' where kind in ('knowledge_base.sync', 'knowledge_base.fetch') and status = 'running'`;
      await world.drain(run);
      for (const table of ["source_items", "documents"]) {
        const rows = await world.sql.unsafe(
          `select count(*)::int as n, count(distinct id)::int as unique_n from catalyst_kb.${table}`
        );
        expect(rows).toMatchObject([{ n: 300, unique_n: 300 }]);
      }
      expect(
        await world.sql`select count(*)::int as n from catalyst_kb.contents where state = 'extracted'`
      ).toEqual([{ n: 1 }]);
      expect(await world.sql`select count(*)::int as n from catalyst_kb.chunks`).toEqual([
        { n: 1 }
      ]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 120000);

  it("deduplicates bytes, moves without fetch, stores text for reindex, and skips oversized and unsupported files", async () => {
    let fetches = 0;
    const world = await setup((source) => ({
      ...source,
      async *fetch(input, ctx) {
        fetches++;
        yield* source.fetch(input, ctx);
      }
    }));
    const bytes = new TextEncoder().encode("One content in two folders.");
    const a = world.world.put({ folderId: "folder", name: "a.md", mime: "text/markdown", bytes });
    world.world.put({ folderId: "other", name: "b.md", mime: "text/markdown", bytes });
    world.world.put({
      folderId: "folder",
      name: "large.txt",
      mime: "text/plain",
      bytes: new Uint8Array(KNOWLEDGE_FILE_MAX_BYTES + 1)
    });
    world.world.put({ folderId: "folder", name: "bad.zip", mime: "application/zip", bytes });
    await world.drain(await world.sync());
    expect(fetches).toBe(2);
    expect(
      await world.sql`select failure_code from catalyst_kb.source_items where state = 'failed' order by item_id`
    ).toEqual([
      { failure_code: "knowledge_file_over_limit" },
      { failure_code: "knowledge_file_format_unsupported" }
    ]);
    const [content] = await world.sql`select sha256 from catalyst_kb.contents`;
    const extracted = knowledgeExtractionResultSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          await readObjectBytes(
            world.objects,
            knowledgeExtractionKey(world.record.id, required(content).sha256)
          )
        )
      )
    );
    expect(extracted).toMatchObject({
      status: "extracted",
      pages: [{ page: 1, text: new TextDecoder().decode(bytes) }]
    });
    const rows = await world.sql`select id, content_sha256 from catalyst_kb.documents order by id`;
    world.world.rename(a, "renamed.md");
    world.world.move(a, "other");
    fetches = 0;
    await world.drain(await world.sync("full"));
    expect(fetches).toBe(0);
    expect(
      await world.sql`select id, content_sha256 from catalyst_kb.documents order by id`
    ).toEqual(rows);
    expect(
      await world.sql`select name, path from catalyst_kb.source_items where item_id = ${a}`
    ).toEqual([{ name: "renamed.md", path: "/renamed.md" }]);
    expect(
      await world.sql`select title, file_name from catalyst_kb.documents where source_item_id = (select id from catalyst_kb.source_items where item_id = ${a})`
    ).toEqual([{ title: "renamed.md", file_name: "renamed.md" }]);
    const [copy] =
      await world.sql`select managed_file_id,content_sha256 from catalyst_kb.documents limit 1`;
    const files = await world.instance.stores.files.listOwnedManagedFilesById({
      clientInstanceId,
      owner: { kind: "knowledge_base", id: world.record.id },
      fileIds: (await world.sql`select managed_file_id from catalyst_kb.documents`).map((row) =>
        String(row.managed_file_id)
      )
    });
    for (const file of files) await world.objects.delete(file.objectKey);
    await world.sql`delete from catalyst_kb.chunks`;
    await world.sql`update catalyst_kb.contents set state='pending',chunking_revision=null`;
    await enqueueKnowledgeIndex(
      world.instance.stores.jobs,
      {
        knowledgeBaseId: world.record.id,
        contentSha256: String(required(copy).content_sha256),
        fileId: String(required(copy).managed_file_id),
        operationRunId: "operation"
      },
      { clientInstanceId }
    );
    await world.worker.runDue();
    expect(await world.sql`select state from catalyst_kb.contents`).toEqual([
      { state: "extracted" }
    ]);
    expect(fetches).toBe(0);
    expect(
      await world.platform`select count(*)::int as n from audit_events where type='knowledge_base.content_indexed'`
    ).toEqual([{ n: 0 }]);
  });

  it("rolls back the items and page cursor together on an invalid source item", async () => {
    const world = await setup((source) => ({
      ...source,
      async list(input, ctx) {
        const page = await source.list(input, ctx);
        return {
          ...page,
          items: page.items.map((item, index) => (index === 1 ? { ...item, name: "" } : item))
        };
      }
    }));
    for (let i = 0; i < 3; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode("test")
      });
    const run = await world.sync();
    await world.worker.runDue();
    expect(await world.sql`select count(*)::int as n from catalyst_kb.source_items`).toEqual([
      { n: 0 }
    ]);
    expect(await world.sql`select cursor_after from catalyst_kb.sync_runs where id=${run}`).toEqual(
      [{ cursor_after: null }]
    );
    expect(await world.sql`select count(*)::int as n from catalyst_kb.source_cursors`).toEqual([
      { n: 0 }
    ]);
  });

  it("keeps Retry-After independent of an earlier item's longer retry backoff", async () => {
    const calls = new Map<string, number>();
    let released = false;
    const world = await setup((source) => ({
      ...source,
      async *fetch(input, ctx) {
        const attempt = (calls.get(input.itemId) ?? 0) + 1;
        calls.set(input.itemId, attempt);
        if (input.itemId === "f1" || attempt === 1)
          throw new DocumentSourceError("unavailable", "Fixture unavailable");
        if (!released)
          throw new DocumentSourceError("rate_limited", "Wait", { retryAfterMs: 10000 });
        yield* source.fetch(input, ctx);
      }
    }));
    for (let i = 0; i < 2; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode("Text")
      });
    const run = await world.sync();
    await world.worker.runDue();
    await world.worker.runDue();
    await world.platform`update platform_jobs set run_after=now() where status='queued' and kind='knowledge_base.fetch'`;
    await world.worker.runDue();
    expect(
      await world.sql`select item_id,attempts from catalyst_kb.source_items order by item_id`
    ).toEqual([
      { item_id: "f1", attempts: 2 },
      { item_id: "f2", attempts: 1 }
    ]);
    expect(
      await world.platform`select count(*)::int as n from platform_jobs where kind='knowledge_base.fetch' and status='queued' and run_after between now()+interval '5 seconds' and now()+interval '15 seconds'`
    ).toEqual([{ n: 1 }]);
    expect(
      await world.platform`select count(*)::int as n from platform_jobs where kind='knowledge_base.fetch' and status='queued' and run_after > now()+interval '50 seconds'`
    ).toEqual([{ n: 1 }]);
    released = true;
    await world.drain(run);
  });

  it("requeues Retry-After without an attempt and stops a failed listing without withdrawing documents", async () => {
    let limited = true;
    let broken = false;
    const world = await setup((source) => ({
      ...source,
      list(input, ctx) {
        if (broken) throw new DocumentSourceError("unauthorized", "Refused");
        return source.list(input, ctx);
      },
      async *fetch(input, ctx) {
        if (limited)
          throw new DocumentSourceError("rate_limited", "Wait", { retryAfterMs: 120000 });
        yield* source.fetch(input, ctx);
      }
    }));
    world.world.put({
      folderId: "folder",
      name: "a.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("Searchable text")
    });
    const run = await world.sync();
    await world.worker.runDue();
    await world.worker.runDue();
    expect(await world.sql`select attempts, state from catalyst_kb.source_items`).toEqual([
      { attempts: 0, state: "discovered" }
    ]);
    expect(
      await world.platform`select count(*)::int as n from platform_jobs where kind = 'knowledge_base.fetch' and status = 'queued' and run_after > now() + interval '110 seconds'`
    ).toMatchObject([{ n: 1 }]);
    limited = false;
    await world.drain(run);
    broken = true;
    const failed = await world.sync("full");
    await world.worker.runDue();
    expect(
      await world.sql`select state, failure_code from catalyst_kb.sync_runs where id = ${failed}`
    ).toEqual([{ state: "failed", failure_code: "knowledge_source_refused" }]);
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.documents where withdrawn_at is null`
    ).toEqual([{ n: 1 }]);
  });
});
