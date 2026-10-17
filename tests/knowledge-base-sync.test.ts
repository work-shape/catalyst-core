import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import { createFixtureDocumentSource, loadSecretKeyring } from "@work-shape/catalyst-connections";
import { createDataStores } from "@work-shape/catalyst-data-stores";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import {
  DocumentSourceError,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_FILE_MAX_BYTES,
  knowledgeSyncJob,
  knowledgeSourceKey,
  knowledgeExtractionKey,
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
    const handlers = dataStores.knowledgeSourceJobs({
      files,
      documentFormats: ["txt", "markdown"],
      maxDocuments: 10000,
      openSource: async (_name, signal) => ({ capability, context: context(signal) })
    });
    const worker = createJobWorker({
      clientInstanceId,
      stores: instance.stores,
      handlers,
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
          await jobs.runDue();
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
    return { ...fixture, instance, sql, platform, worker, jobs, sync, drain, objects, record };
  }

  it("imports 10,000 items, isolates three failed fetches, and makes zero fetch or embedding calls on the second full pass", async () => {
    let fetches = 0;
    const world = await setup((source) => ({
      ...source,
      async *fetch(input, ctx) {
        fetches++;
        if (input.itemId === "f1")
          throw new DocumentSourceError("unavailable", "Fixture unavailable");
        yield* source.fetch(input, ctx);
      }
    }));
    for (let i = 0; i < 10000; i++)
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
      { n: 10000 }
    ]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toMatchObject([
      { n: 9999 }
    ]);
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.contents where state = 'extracted'`
    ).toMatchObject([{ n: 1 }]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.chunks`).toMatchObject([
      { n: 1 }
    ]);
    const before = await world.platform`select count(*)::int as n from model_usage_events`;
    fetches = 0;
    await world.drain(await world.sync("full"));
    expect(fetches).toBe(0);
    expect(await world.platform`select count(*)::int as n from model_usage_events`).toEqual(before);
  }, 240_000);

  it("resumes after SIGKILL during a fetch batch without duplicate items, documents, contents or chunks", async () => {
    const world = await setup();
    for (let i = 0; i < 300; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode("Resumed content")
      });
    const run = await world.sync();
    const child = spawn(process.execPath, ["tests/fixtures/knowledge-sync/worker.mjs"], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        SRC1A_DATABASE_URL: await fileTestDatabaseUrl(),
        SRC1A_FILES_ROOT: world.instance.filesRoot
      }
    });
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
      expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toMatchObject([
        { n: expect.any(Number) }
      ]);
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
    expect(
      await world.objects.head(knowledgeExtractionKey(world.record.id, required(content).sha256))
    ).toMatchObject({ contentType: "application/json" });
    const rows = await world.sql`select id, content_sha256 from catalyst_kb.documents order by id`;
    world.world.rename(a, "renamed.md");
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
