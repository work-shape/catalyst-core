import { createManagedObjectAccess } from "@work-shape/catalyst-capability-sdk";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  asManagedFileId,
  enqueueKnowledgeIndex,
  knowledgeExtractionKey,
  ObjectNotFound,
  defineKnowledgeExtractHandler,
  knowledgeExtractJob,
  KnowledgeExtractionError,
  type KnowledgeExtractor,
  type Logger,
  readObjectBytes
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/data-store-instance";
import { required, waitUntil } from "./support/assertions";
import { fileTestDatabaseUrl } from "./support/test-database";
import { useKnowledgeSync } from "./support/knowledge-sync";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const bytes = new TextEncoder().encode("Original text from the source.");
const hash = createHash("sha256").update(bytes).digest("hex");

describe("synced originals are released after extraction (KB 76)", () => {
  const { setup } = useKnowledgeSync();

  it.each(["txt", "md"])(
    "releases every %s copy, retains extraction, and reindexes with zero fetch",
    async (extension) => {
      let fetches = 0;
      const world = await setup((source) => ({
        ...source,
        async *fetch(input, context) {
          fetches++;
          yield* source.fetch(input, context);
        }
      }));
      for (let i = 0; i < 2; i++)
        world.world.put({
          folderId: "folder",
          name: `${i}.${extension}`,
          mime: extension === "txt" ? "text/plain" : "text/markdown",
          bytes
        });
      await world.drain(await world.sync());
      const copies = await world.instance.stores.files.listOwnedManagedFilesById({
        clientInstanceId,
        owner: { kind: "knowledge_base", id: world.record.id },
        fileIds: (await world.sql`select managed_file_id from catalyst_kb.documents`).map((row) =>
          String(row.managed_file_id)
        )
      });
      expect(copies).toHaveLength(2);
      for (const copy of copies) {
        expect(copy.status).toBe("released");
        await expect(readObjectBytes(world.objects, copy.objectKey)).rejects.toBeInstanceOf(
          ObjectNotFound
        );
      }
      const extracted = await readObjectBytes(
        world.objects,
        knowledgeExtractionKey(world.record.id, hash)
      );
      expect(new TextDecoder().decode(extracted)).toContain("Original text");
      await world.sql`delete from catalyst_kb.chunks`;
      await world.sql`update catalyst_kb.contents set state='pending', chunking_revision=null`;
      fetches = 0;
      await enqueueKnowledgeIndex(
        world.instance.stores.jobs,
        {
          knowledgeBaseId: world.record.id,
          contentSha256: hash,
          fileId: required(copies[0]).id,
          operationRunId: "operation"
        },
        { clientInstanceId }
      );
      await world.worker.runDue();
      expect(await world.sql`select state from catalyst_kb.contents`).toEqual([
        { state: "extracted" }
      ]);
      expect(await world.sql`select count(*)::int as n from catalyst_kb.chunks`).toEqual([
        { n: 1 }
      ]);
      expect(fetches).toBe(0);
      expect(
        await readObjectBytes(world.objects, knowledgeExtractionKey(world.record.id, hash))
      ).toEqual(extracted);
    }
  );

  it("releases later copies even when their index handoff joins an already queued job", async () => {
    const world = await setup();
    world.world.put({ folderId: "folder", name: "first.txt", mime: "text/plain", bytes });
    await world.drain(await world.sync());
    const [existing] = await world.sql`select managed_file_id from catalyst_kb.documents`;
    await enqueueKnowledgeIndex(
      world.instance.stores.jobs,
      {
        knowledgeBaseId: world.record.id,
        contentSha256: hash,
        fileId: String(required(existing).managed_file_id),
        operationRunId: "operation"
      },
      { clientInstanceId, dedupe: true, runAfter: new Date(Date.now() + 86_400_000) }
    );
    world.world.put({ folderId: "folder", name: "later.txt", mime: "text/plain", bytes });
    await world.drain(await world.sync("full"));
    expect(
      await world.platform`select status from managed_files where owner_id=${world.record.id}`
    ).toEqual([{ status: "released" }, { status: "released" }]);
    const originals =
      await world.platform`select object_key from managed_files where owner_id=${world.record.id}`;
    for (const copy of originals)
      await expect(readObjectBytes(world.objects, String(copy.object_key))).rejects.toBeInstanceOf(
        ObjectNotFound
      );
  });

  it.each([
    [false, "run"],
    [true, "run"],
    [false, "exhausted"],
    [true, "exhausted"]
  ] as const)(
    "releases a PDF and preserves its result through a delayed extract (failed=%s, %s)",
    async (fails, settlement) => {
      const extract = vi.fn(async () => {
        if (fails) throw new KnowledgeExtractionError("knowledge_file_unreadable", "Unreadable");
        return { pages: [{ page: 1, text: "PDF retained text" }] };
      });
      const extractor: KnowledgeExtractor = { revision: 1, extract };
      const world = await setup(undefined, extractor);
      world.world.put({ folderId: "folder", name: "source.pdf", mime: "application/pdf", bytes });
      await world.drain(await world.sync());
      const [row] =
        await world.platform`select id, status, object_key from managed_files where owner_id=${world.record.id}`;
      const copy = required(row);
      expect(copy.status).toBe("released");
      await expect(readObjectBytes(world.objects, String(copy.object_key))).rejects.toBeInstanceOf(
        ObjectNotFound
      );
      const result = await readObjectBytes(
        world.objects,
        knowledgeExtractionKey(world.record.id, hash)
      );
      expect(new TextDecoder().decode(result)).toContain(
        fails ? "knowledge_file_unreadable" : "PDF retained text"
      );
      // A delayed extractor must leave the committed result unchanged after release.
      const handler = defineKnowledgeExtractHandler({
        clientInstanceId,
        objects: world.objects,
        extractor,
        maxPages: 500,
        slots: 1
      });
      const delayed = createJobWorker({
        clientInstanceId,
        stores: world.instance.stores,
        handlers: [handler],
        logger: silent
      });
      try {
        const job = await world.instance.stores.jobs.enqueue(
          knowledgeExtractJob,
          {
            knowledgeBaseId: world.record.id,
            contentSha256: hash,
            fileId: String(copy.id),
            operationRunId: "operation",
            format: "pdf"
          },
          { clientInstanceId }
        );
        if (settlement === "exhausted") {
          const exhausted = required(handler.bind(job).onExhausted);
          await world.instance.stores.transaction((stores) => exhausted(stores));
        } else {
          await delayed.runDue();
        }
      } finally {
        await delayed.stop();
      }
      expect(extract).toHaveBeenCalledTimes(1);
      expect(
        await world.platform`select kind from platform_jobs where kind='knowledge_base.index' and status='queued'`
      ).toEqual([{ kind: "knowledge_base.index" }]);
      expect(
        await readObjectBytes(world.objects, knowledgeExtractionKey(world.record.id, hash))
      ).toEqual(result);
    }
  );

  it.each(["pdf", "txt"])(
    "failed synced %s first, hand-added copy later: Retry extracts the available copy",
    async (format) => {
      const extract = vi.fn(async () => {
        if (extract.mock.calls.length === 1)
          throw new KnowledgeExtractionError("knowledge_extraction_failed", "Down");
        return { pages: [{ page: 1, text: "PDF text from the hand copy" }] };
      });
      const world = await setup(undefined, { revision: 1, extract });
      const original = format === "pdf" ? bytes : new Uint8Array([0xff, 0x00, 0xff]);
      const contentHash = createHash("sha256").update(original).digest("hex");
      world.world.put({
        folderId: "folder",
        name: `synced.${format}`,
        mime: format === "pdf" ? "application/pdf" : "text/plain",
        bytes: original
      });
      await world.drain(await world.sync());
      expect(await world.sql`select state from catalyst_kb.contents`).toEqual([
        { state: "failed" }
      ]);
      expect(
        await world.platform`select status from managed_files where owner_id=${world.record.id}`
      ).toEqual([{ status: "released" }]);
      // More than one source-selection batch of released identities must not hide the
      // later available copy. These documents all reference the already released original.
      if (format === "pdf")
        await world.sql`insert into catalyst_kb.documents (id, managed_file_id, content_sha256, title, file_name)
          select '!released-' || n, d.managed_file_id, d.content_sha256, d.title, d.file_name
          from catalyst_kb.documents d cross join generate_series(1, 100) n`;
      const hand = await world.instance.stores.files.createManagedFile({
        clientInstanceId,
        ownerUserId: "user-1",
        owner: { kind: "knowledge_base", id: world.record.id },
        filename: `hand.${format}`,
        mimeType: format === "pdf" ? "application/pdf" : "text/plain",
        byteSize: original.length,
        checksum: contentHash,
        objectKey: `knowledge-bases/${world.record.id}/hand-retry`
      });
      await world.objects.put(hand.objectKey, original);
      await world.sql`insert into catalyst_kb.documents (id, managed_file_id, content_sha256, title, file_name, added_at)
        values ('hand', ${hand.id}, ${contentHash}, 'hand', ${`hand.${format}`}, now() + interval '1 minute')`;
      const retried = await world.instance.api.call("knowledge_bases.retry_documents", {
        params: { knowledgeBase: "sync-test" },
        payload: { documentIds: ["hand"] }
      });
      expect(retried.statusCode, retried.body).toBe(200);
      for (let i = 0; i < 8; i++) await world.worker.runDue();
      expect(await world.sql`select state, failure_code from catalyst_kb.contents`).toEqual([
        format === "pdf"
          ? { state: "extracted", failure_code: null }
          : { state: "failed", failure_code: "knowledge_text_unreadable" }
      ]);
      if (format === "pdf") expect(extract).toHaveBeenCalledTimes(2);
      expect(await readObjectBytes(world.objects, hand.objectKey)).toEqual(original);
      expect(
        (await world.instance.stores.files.getManagedFile({ clientInstanceId, fileId: hand.id }))
          ?.status
      ).toBe("available");
    }
  );

  it.each(["pdf", "txt"])(
    "re-indexing %s without retained extraction or an available original fails plainly",
    async (format) => {
      const extract = vi.fn(async () => ({ pages: [{ page: 1, text: "Retained text" }] }));
      const world = await setup(undefined, { revision: 1, extract });
      world.world.put({
        folderId: "folder",
        name: `synced.${format}`,
        mime: format === "pdf" ? "application/pdf" : "text/plain",
        bytes
      });
      await world.drain(await world.sync());
      const [document] = await world.sql`select managed_file_id from catalyst_kb.documents`;
      await world.objects.delete(knowledgeExtractionKey(world.record.id, hash));
      await world.sql`delete from catalyst_kb.chunks`;
      await world.sql`update catalyst_kb.contents set state='pending', chunking_revision=null`;
      await enqueueKnowledgeIndex(
        world.instance.stores.jobs,
        {
          knowledgeBaseId: world.record.id,
          contentSha256: hash,
          fileId: String(required(document).managed_file_id),
          operationRunId: "operation"
        },
        { clientInstanceId }
      );
      for (let i = 0; i < 8; i++) await world.worker.runDue();
      expect(await world.sql`select state, failure_code from catalyst_kb.contents`).toEqual([
        { state: "failed", failure_code: "knowledge_file_missing" }
      ]);
      expect(extract).toHaveBeenCalledTimes(format === "pdf" ? 1 : 0);
      expect(
        await world.platform`select kind from platform_jobs where kind in ('knowledge_base.extract', 'knowledge_base.index') and status in ('queued', 'running')`
      ).toEqual([]);
    }
  );

  it("keeps original bytes and committed text when a worker is SIGKILLed before delete", async () => {
    const world = await setup();
    world.world.put({ folderId: "folder", name: "killed.txt", mime: "text/plain", bytes });
    const run = await world.sync();
    await world.worker.runDue();
    await world.worker.runDue();
    // Listing then fetch are done; index is still queued for this separate worker.
    const child = spawn(
      process.execPath,
      ["--experimental-import-meta-resolve", "tests/support/knowledge-release-worker.mjs"],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          KB13A_DATABASE_URL: await fileTestDatabaseUrl(),
          KB13A_FILES_ROOT: world.instance.filesRoot
        }
      }
    );
    let ready = false;
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors += String(chunk);
    });
    child.on("message", (message) => {
      if (message === "before_delete") ready = true;
    });
    try {
      await waitUntil(
        () => {
          if (child.exitCode !== null) throw new Error(errors);
          return ready;
        },
        "terminal commit before original deletion",
        60_000
      );
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      expect(await world.sql`select state from catalyst_kb.contents`).toEqual([
        { state: "extracted" }
      ]);
      expect(
        new TextDecoder().decode(
          await readObjectBytes(world.objects, knowledgeExtractionKey(world.record.id, hash))
        )
      ).toContain("Original text");
      const [copy] =
        await world.platform`select object_key from managed_files where owner_id=${world.record.id}`;
      expect(await readObjectBytes(world.objects, String(required(copy).object_key))).toEqual(
        bytes
      );
      await world.platform`update platform_jobs set lease_expires_at=now()-interval '1 second' where kind='knowledge_base.delete_originals' and status='running'`;
      // The next pass queues the deletion again after its ten-second backoff, which the test
      // does not wait out.
      await world.worker.runDue();
      await world.platform`update platform_jobs set run_after=now() where kind='knowledge_base.delete_originals' and status='queued'`;
      await world.drain(run);
      await expect(
        readObjectBytes(world.objects, String(required(copy).object_key))
      ).rejects.toBeInstanceOf(ObjectNotFound);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 90_000);

  it("answers a released file plainly without reading its missing object, keeps Documents, and refuses local removal", async () => {
    const world = await setup(undefined, undefined, true);
    world.world.put({ folderId: "folder", name: "released.txt", mime: "text/plain", bytes });
    await world.drain(await world.sync());
    const [row] = await world.sql`select id, managed_file_id from catalyst_kb.documents`;
    const document = required(row);
    const reader = createManagedObjectAccess({
      clientInstanceId,
      files: world.instance.stores.files,
      byteStore: world.objects,
      keyFactory: { createFileObjectKey: () => "unused", createArtifactObjectKey: () => "unused" }
    });
    const get = vi.spyOn(world.objects, "get");
    await expect(
      reader.readFile({ fileId: asManagedFileId(String(document.managed_file_id)) })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "Original liegt in der Quelle",
      details: { reason: "knowledge_original_released" }
    });
    expect(get).not.toHaveBeenCalled();
    // With an authorized reader wired, the HTTP route exposes the source notice plainly.
    const created = await world.instance.api.call("conversations.create", {
      payload: { title: "Reader boundary" }
    });
    expect(created.statusCode, created.body).toBe(200);
    const conversation = created.json<{ id: string }>();
    const opened = await world.instance.api.call("conversations.files.get_content", {
      params: { conversationId: conversation.id, fileId: String(document.managed_file_id) }
    });
    expect(opened.statusCode, opened.body).toBe(409);
    expect(opened.body).toContain("Original liegt in der Quelle");
    expect(opened.body).not.toContain("ObjectNotFound");
    const listed = await world.instance.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: "sync-test" }
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({
      documents: [
        { id: document.id, state: "indexed", originalStatus: "released", bytes: bytes.length }
      ]
    });
    const removed = await world.instance.api.call("knowledge_bases.remove_documents", {
      params: { knowledgeBase: "sync-test" },
      payload: { documentIds: [String(document.id)] }
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.body).toContain("knowledge_synced_document_remove_refused");
  });

  it("releases failed, unreadable text and keeps its failure visible on Documents", async () => {
    const world = await setup();
    world.world.put({
      folderId: "folder",
      name: "bad.txt",
      mime: "text/plain",
      bytes: new Uint8Array([0xff, 0x00, 0xff])
    });
    await world.drain(await world.sync());
    const [copy] =
      await world.platform`select status, object_key from managed_files where owner_id=${world.record.id}`;
    expect(copy?.status).toBe("released");
    await expect(
      readObjectBytes(world.objects, String(required(copy).object_key))
    ).rejects.toBeInstanceOf(ObjectNotFound);
    const listed = await world.instance.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: "sync-test" }
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({
      documents: [{ state: "failed", failureCode: "knowledge_text_unreadable", bytes: 3 }]
    });
  });

  it("keeps the separately owned hand-added copy of the same hash readable through cleanup", async () => {
    const world = await setup();
    const hand = await world.instance.stores.files.createManagedFile({
      clientInstanceId,
      ownerUserId: "user-1",
      owner: { kind: "knowledge_base", id: world.record.id },
      filename: "hand.txt",
      mimeType: "text/plain",
      byteSize: bytes.length,
      checksum: hash,
      objectKey: `knowledge-bases/${world.record.id}/hand`
    });
    await world.objects.put(hand.objectKey, bytes);
    await world.sql`insert into catalyst_kb.contents (sha256, format) values (${hash}, 'txt')`;
    await world.sql`insert into catalyst_kb.documents (id, managed_file_id, content_sha256, title, file_name) values ('hand', ${hand.id}, ${hash}, 'hand', 'hand.txt')`;
    await enqueueKnowledgeIndex(
      world.instance.stores.jobs,
      {
        knowledgeBaseId: world.record.id,
        contentSha256: hash,
        fileId: hand.id,
        operationRunId: "operation"
      },
      { clientInstanceId }
    );
    await world.worker.runDue();
    expect(await world.sql`select state from catalyst_kb.contents`).toEqual([
      { state: "extracted" }
    ]);
    // Upload-only TXT has no extraction object yet. Joining the synced copy must persist it
    // before release, despite the shared content already being indexed.
    await expect(
      world.objects.head(knowledgeExtractionKey(world.record.id, hash))
    ).rejects.toBeInstanceOf(ObjectNotFound);
    world.world.put({ folderId: "folder", name: "synced.txt", mime: "text/plain", bytes });
    await world.drain(await world.sync());
    await world.platform`update platform_jobs set run_after=now() where kind='knowledge_base.clean_files' and status='queued'`;
    await world.worker.runDue();
    expect(
      (await world.instance.stores.files.getManagedFile({ clientInstanceId, fileId: hand.id }))
        ?.status
    ).toBe("available");
    expect(await readObjectBytes(world.objects, hand.objectKey)).toEqual(bytes);
    const reader = createManagedObjectAccess({
      clientInstanceId,
      files: world.instance.stores.files,
      byteStore: world.objects,
      keyFactory: { createFileObjectKey: () => "unused", createArtifactObjectKey: () => "unused" }
    });
    expect((await reader.readFile({ fileId: hand.id })).bytes).toEqual(bytes);
    expect(
      new TextDecoder().decode(
        await readObjectBytes(world.objects, knowledgeExtractionKey(world.record.id, hash))
      )
    ).toContain("Original text");
    expect(
      await world.platform`select status from managed_files where owner_id=${world.record.id} and id<>${hand.id}`
    ).toEqual([{ status: "released" }]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toEqual([
      { n: 2 }
    ]);
  });

  it("commits text before deleting bytes and recovers the durable deletion job", async () => {
    const world = await setup();
    world.world.put({ folderId: "folder", name: "interrupted.txt", mime: "text/plain", bytes });
    let reachedDelete = false;
    const original = world.objects.delete.bind(world.objects);
    const deletion = vi.spyOn(world.objects, "delete").mockImplementation(async (key) => {
      if (!key.includes("/extracted/")) {
        reachedDelete = true;
        expect(await world.sql`select state from catalyst_kb.contents`).toEqual([
          { state: "extracted" }
        ]);
        expect(
          new TextDecoder().decode(
            await readObjectBytes(world.objects, knowledgeExtractionKey(world.record.id, hash))
          )
        ).toContain("Original text");
        throw new Error("worker interrupted before object deletion");
      }
      return original(key);
    });
    const run = await world.sync();
    await waitUntil(
      async () => {
        await world.worker.runDue();
        return reachedDelete;
      },
      "object deletion after terminal commit",
      60_000
    );
    expect(reachedDelete).toBe(true);
    const [row] =
      await world.platform`select id, object_key from managed_files where owner_id=${world.record.id}`;
    const copy = required(row);
    expect(await readObjectBytes(world.objects, String(copy.object_key))).toEqual(bytes);
    deletion.mockRestore();
    await world.platform`update platform_jobs set run_after=now() where kind='knowledge_base.delete_originals' and status='queued'`;
    await enqueueKnowledgeIndex(
      world.instance.stores.jobs,
      {
        knowledgeBaseId: world.record.id,
        contentSha256: hash,
        fileId: asManagedFileId(String(copy.id)),
        operationRunId: "operation"
      },
      { clientInstanceId }
    );
    await world.drain(run);
    await expect(readObjectBytes(world.objects, String(copy.object_key))).rejects.toBeInstanceOf(
      ObjectNotFound
    );
    expect(await world.platform`select status from managed_files where id=${copy.id}`).toEqual([
      { status: "released" }
    ]);
  });

  it("Retry of a failed, released synced document fetches the source again and ends indexed", async () => {
    let fetches = 0;
    const extract = vi
      .fn<KnowledgeExtractor["extract"]>()
      .mockRejectedValueOnce(
        new KnowledgeExtractionError("knowledge_extraction_failed", "Extractor unavailable")
      )
      .mockResolvedValue({ pages: [{ page: 1, text: "Text after the refetch" }] });
    const world = await setup(
      (source) => ({
        ...source,
        async *fetch(input, context) {
          fetches++;
          yield* source.fetch(input, context);
        }
      }),
      { revision: 1, extract }
    );
    world.world.put({ folderId: "folder", name: "retry.pdf", mime: "application/pdf", bytes });
    await world.drain(await world.sync());
    const [failed] = await world.sql`select d.id, d.managed_file_id, c.state, c.failure_code
      from catalyst_kb.documents d join catalyst_kb.contents c on c.sha256 = d.content_sha256`;
    expect(failed).toMatchObject({ state: "failed", failure_code: "knowledge_extraction_failed" });
    const before =
      await world.platform`select status, object_key from managed_files where id=${String(required(failed).managed_file_id)}`;
    expect(before).toMatchObject([{ status: "released" }]);
    await expect(
      readObjectBytes(world.objects, String(required(before[0]).object_key))
    ).rejects.toBeInstanceOf(ObjectNotFound);
    expect(fetches).toBe(1);

    const retried = await world.instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: "sync-test" },
      payload: { documentIds: [String(required(failed).id)] }
    });
    expect(retried.statusCode, retried.body).toBe(200);
    const [again] = await world.sql`select id from catalyst_kb.sync_runs where state='running'`;
    await world.drain(String(required(again).id));

    // The original came from the source again, was extracted, and was released again.
    expect(fetches).toBe(2);
    expect(extract).toHaveBeenCalledTimes(2);
    const [indexed] = await world.sql`select d.managed_file_id, c.state, c.failure_code
      from catalyst_kb.documents d join catalyst_kb.contents c on c.sha256 = d.content_sha256`;
    expect(indexed).toMatchObject({ state: "extracted", failure_code: null });
    const listed = await world.instance.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: "sync-test" }
    });
    expect(listed.json()).toMatchObject({
      documents: [{ state: "indexed", originalStatus: "released" }]
    });
    const originals =
      await world.platform`select status, object_key from managed_files where owner_id=${world.record.id} and status <> 'deleted'`;
    for (const copy of originals) {
      expect(copy.status).toBe("released");
      await expect(readObjectBytes(world.objects, String(copy.object_key))).rejects.toBeInstanceOf(
        ObjectNotFound
      );
    }
    expect(
      new TextDecoder().decode(
        await readObjectBytes(world.objects, knowledgeExtractionKey(world.record.id, hash))
      )
    ).toContain("Text after the refetch");
  });
});
