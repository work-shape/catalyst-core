import { spawn } from "node:child_process";
import { once } from "node:events";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  DocumentSourceError,
  KNOWLEDGE_FILE_MAX_BYTES,
  knowledgeFetchJob,
  knowledgeExtractionKey,
  knowledgeExtractionResultSchema,
  readObjectBytes,
  enqueueKnowledgeIndex
} from "@work-shape/catalyst-core";
import { eventually, required, waitUntil } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { useKnowledgeSync } from "./support/knowledge-sync";
const KB = "sync-test";
const SOURCE = "source";
describe("initial and full source import (KB 72, 73)", () => {
  const { setup } = useKnowledgeSync();
  it("queues 101 ids once across listing 429 resumes and splits duplicate batches without orphan copies", async () => {
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
    for (let i = 0; i < 101; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode("shared text")
      });
    const run = await world.sync();
    for (let page = 0; page < 2; page++) {
      await world.platform`update platform_jobs set run_after=now() where kind='knowledge_base.sync' and status='queued'`;
      await world.worker.runDue();
    }
    const queued =
      await world.platform`select payload from platform_jobs where kind='knowledge_base.fetch' and status='queued'`;
    expect(queued).toHaveLength(2);
    const payloads = queued.map((row) => knowledgeFetchJob.payloadSchema.parse(row.payload));
    expect(payloads.flatMap((payload) => payload.sourceItemIds)).toHaveLength(101);
    const ids = payloads.flatMap((payload) => payload.sourceItemIds);
    expect(new Set(ids).size).toBe(101);
    expect(listCalls).toBe(3);
    // Park the normal queue, then start two identical batches together. Hold the first
    // stream until released: the claim must let the batches fetch each item once between
    // them, and removing the claim predicate must produce duplicate calls.
    await world.platform`update platform_jobs set run_after=now()+interval '1 day' where kind='knowledge_base.fetch' and status='queued'`;
    const first = required(payloads.find((batch) => batch.sourceItemIds.length >= 4));
    const payload = { ...first, sourceItemIds: first.sourceItemIds.slice(0, 4) };
    for (let duplicate = 0; duplicate < 2; duplicate++)
      await world.instance.stores.jobs.enqueue(knowledgeFetchJob, payload, { clientInstanceId });
    release = true;
    const racing = world.worker.runDue();
    try {
      await eventually(() =>
        expect([...calls.values()].reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(1)
      );
    } finally {
      unblock();
      await racing;
    }
    expect(calls.size).toBe(4);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    await world.drain(run);
    expect(calls.size).toBe(101);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    expect(
      await world.platform`select count(*)::int as n from managed_files where owner_id=${world.record.id}`
    ).toEqual([{ n: 101 }]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toEqual([
      { n: 101 }
    ]);
  });

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
      {
        state: "failed",
        failure_code: "knowledge_fetch_failed",
        attempts: knowledgeFetchJob.maxAttempts
      }
    ]);
    expect(
      await world.platform`select count(*)::int as n from managed_files where owner_id=${world.record.id}`
    ).toEqual([{ n: 0 }]);
    expect((await world.objects.list(`knowledge-bases/${world.record.id}/`)).objects).toHaveLength(
      0
    );
    const status = await world.instance.api.call("knowledge_bases.sources", {
      params: { knowledgeBase: KB }
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({
      sources: [
        {
          items: { failed: 2 },
          failures: [{ code: "knowledge_fetch_failed", count: 2 }]
        }
      ]
    });
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

  it("resumes after SIGKILL with one platform connection and no duplicate items, documents, contents or chunks", async () => {
    const world = await setup();
    for (let i = 0; i < 150; i++)
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
      expect(committed?.n).toBeLessThan(150);
      // The lease of a dead process expires; the replacement claims the same persisted job.
      await world.platform`update platform_jobs set lease_expires_at = now() - interval '1 second' where kind in ('knowledge_base.sync', 'knowledge_base.fetch') and status = 'running'`;
      await world.drain(run);
      for (const table of ["source_items", "documents"]) {
        const rows = await world.sql.unsafe(
          `select count(*)::int as n, count(distinct id)::int as unique_n from catalyst_kb.${table}`
        );
        expect(rows).toMatchObject([{ n: 150, unique_n: 150 }]);
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
    expect(world.embed).toHaveBeenCalled();
    world.embed.mockClear();
    await world.drain(await world.sync("full"));
    expect(fetches).toBe(0);
    expect(world.embed).not.toHaveBeenCalled();
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
