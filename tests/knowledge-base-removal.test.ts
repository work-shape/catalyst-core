import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { z } from "zod";
import { createJobWorker, createLogger } from "@work-shape/catalyst-client-assembly";
import {
  asManagedFileId,
  defineKnowledgeExtractHandler,
  knowledgeExtractionKey,
  KNOWLEDGE_BASE_ASSET_KIND,
  type DataStoreRecord,
  type KnowledgeExtractor,
  type Logger
} from "@work-shape/catalyst-core";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { eventually, required } from "./support/assertions";
import {
  createManagedObjectTestAttachmentCapability,
  createMultipartFilePayload
} from "./support/chat-server-attachment-harness";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { getTestJobs } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { registerKnowledgeRemovalVolumeTest } from "./support/knowledge-removal-volume";

// KB-5e: checks 59, 60 and 62. Search's same-statement withdrawn filter and citation chips
// belong to KB-7; here the authoritative document rows and listing prove withdrawal.
const KB = "removal";
const MARKER = "private-marker-never-in-observability";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const addedSchema = z.object({
  documents: z.array(z.object({ id: z.string(), fileId: z.string() }))
});
const listSchema = z.object({ documents: z.array(z.object({ id: z.string() })) });
const auth = {
  enabled: true,
  users: [
    { id: "user-1", roles: ["user", "admin", "superadmin"] },
    { id: "reader", roles: ["user"] }
  ].map((user) => ({ ...user, externalUserId: user.id, displayLabel: user.id, permissionRefs: [] }))
};

async function inStore<T>(record: DataStoreRecord, work: (sql: postgres.Sql) => Promise<T>) {
  const url = new URL(await fileTestDatabaseUrl());
  url.pathname = `/${record.location.database}`;
  const sql = postgres(url.toString(), { max: 1, onnotice() {} });
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}

async function add(world: DataStoreInstance, content = MARKER, filename = `${MARKER}.txt`) {
  const conversation = await world.api.call("conversations.create", {
    payload: { title: "Documents" }
  });
  const conversationId = z.object({ id: z.string() }).parse(conversation.json()).id;
  const upload = createMultipartFilePayload({
    fieldName: "file",
    filename,
    contentType: "text/plain",
    content
  });
  const uploaded = await world.api.call("conversations.draft_attachments.upload", {
    params: { conversationId },
    headers: upload.headers,
    payload: upload.payload
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  const originalFileId = z
    .object({ attachment: z.object({ fileId: z.string() }) })
    .parse(uploaded.json()).attachment.fileId;
  const added = await world.api.call("knowledge_bases.add_files", {
    params: { knowledgeBase: KB },
    payload: { files: [{ conversationId, fileId: originalFileId }] }
  });
  expect(added.statusCode, added.body).toBe(200);
  return {
    ...required(addedSchema.parse(added.json()).documents[0]),
    originalFileId,
    conversationId
  };
}
const remove = (world: DataStoreInstance, documentIds: string[], headers = {}) =>
  world.api.call("knowledge_bases.remove_documents", {
    params: { knowledgeBase: KB },
    payload: { documentIds },
    headers
  });
const getFile = (world: DataStoreInstance, fileId: string) =>
  world.stores.files.getManagedFile({ clientInstanceId, fileId: asManagedFileId(fileId) });
const runJobs = (world: DataStoreInstance) => getTestJobs(world.api).runDue();
const deleteKnowledgeBase = (world: DataStoreInstance) =>
  world.api.call("assets.delete", {
    params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
    payload: { expectedRevision: 1 }
  });
async function platformSql<T>(work: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}
/** Makes a removal job waiting for its backoff due now, without a wall-clock sleep. */
const removalDueNow = () =>
  platformSql(
    (sql) =>
      sql`update platform_jobs set run_after = now()
        where kind = 'knowledge_base.remove_documents' and status = 'queued'`
  );
const purgeEvents = async (world: DataStoreInstance) =>
  world.stores.audit.listAuditEvents({ clientInstanceId, type: "knowledge_base.deleted" });

function captureLogger() {
  const lines: unknown[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args);
  };
  const logger: Logger = createLogger();
  for (const method of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(logger, method).mockImplementation(record);
  }
  vi.spyOn(logger, "child").mockReturnValue(logger);
  return { logger, lines };
}

describe("removing documents from a Knowledge Base", () => {
  const { start } = useDataStoreInstance();
  afterEach(() => vi.restoreAllMocks());
  async function setup() {
    const log = captureLogger();
    const world = await start(true, undefined, auth, undefined, {
      attachments: createManagedObjectTestAttachmentCapability().capability,
      documents: true
    });
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    expect(
      (
        await world.api.call("assets.put", {
          params,
          payload: {
            config: {
              name: KB,
              title: "Documents",
              description: "Removal test",
              methods: ["keyword"]
            },
            expectedRevision: null
          }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (await world.api.call("assets.publish", { params, payload: { revision: 1 } })).statusCode
    ).toBe(200);
    const record = await eventually(async () => {
      await runJobs(world);
      const row = await world.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      });
      expect(row).toMatchObject({ status: "ready", level: 13 });
      return required(row);
    });
    return { world, record, log, objects: createFilesystemObjectStorage(world.filesRoot) };
  }

  it("withdraws immediately, retains shared chunks and extraction, then deletes the last holder and its vectors", async () => {
    const { world, record, objects } = await setup();
    const first = await add(world);
    const shared = await add(world);
    const firstCopy = required(await getFile(world, first.fileId));
    const sharedCopy = required(await getFile(world, shared.fileId));
    await runJobs(world);
    // Generation tables reference chunk ids with cascading deletion, including after KB-5d.
    await inStore(record, async (sql) => {
      await sql`create table catalyst_kb.embeddings_1 (chunk_id text primary key references catalyst_kb.chunks(id) on delete cascade)`;
      await sql`insert into catalyst_kb.embeddings_1 select id from catalyst_kb.chunks`;
    });
    const extraction = knowledgeExtractionKey(record.id, sha256(MARKER));
    await objects.put(extraction, new TextEncoder().encode(MARKER));
    expect((await remove(world, [first.id, first.id])).json()).toMatchObject({ removed: 1 });
    const listed = await world.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: KB }
    });
    expect(listSchema.parse(listed.json()).documents).toEqual([
      expect.objectContaining({ id: shared.id })
    ]);
    // The job has not run: withdrawal is persisted and bytes still exist.
    expect(
      await inStore(
        record,
        (sql) => sql`select id from catalyst_kb.documents where withdrawn_at is not null`
      )
    ).toHaveLength(1);
    await expect(objects.head(firstCopy.objectKey)).resolves.toBeDefined();
    await runJobs(world);
    await expect(objects.head(firstCopy.objectKey)).rejects.toThrow();
    await expect(objects.head(sharedCopy.objectKey)).resolves.toBeDefined();
    await expect(objects.head(extraction)).resolves.toBeDefined();
    expect(await inStore(record, (sql) => sql`select id from catalyst_kb.chunks`)).toHaveLength(1);
    expect(await getFile(world, first.fileId)).toBeUndefined();
    expect(await getFile(world, first.originalFileId)).toBeDefined();
    expect((await remove(world, [shared.id])).statusCode).toBe(200);
    await runJobs(world);
    for (const table of ["contents", "chunks", "documents", "embeddings_1"]) {
      expect(
        await inStore(record, (sql) => sql.unsafe(`select * from catalyst_kb.${table}`))
      ).toHaveLength(0);
    }
    await expect(objects.head(extraction)).rejects.toThrow();
    await expect(objects.head(sharedCopy.objectKey)).rejects.toThrow();
    expect((await remove(world, [shared.id, "missing"])).json()).toMatchObject({ removed: 0 });
  });

  it("rolls back withdrawal if durable enqueue fails and resumes an interrupted purge idempotently", async () => {
    const { world, record, objects } = await setup();
    const doc = await add(world);
    await runJobs(world);
    const enqueue = vi
      .spyOn(world.stores.jobs, "enqueue")
      .mockRejectedValueOnce(new Error("queue unavailable"));
    expect((await remove(world, [doc.id])).statusCode).toBeGreaterThanOrEqual(400);
    enqueue.mockRestore();
    expect(
      await inStore(
        record,
        (sql) => sql`select id from catalyst_kb.documents where withdrawn_at is null`
      )
    ).toHaveLength(1);
    expect((await remove(world, [doc.id])).statusCode).toBe(200);
    // All object-storage instances use this implementation: interrupt after deleting bytes,
    // before content rows commit. The next executor attempt must safely repeat deletion.
    const copy = required(await getFile(world, doc.fileId));
    await objects.delete(copy.objectKey);
    const extraction = knowledgeExtractionKey(record.id, sha256(MARKER));
    await objects.put(extraction, new TextEncoder().encode(MARKER));
    // A directory at the extraction key makes unlink fail after the file deletion.
    await objects.delete(extraction);
    const path = join(world.filesRoot, extraction);
    await mkdir(path, { recursive: true });
    await runJobs(world);
    expect(await inStore(record, (sql) => sql`select id from catalyst_kb.documents`)).toHaveLength(
      1
    );
    await rm(path, { recursive: true });
    const jobs = await world.stores.jobs.listOverview({
      clientInstanceId,
      filters: { kind: "knowledge_base.remove_documents" }
    });
    // Retry the interrupted attempt without a wall-clock sleep.
    const job = required(jobs[0]);
    const db = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      await db`update platform_jobs set run_after = now() where id = ${job.id}`;
    } finally {
      await db.end();
    }
    await runJobs(world);
    expect(await inStore(record, (sql) => sql`select id from catalyst_kb.documents`)).toHaveLength(
      0
    );
    expect(await getFile(world, doc.fileId)).toBeUndefined();
  });

  it("requires write for removal and delete for the Knowledge Base, audits counts, and logs no marker", async () => {
    const { world, record, objects, log } = await setup();
    const doc = await add(world);
    const copy = required(await getFile(world, doc.fileId));
    await runJobs(world);
    const denied = await remove(world, [doc.id], { "x-dev-user-id": "reader" });
    expect(denied.statusCode).toBe(403);
    const reader = required(
      (await world.stores.operationRuns.list({ clientInstanceId })).find(
        (run) => run.actor.label === "reader"
      )
    ).actor;
    expect(
      (
        await world.api.call("permissions.grant", {
          payload: {
            holderKind: "user",
            holderId: reader.id,
            action: "knowledge_base.use",
            scopeKind: "asset",
            scopeId: record.id
          }
        })
      ).statusCode
    ).toBe(200);
    // A user who can read every document still cannot remove one.
    expect(
      (
        await world.api.call("knowledge_bases.list_documents", {
          params: { knowledgeBase: KB },
          headers: { "x-dev-user-id": "reader" }
        })
      ).statusCode
    ).toBe(200);
    expect((await remove(world, [doc.id], { "x-dev-user-id": "reader" })).statusCode).toBe(403);
    const extraction = knowledgeExtractionKey(record.id, sha256(MARKER));
    await objects.put(extraction, new TextEncoder().encode(MARKER));
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const deniedDelete = await world.api.call("assets.delete", {
      params,
      payload: { expectedRevision: 1 },
      headers: { "x-dev-user-id": "reader" }
    });
    expect(deniedDelete.statusCode).toBe(403);
    const deleted = await world.api.call("assets.delete", {
      params,
      payload: { expectedRevision: 1 }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    await eventually(async () => {
      await runJobs(world);
      expect(
        await world.stores.dataStores.getDataStore({ clientInstanceId, id: record.id })
      ).toBeUndefined();
    });
    await expect(objects.head(copy.objectKey)).rejects.toThrow();
    expect(await getFile(world, doc.fileId)).toBeUndefined();
    expect(await getFile(world, doc.originalFileId)).toBeDefined();
    await expect(objects.head(extraction)).rejects.toThrow();
    const events = await world.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "knowledge_base.deleted"
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        subject: record.id,
        metadata: expect.objectContaining({
          documents: 1,
          chunks: 1,
          contents: 1,
          files: 1,
          objects: 2,
          extractionResults: 1
        })
      })
    );
    const db = postgres(await fileTestDatabaseUrl(), { max: 1 });
    try {
      const runs = await db`select * from operation_runs`;
      const audit = await db`select * from audit_events`;
      expect(log.lines.length).toBeGreaterThan(0);
      expect(JSON.stringify(log.lines)).toContain("removal");
      expect(JSON.stringify({ runs, audit, logs: log.lines })).not.toContain(MARKER);
    } finally {
      await db.end();
    }
    // Conversation content survives deletion of its Knowledge Base copy.
    expect(
      (
        await world.api.call("conversations.thread.get", {
          params: { conversationId: doc.conversationId }
        })
      ).statusCode
    ).toBe(200);
  });

  it.each(["removed", "shared", "shared-retry"])(
    "fences extraction after deletion and recovers surviving content (%s)",
    async (mode) => {
      const { world, record, objects } = await setup();
      const doc = await add(world, "pdf content", "document.txt");
      const shared = mode === "removed" ? undefined : await add(world, "pdf content", "shared.txt");
      await inStore(record, (sql) => sql`update catalyst_kb.contents set format = 'pdf'`);
      let release = () => {};
      let started = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entering = new Promise<void>((resolve) => {
        started = resolve;
      });
      const extractor: KnowledgeExtractor = {
        revision: 1,
        async extract() {
          started();
          await gate;
          return { pages: [{ page: 1, text: MARKER }] };
        }
      };
      const worker = createJobWorker({
        stores: world.stores,
        clientInstanceId,
        logger: captureLogger().logger,
        handlers: [
          defineKnowledgeExtractHandler({
            clientInstanceId,
            objects,
            extractor,
            maxPages: 500,
            slots: 1
          })
        ]
      });
      await runJobs(world);
      const extracting = worker.runDue();
      try {
        await entering;
        expect((await remove(world, [doc.id])).statusCode).toBe(200);
        await runJobs(world);
        if (mode === "shared-retry" && shared) {
          expect(
            (
              await world.api.call("knowledge_bases.retry_documents", {
                params: { knowledgeBase: KB },
                payload: { documentIds: [shared.id] }
              })
            ).statusCode
          ).toBe(200);
          await runJobs(world);
          const attempts = await world.stores.jobs.listOverview({
            clientInstanceId,
            filters: { kind: "knowledge_base.extract", statuses: ["queued", "running"] }
          });
          expect(attempts.filter((job) => job.subject === record.id)).toHaveLength(2);
        }
        release();
        await extracting;
        await expect(
          objects.head(knowledgeExtractionKey(record.id, sha256("pdf content")))
        ).rejects.toThrow();
        if (shared) {
          await runJobs(world);
          await worker.runDue();
          await runJobs(world);
          expect(
            await inStore(record, (sql) => sql`select state from catalyst_kb.contents`)
          ).toEqual([{ state: "extracted" }]);
          expect(await inStore(record, (sql) => sql`select text from catalyst_kb.chunks`)).toEqual([
            { text: MARKER }
          ]);
        }
      } finally {
        release();
        await extracting;
        await worker.stop();
      }
    }
  );

  it("purges past an object it cannot delete, ends failed with a code, and finishes on retry", async () => {
    const { world, record, objects } = await setup();
    const docs = [];
    for (let i = 0; i < 3; i += 1)
      docs.push(await add(world, `${MARKER} ${i}`, `document-${i}.txt`));
    await runJobs(world);
    const extraction = (i: number) => knowledgeExtractionKey(record.id, sha256(`${MARKER} ${i}`));
    for (let i = 0; i < 3; i += 1) await objects.put(extraction(i), new TextEncoder().encode("{}"));
    // The last extraction key is a directory, so deleting it fails until it is removed.
    const last = docs.length - 1;
    await objects.delete(extraction(last));
    const failing = join(world.filesRoot, extraction(last));
    await mkdir(failing, { recursive: true });
    const copies = await Promise.all(
      docs.map(async (doc) => required(await getFile(world, doc.fileId)))
    );
    expect((await deleteKnowledgeBase(world)).statusCode).toBe(200);
    await runJobs(world);
    // What could be deleted is deleted and committed; only the failing content stays as its record.
    for (const copy of copies) await expect(objects.head(copy.objectKey)).rejects.toThrow();
    for (let i = 0; i < last; i += 1) await expect(objects.head(extraction(i))).rejects.toThrow();
    expect(
      await inStore(record, (sql) => sql`select content_sha256 from catalyst_kb.documents`)
    ).toEqual([{ content_sha256: sha256(`${MARKER} ${last}`) }]);
    expect(await inStore(record, (sql) => sql`select sha256 from catalyst_kb.contents`)).toEqual([
      { sha256: sha256(`${MARKER} ${last}`) }
    ]);
    expect(
      await platformSql(
        (sql) => sql`select id from managed_files where owner_kind = 'knowledge_base'`
      )
    ).toHaveLength(0);
    // The deletion is visibly failed with a code, and the store waits for its objects.
    expect(
      await world.stores.dataStores.getDataStore({ clientInstanceId, id: record.id })
    ).toMatchObject({ status: "retired", failure: { code: "knowledge_purge_incomplete" } });
    expect(await purgeEvents(world)).toEqual([
      expect.objectContaining({
        status: "failed",
        reason: "knowledge_purge_incomplete",
        metadata: expect.objectContaining({ documents: last, files: docs.length })
      })
    ]);
    expect(
      await world.stores.jobs.listOverview({
        clientInstanceId,
        filters: { kind: "knowledge_base.remove_documents" }
      })
    ).toEqual([expect.objectContaining({ status: "queued", errorCode: "CONFLICT" })]);
    await rm(failing, { recursive: true });
    await removalDueNow();
    await eventually(async () => {
      await runJobs(world);
      expect(
        await world.stores.dataStores.getDataStore({ clientInstanceId, id: record.id })
      ).toBeUndefined();
    });
    await expect(objects.head(extraction(last))).rejects.toThrow();
    expect(await purgeEvents(world)).toContainEqual(
      expect.objectContaining({
        status: "success",
        metadata: expect.objectContaining({ documents: 1, contents: 1, files: 0 })
      })
    );
  });

  it("deletes the Managed File rows of removed copies, so no file name or checksum stays", async () => {
    const { world } = await setup();
    const name = "Mueller-Scheidung-2026.txt";
    const doc = await add(world, "Scheidungsfolgenvereinbarung", name);
    await add(world, "Kaufvertrag", "Kaufvertrag.txt");
    await runJobs(world);
    const copy = required(await getFile(world, doc.fileId));
    expect((await remove(world, [doc.id])).statusCode).toBe(200);
    await runJobs(world);
    const rowsOf = (fileIds: string[]) =>
      platformSql((sql) => sql`select id from managed_files where id = any(${fileIds})`);
    expect(await rowsOf([doc.fileId])).toHaveLength(0);
    expect(
      await platformSql(
        (sql) =>
          sql`select id from managed_files where filename = ${name} or checksum = ${copy.checksum}`
      )
    ).toEqual([{ id: doc.originalFileId }]);
    expect((await deleteKnowledgeBase(world)).statusCode).toBe(200);
    await eventually(async () => {
      await runJobs(world);
      expect(
        await platformSql(
          (sql) => sql`select id from managed_files where owner_kind = 'knowledge_base'`
        )
      ).toHaveLength(0);
    });
    expect(
      await platformSql((sql) => sql`select id from managed_files where filename = ${name}`)
    ).toEqual([{ id: doc.originalFileId }]);
  });

  registerKnowledgeRemovalVolumeTest({ documents: 300, contents: 200, interruptAt: 150 });
});
