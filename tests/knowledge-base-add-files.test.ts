import { createHash } from "node:crypto";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_FILE_MAX_BYTES,
  asConversationId,
  asManagedFileId,
  type DataStoreRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
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

// `knowledge.<id>.add_files` through the assembled instance: a writer adds a file of a
// Conversation they can open, the Knowledge Base gets a copy it owns, and neither the
// Conversation's cleanup nor the orphan sweep removes that copy. Spec:
// data-stores-and-knowledge-bases.md, "Adding files", checks 57 (limits) and 66.

const KB = "objektunterlagen";

const developmentAuth = {
  enabled: true,
  users: [
    { id: "user-1", roles: ["user", "admin", "superadmin"] },
    { id: "member-1", roles: ["user"] }
  ].map((user) => ({ ...user, externalUserId: user.id, displayLabel: user.id, permissionRefs: [] }))
};
const asMember = { "x-dev-user-id": "member-1" };

const FILE_NAME = "Mietvertrag Erika Mustermann.txt";
const FILE_TEXT = "Kaltmiete 1.250 EUR, Kaution drei Monatsmieten.";

const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  })
});
const addedSchema = z.object({
  documents: z.array(z.object({ id: z.string(), fileId: z.string() })),
  count: z.number(),
  bytes: z.number()
});
const uploadedSchema = z.object({ attachment: z.object({ fileId: z.string() }) });

describe("adding files to a Knowledge Base", () => {
  const { start } = useDataStoreInstance();

  /** An instance whose Conversations keep their files through a test capability. */
  async function instanceWithFiles(maxDocuments?: number) {
    const attachments = createManagedObjectTestAttachmentCapability();
    const instance = await start(true, undefined, developmentAuth, undefined, {
      attachments: attachments.capability,
      ...(maxDocuments === undefined ? {} : { maxDocuments })
    });
    const record = await published(instance);
    return { instance, attachments, record };
  }

  /** A keyword Knowledge Base, published, once its store has the platform's tables. */
  async function published(world: DataStoreInstance): Promise<DataStoreRecord> {
    const config: JsonObject = {
      name: KB,
      title: "Objektunterlagen",
      description: "Exposés, plans and contracts of the objects.",
      methods: ["keyword"]
    };
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const written = await world.api.call("assets.put", {
      params,
      payload: { config, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
    const made = await world.api.call("assets.publish", { params, payload: { revision: 1 } });
    expect(made.statusCode, made.body).toBe(200);
    const jobs = getTestJobs(world.api);
    return eventually(async () => {
      await jobs.runDue();
      const record = await world.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      });
      expect(record).toMatchObject({ status: "ready", level: 3 });
      return required(record);
    });
  }

  async function assetId(world: DataStoreInstance): Promise<string> {
    return required(
      await world.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: KB
      })
    ).id;
  }

  /** A Conversation of the caller with one uploaded file. */
  async function conversationWithFile(
    world: DataStoreInstance,
    file: { filename: string; contentType: string; content: string },
    headers: Record<string, string> = {}
  ): Promise<{ conversationId: string; fileId: string }> {
    const created = await world.api.call("conversations.create", {
      payload: { title: "Unterlagen" },
      headers
    });
    expect(created.statusCode, created.body).toBe(200);
    const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
    const upload = createMultipartFilePayload({ fieldName: "file", ...file });
    const uploaded = await world.api.call("conversations.draft_attachments.upload", {
      params: { conversationId },
      headers: { ...upload.headers, ...headers },
      payload: upload.payload
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    return { conversationId, fileId: uploadedSchema.parse(uploaded.json()).attachment.fileId };
  }

  const addFiles = (
    world: DataStoreInstance,
    files: readonly { conversationId: string; fileId: string }[],
    headers: Record<string, string> = {}
  ) =>
    world.api.call("knowledge_bases.add_files", {
      params: { knowledgeBase: KB },
      payload: { files },
      headers
    });

  /** A connection of the test's own to a database of the server, as its superuser. */
  async function inDatabase<T>(
    database: string | undefined,
    read: (sql: postgres.Sql) => Promise<T>
  ) {
    const url = new URL(await fileTestDatabaseUrl());
    if (database !== undefined) url.pathname = `/${database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      return await read(sql);
    } finally {
      await sql.end();
    }
  }

  const documentRows = (record: DataStoreRecord) =>
    inDatabase(
      record.location.database,
      (sql) =>
        sql<
          { managed_file_id: string; content_sha256: string; title: string; file_name: string }[]
        >`select managed_file_id, content_sha256, title, file_name from catalyst_kb.documents
          order by added_at, id`
    );

  /** The status of every file the Knowledge Base owns, in the platform's database. */
  const ownedStatuses = async (world: DataStoreInstance) => {
    const owner = await assetId(world);
    return inDatabase(undefined, async (sql) =>
      (
        await sql<{ status: string }[]>`select status from managed_files
          where owner_kind = 'knowledge_base' and owner_id = ${owner} order by status`
      ).map((row) => row.status)
    );
  };

  /** The object key and status of every file the Knowledge Base owns, by creation. */
  const ownedCopies = async (world: DataStoreInstance) => {
    const owner = await assetId(world);
    return inDatabase(
      undefined,
      (sql) =>
        sql<{ id: string; object_key: string; status: string }[]>`select id, object_key, status
        from managed_files where owner_kind = 'knowledge_base' and owner_id = ${owner}
        order by created_at, id`
    );
  };

  /** Whether the store of files holds an object. */
  const stored = (world: DataStoreInstance, objectKey: string) =>
    access(join(world.filesRoot, ...objectKey.split("/"))).then(
      () => true,
      () => false
    );

  /** The objects the store of files holds under the Knowledge Base's prefix. */
  const storedCopies = async (world: DataStoreInstance) =>
    readdir(join(world.filesRoot, "knowledge-bases", await assetId(world))).catch(() => []);

  it("copies a file the writer can open into one the Knowledge Base owns, which the Conversation's cleanup and the orphan sweep leave alone", async () => {
    const { instance, attachments, record } = await instanceWithFiles();
    const source = await conversationWithFile(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });

    const added = await addFiles(instance, [source]);
    expect(added.statusCode, added.body).toBe(200);
    const { documents, count, bytes } = addedSchema.parse(added.json());
    expect({ count, bytes }).toEqual({ count: 1, bytes: Buffer.byteLength(FILE_TEXT) });
    const copyId = required(documents[0]).fileId;
    expect(copyId).not.toBe(source.fileId);

    const owner = { kind: "knowledge_base", id: await assetId(instance) };
    const sha256 = createHash("sha256").update(FILE_TEXT).digest("hex");
    expect(
      await instance.stores.files.getManagedFile({
        clientInstanceId,
        fileId: asManagedFileId(copyId)
      })
    ).toMatchObject({
      owner,
      status: "available",
      checksum: sha256,
      objectKey: expect.stringMatching(new RegExp(`^knowledge-bases/${owner.id}/kbobj_`))
    });
    expect(await documentRows(record)).toEqual([
      {
        managed_file_id: copyId,
        content_sha256: sha256,
        title: "Mietvertrag Erika Mustermann",
        file_name: FILE_NAME
      }
    ]);

    // The event and the run name ids, a count and bytes: no file name and nothing the file holds.
    const [event, ...more] = await instance.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "knowledge_base.files_added",
      limit: 10
    });
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      status: "success",
      subject: owner.id,
      metadata: { knowledgeBase: KB, fileIds: [copyId], count: 1, bytes }
    });
    const run = required(
      (await instance.stores.operationRuns.list({ clientInstanceId })).find(
        (candidate) => candidate.operation === `knowledge.${KB}.add_files`
      )
    );
    for (const kept of [JSON.stringify(event), JSON.stringify(run)]) {
      expect(kept).not.toContain("Mustermann");
      expect(kept).not.toContain("Kaltmiete");
    }

    // Deleting the Conversation removes its own file and object and leaves the copy (check 66).
    const deleted = await instance.api.call("conversations.delete", {
      params: { conversationId: source.conversationId }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    await eventually(async () => {
      expect(
        await instance.stores.files.getManagedFile({
          clientInstanceId,
          fileId: asManagedFileId(source.fileId)
        })
      ).toBeUndefined();
    });
    expect(attachments.deletedObjectKeys).toEqual([
      expect.stringContaining(`test-files/${source.conversationId}/`)
    ]);
    expect(
      await instance.stores.files.listConversationsPendingObjectCleanup({
        clientInstanceId,
        limit: 10
      })
    ).not.toContain(asConversationId(source.conversationId));

    // The orphan sweep: no active Conversation refers to the copy, and yet it is not an orphan.
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const orphans = await instance.stores.files.listOrphanedManagedFiles({
      clientInstanceId,
      createdBefore: later,
      limit: 1_000
    });
    expect(orphans.map((orphan) => orphan.id)).not.toContain(copyId);
    expect(
      await instance.stores.files.markOrphanedManagedFilesDeleted({
        clientInstanceId,
        fileIds: [asManagedFileId(copyId)],
        createdBefore: later,
        deletedAt: later
      })
    ).toBe(0);
    expect(await ownedStatuses(instance)).toEqual(["available"]);
  });

  // The store a release before SRC-0 made is at level 1. The next start brings it to this
  // release's tables, and adding files goes on as before, without a publish.
  it("adds files to a store an earlier release left at level 1 once the instance starts again, without a publish", async () => {
    const { instance, record } = await instanceWithFiles();
    await inDatabase(record.location.database, (sql) =>
      sql.unsafe(`
        alter table catalyst_kb.documents drop column source_item_id;
        drop table catalyst_kb.source_cursors, catalyst_kb.sync_runs, catalyst_kb.source_items;
        delete from catalyst_kb.migrations where number = 2;`)
    );
    await instance.stores.dataStores.putDataStore({
      ...record,
      level: 1,
      migrations: record.migrations.slice(0, 1)
    });
    const source = await conversationWithFile(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });
    const before = await addFiles(instance, [source]);
    expect(errorSchema.parse(before.json()).error).toMatchObject({
      code: "CONFLICT",
      details: { reason: "knowledge_store_not_ready" }
    });

    // The worker of the next start makes the waiting tick of the upgrade due at once.
    await inDatabase(
      undefined,
      (sql) => sql`update platform_jobs set run_after = now()
        where kind = 'data_store.upgrade_owned' and client_instance_id = ${clientInstanceId}
        and status = 'queued'`
    );
    const jobs = getTestJobs(instance.api);
    const upgraded = await eventually(async () => {
      await jobs.runDue();
      const current = await instance.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      });
      expect(current).toMatchObject({ status: "ready", level: 3 });
      return required(current);
    });
    expect(upgraded.migrations.map(({ number }) => number)).toEqual([1, 2, 3]);

    const added = await addFiles(instance, [source]);
    expect(added.statusCode, added.body).toBe(200);
    const copyId = required(addedSchema.parse(added.json()).documents[0]).fileId;
    expect(await documentRows(upgraded)).toEqual([
      {
        managed_file_id: copyId,
        content_sha256: createHash("sha256").update(FILE_TEXT).digest("hex"),
        title: "Mietvertrag Erika Mustermann",
        file_name: FILE_NAME
      }
    ]);
  });

  it("refuses a caller without `knowledge_base.write`, and copies nothing", async () => {
    const { instance } = await instanceWithFiles();
    const source = await conversationWithFile(
      instance,
      { filename: "notes.txt", contentType: "text/plain", content: "member notes" },
      asMember
    );

    const refused = await addFiles(instance, [source], asMember);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      action: KNOWLEDGE_BASE_ACTIONS.write
    });
    expect(
      await instance.stores.audit.listAuditEvents({
        clientInstanceId,
        type: "knowledge_base.files_added",
        limit: 10
      })
    ).toEqual([]);
  });

  it("answers a file the writer cannot open as one that does not exist", async () => {
    const { instance } = await instanceWithFiles();
    const own = await conversationWithFile(
      instance,
      { filename: "notes.txt", contentType: "text/plain", content: "member notes" },
      asMember
    );
    // The member as the sign-in made them, named by the run of a call they may not make yet.
    expect((await addFiles(instance, [own], asMember)).statusCode).toBe(403);
    const member = required(
      (await instance.stores.operationRuns.list({ clientInstanceId })).find(
        (run) => run.actor.label === "member-1"
      )
    ).actor;
    const granted = await instance.api.call("permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: member.id,
        action: KNOWLEDGE_BASE_ACTIONS.write,
        scopeKind: "asset",
        scopeId: await assetId(instance)
      }
    });
    expect(granted.statusCode, granted.body).toBe(200);
    // A file of the administrator's own Conversation, which the member cannot read.
    const foreign = await conversationWithFile(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });
    const missing = { conversationId: own.conversationId, fileId: "file_missing" };

    const answers = [];
    for (const ref of [foreign, missing]) {
      const refused = await addFiles(instance, [ref], asMember);
      expect(refused.statusCode, refused.body).toBe(404);
      const { error } = errorSchema.parse(refused.json());
      expect(error.details).toEqual({ reason: "knowledge_file_not_available" });
      expect(refused.body).not.toContain("Mustermann");
      answers.push(error.message.replace(ref.fileId, "<file>").replace(ref.conversationId, "<c>"));
    }
    // The two answers differ only in the ids the caller sent.
    expect(answers[0]).toBe(answers[1]);

    const added = await addFiles(instance, [own], asMember);
    expect(added.statusCode, added.body).toBe(200);
  });

  it("refuses a file over each limit with a stable code and keeps no copy of it", async () => {
    const { instance } = await instanceWithFiles(2);
    const reasonOf = async (files: readonly { conversationId: string; fileId: string }[]) => {
      const refused = await addFiles(instance, files);
      expect(refused.statusCode, refused.body).toBe(422);
      return errorSchema.parse(refused.json()).error.details?.reason;
    };

    const csv = await conversationWithFile(instance, {
      filename: "objekte.csv",
      contentType: "text/csv",
      content: "a,b"
    });
    expect(await reasonOf([csv])).toBe("knowledge_file_format_unsupported");

    // Without document processing, PDF and DOCX wait for nothing that could read them.
    const pdf = await conversationWithFile(instance, {
      filename: "expose.pdf",
      contentType: "application/pdf",
      content: "%PDF-1.7"
    });
    expect(await reasonOf([pdf])).toBe("knowledge_file_format_unavailable");

    // A file larger than a Knowledge Base takes, as its attachment states it: refused unread.
    const large = await conversationWithFile(instance, {
      filename: "grundriss.txt",
      contentType: "text/plain",
      content: "plan"
    });
    const attachment = required(
      await instance.stores.files.findConversationAttachmentByFile({
        clientInstanceId,
        conversationId: asConversationId(large.conversationId),
        fileId: asManagedFileId(large.fileId)
      })
    );
    await inDatabase(
      undefined,
      (sql) => sql`update conversation_attachments set byte_size = ${KNOWLEDGE_FILE_MAX_BYTES + 1}
        where id = ${attachment.id}`
    );
    expect(await reasonOf([large])).toBe("knowledge_file_too_large");

    // At most `knowledge.maxDocuments`: two fit, the third is refused and its copy goes. The
    // third has the first one's bytes: removing its copy leaves the first one's.
    const texts = await Promise.all(
      ["a", "b", "a"].map((name, index) =>
        conversationWithFile(instance, {
          filename: `${name}${index}.md`,
          contentType: "text/markdown",
          content: `# ${name}`
        })
      )
    );
    const first = await addFiles(instance, texts.slice(0, 2));
    expect(first.statusCode, first.body).toBe(200);
    const refused = await addFiles(instance, texts.slice(2));
    expect(refused.statusCode, refused.body).toBe(422);
    const { error } = errorSchema.parse(refused.json());
    expect(error.details).toEqual({ reason: "knowledge_documents_limit" });
    expect(error.message).toContain("knowledge.maxDocuments");

    // The copy of the refused file holds no document: its row and its object are gone. The
    // copies that hold documents keep theirs, the one of the same bytes included.
    const copies = await ownedCopies(instance);
    expect(copies.map((copy) => copy.status)).toEqual(["available", "available"]);
    expect(await Promise.all(copies.map((copy) => stored(instance, copy.object_key)))).toEqual([
      true,
      true
    ]);
    expect(await storedCopies(instance)).toHaveLength(2);
    const added = addedSchema.parse(first.json()).documents.map((document) => document.fileId);
    expect(
      (
        await instance.stores.audit.listAuditEvents({
          clientInstanceId,
          type: "knowledge_base.files_added",
          limit: 10
        })
      ).map((event) => event.metadata)
    ).toEqual([expect.objectContaining({ count: 2, fileIds: added })]);
  });

  it("leaves no copy and no object of a call that fails after it copied a file", async () => {
    const { instance, attachments, record } = await instanceWithFiles();
    const sources = await Promise.all(
      ["eins", "zwei"].map((name) =>
        conversationWithFile(instance, {
          filename: `${name}.txt`,
          contentType: "text/plain",
          content: name
        })
      )
    );
    // The second file's bytes are gone from the Conversation's store: reading it fails after
    // the first one is copied.
    const sha256 = createHash("sha256").update("zwei").digest("hex");
    await attachments.objects.delete(`test-files/${required(sources[1]).conversationId}/${sha256}`);

    const failed = await addFiles(instance, sources);
    expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400);
    expect(await ownedCopies(instance)).toEqual([]);
    expect(await storedCopies(instance)).toEqual([]);
    expect(await documentRows(record)).toEqual([]);
  });

  it("removes, by the job the call queued, the copies a call that ended midway left, and keeps the ones documents name", async () => {
    const { instance } = await instanceWithFiles();
    const source = await conversationWithFile(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });
    const added = await addFiles(instance, [source]);
    expect(added.statusCode, added.body).toBe(200);
    const kept = required(addedSchema.parse(added.json()).documents[0]).fileId;

    // What a process that ended between copying and writing the documents leaves: a copy with
    // its row and its object, and no document.
    const owner = { kind: "knowledge_base" as const, id: await assetId(instance) };
    const leftover = await instance.stores.files.createManagedFile({
      clientInstanceId,
      ownerUserId: "user-1",
      owner,
      filename: "verloren.txt",
      byteSize: 4,
      checksum: "0".repeat(64),
      objectKey: `knowledge-bases/${owner.id}/kbobj_leftover`
    });
    const leftoverPath = join(instance.filesRoot, ...leftover.objectKey.split("/"));
    await mkdir(dirname(leftoverPath), { recursive: true });
    await writeFile(leftoverPath, "lost");

    // The job runs once the call has surely ended; here it is made due at once.
    await inDatabase(
      undefined,
      (sql) => sql`update platform_jobs set run_after = now() - interval '1 second'
        where kind = 'knowledge_base.clean_files'`
    );
    await getTestJobs(instance.api).runDue();

    const copies = await ownedCopies(instance);
    expect(copies.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: kept, status: "available" }
    ]);
    expect(await stored(instance, leftover.objectKey)).toBe(false);
    expect(await stored(instance, required(copies[0]).object_key)).toBe(true);
  });

  /** Makes the cleanup jobs the calls queued due now, as they are once the calls' timeout passed. */
  const cleanupDue = () =>
    inDatabase(
      undefined,
      (sql) => sql`update platform_jobs set run_after = now() - interval '1 second'
        where kind = 'knowledge_base.clean_files'`
    );

  /** A gate a test opens once. */
  function gate() {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  it("refuses a call whose copy the cleanup removed while it stalled, and writes no document", async () => {
    const { instance, attachments, record } = await instanceWithFiles();
    const sources = await Promise.all(
      ["eins", "zwei"].map((name) =>
        conversationWithFile(instance, {
          filename: `${name}.txt`,
          contentType: "text/plain",
          content: name
        })
      )
    );
    // Reading the second file stalls, after the first one is copied, past the call's timeout.
    const stall = gate();
    const stalledKey = `test-files/${required(sources[1]).conversationId}/${createHash("sha256")
      .update("zwei")
      .digest("hex")}`;
    const get = attachments.objects.get.bind(attachments.objects);
    attachments.objects.get = async (key) => {
      if (key === stalledKey) await stall.opened;
      return get(key);
    };

    const call = addFiles(instance, sources);
    await eventually(async () => expect(await ownedCopies(instance)).toHaveLength(1));
    // The cleanup looks while the call stalls: the copy holds no document, so it goes.
    await cleanupDue();
    await getTestJobs(instance.api).runDue();
    expect(await ownedCopies(instance)).toEqual([]);

    stall.open();
    const refused = await call;
    expect(refused.statusCode, refused.body).toBe(409);
    expect(errorSchema.parse(refused.json()).error.details).toEqual({
      reason: "knowledge_files_released"
    });
    expect(await documentRows(record)).toEqual([]);
    expect(await ownedCopies(instance)).toEqual([]);
    expect(await storedCopies(instance)).toEqual([]);
  });

  it("keeps the copies of a call that wrote its documents before the cleanup that waited for it", async () => {
    const { instance, record } = await instanceWithFiles();
    const source = await conversationWithFile(instance, {
      filename: FILE_NAME,
      contentType: "text/plain",
      content: FILE_TEXT
    });
    const waiting = (count: number) =>
      eventually(async () => {
        const [row] = await inDatabase(
          record.location.database,
          (sql) => sql<{ count: number }[]>`select count(*)::int as count from pg_locks
            where not granted and relation = 'catalyst_kb.documents'::regclass`
        );
        expect(row?.count).toBe(count);
      });

    // The documents are locked: the call copies its file and then waits to write its document.
    // The call starts only once the lock is held, or it could take the lock first.
    const release = gate();
    let locked = false;
    const held = inDatabase(record.location.database, (sql) =>
      sql.begin(async (tx) => {
        await tx.unsafe("lock table catalyst_kb.documents in share row exclusive mode");
        locked = true;
        await release.opened;
      })
    );
    await eventually(() => expect(locked).toBe(true));
    const call = addFiles(instance, [source]);
    await waiting(1);
    // The cleanup looks while the call waits, and waits behind it.
    await cleanupDue();
    const cleanup = getTestJobs(instance.api).runDue();
    await waiting(2);

    release.open();
    await held;
    const added = await call;
    expect(added.statusCode, added.body).toBe(200);
    await cleanup;
    const copies = await ownedCopies(instance);
    expect(copies.map((copy) => copy.status)).toEqual(["available"]);
    expect(await stored(instance, required(copies[0]).object_key)).toBe(true);
    expect((await documentRows(record)).map((row) => row.managed_file_id)).toEqual([
      required(copies[0]).id
    ]);
  });

  it("keeps the bytes of a copy whose removal stalled while the call wrote its document", async () => {
    const { instance, attachments, record } = await instanceWithFiles();
    const sources = await Promise.all(
      ["eins", "zwei"].map((name) =>
        conversationWithFile(instance, {
          filename: `${name}.txt`,
          contentType: "text/plain",
          content: name
        })
      )
    );
    // The call copies the first file, then stalls reading the second.
    const stall = gate();
    const stalledKey = `test-files/${required(sources[1]).conversationId}/${createHash("sha256")
      .update("zwei")
      .digest("hex")}`;
    const get = attachments.objects.get.bind(attachments.objects);
    attachments.objects.get = async (key) => {
      if (key === stalledKey) await stall.opened;
      return get(key);
    };
    const call = addFiles(instance, sources);
    await eventually(async () => expect(await ownedCopies(instance)).toHaveLength(1));
    const first = required((await ownedCopies(instance))[0]);

    // The first copy's row is held, so the cleanup's write to it stalls past every timeout.
    const rowHeld = gate();
    let locked = false;
    const held = inDatabase(undefined, (sql) =>
      sql.begin(async (tx) => {
        await tx`select id from managed_files where id = ${first.id} for update`;
        locked = true;
        await rowHeld.opened;
      })
    );
    await eventually(() => expect(locked).toBe(true));
    await cleanupDue();
    const cleanup = getTestJobs(instance.api).runDue();
    await eventually(async () => {
      const [row] = await inDatabase(
        undefined,
        (sql) => sql<{ count: number }[]>`select count(*)::int as count from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database()`
      );
      expect(row?.count).toBe(1);
    });

    // The call goes on and writes its documents while the cleanup's write still waits.
    stall.open();
    const added = await call;
    expect(added.statusCode, added.body).toBe(200);
    // Then the cleanup's write lands, and the job runs again as its retry would.
    rowHeld.open();
    await held;
    await cleanup;
    await cleanupDue();
    await getTestJobs(instance.api).runDue();

    const copies = await ownedCopies(instance);
    expect(copies.map((copy) => copy.status)).toEqual(["available", "available"]);
    expect(await Promise.all(copies.map((copy) => stored(instance, copy.object_key)))).toEqual([
      true,
      true
    ]);
    expect((await documentRows(record)).map((row) => row.managed_file_id).sort()).toEqual(
      copies.map((copy) => copy.id).sort()
    );
  }, 90_000);
});
