import { createHash } from "node:crypto";
import postgres from "postgres";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  knowledgeExtractionKey,
  KNOWLEDGE_BASE_ASSET_KIND,
  type DataStoreRecord
} from "@work-shape/catalyst-core";
import { eventually, required } from "./assertions";
import {
  clientInstanceId,
  useDataStoreInstance,
  type DataStoreInstance
} from "./data-store-instance";
import { fileTestDatabaseUrl } from "./test-database";
import { getTestJobs } from "./test-instance";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";
import { createManagedObjectTestAttachmentCapability } from "./chat-server-attachment-harness";

const KB = "removal";
const MARKER = "private-marker-never-in-observability";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
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
async function platformSql<T>(work: (sql: postgres.Sql) => Promise<T>) {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}
const countOf = (rows: readonly { count: number }[]) => rows[0]?.count ?? -1;
const runJobs = (world: DataStoreInstance) => getTestJobs(world.api).runDue();
const deleteKnowledgeBase = (world: DataStoreInstance) =>
  world.api.call("assets.delete", {
    params: { kind: "knowledge_base", name: KB },
    payload: { expectedRevision: 1 }
  });
const removalDueNow = () =>
  platformSql(
    (sql) =>
      sql`update platform_jobs set run_after=now() where kind='knowledge_base.remove_documents' and status='queued'`
  );
const purgeEvents = (world: DataStoreInstance) =>
  world.stores.audit.listAuditEvents({ clientInstanceId, type: "knowledge_base.deleted" });

/** The same paging, shared-content, recovery and audit proof at a boundary or customer volume. */
export function registerKnowledgeRemovalVolumeTest(volume: {
  documents: number;
  contents: number;
  interruptAt: number;
}) {
  const { start } = useDataStoreInstance();
  const auth = {
    enabled: true,
    users: [
      { id: "user-1", roles: ["user", "admin", "superadmin"] },
      { id: "reader", roles: ["user"] }
    ].map((user) => ({
      ...user,
      externalUserId: user.id,
      displayLabel: user.id,
      permissionRefs: []
    }))
  };

  async function setup() {
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
    return { world, record, objects: createFilesystemObjectStorage(world.filesRoot) };
  }

  it(`deletes ${volume.documents} documents in committed pages and continues after an interruption`, async () => {
    const { world, record, objects } = await setup();
    const total = volume.documents;
    const contentCount = volume.contents;
    const interruptAt = volume.interruptAt;
    const committed = Math.floor(interruptAt / 100) * 100;
    const interruptedId = `doc-${String(interruptAt).padStart(4, "0")}`;
    const docs = Array.from({ length: total }, (_, i) => {
      const n = String(i).padStart(4, "0");
      // Shared content outlives its first holder's committed page.
      return {
        id: `doc-${n}`,
        fileId: `file_kb_large_${n}`,
        objectKey: `knowledge-bases/${record.id}/large-${n}`,
        content: sha256(`content ${i % contentCount}`)
      };
    });
    const contents = [...new Set(docs.map((doc) => doc.content))];
    const bytes = new TextEncoder().encode("bytes");
    const now = new Date();
    await platformSql(async (sql) => {
      for (let start = 0; start < total; start += 500) {
        const rows = docs.slice(start, start + 500).map((doc) => ({
          id: doc.fileId,
          client_instance_id: clientInstanceId,
          owner_user_id: "user-1",
          owner_kind: "knowledge_base",
          owner_id: record.id,
          filename: `${MARKER}-${doc.id}.txt`,
          mime_type: "text/plain",
          byte_size: bytes.byteLength,
          checksum: doc.content,
          object_key: doc.objectKey,
          status: "available",
          created_at: now
        }));
        await sql`insert into managed_files ${sql(rows)}`;
      }
    });
    for (let start = 0; start < total; start += 200) {
      await Promise.all(
        docs.slice(start, start + 200).map((doc) => objects.put(doc.objectKey, bytes))
      );
    }
    for (let start = 0; start < contents.length; start += 200) {
      await Promise.all(
        contents
          .slice(start, start + 200)
          .map((content) => objects.put(knowledgeExtractionKey(record.id, content), bytes))
      );
    }
    await inStore(record, async (sql) => {
      await sql`insert into catalyst_kb.contents ${sql(
        contents.map((sha) => ({ sha256: sha, format: "txt", state: "extracted" }))
      )}`;
      for (let start = 0; start < total; start += 500) {
        await sql`insert into catalyst_kb.documents ${sql(
          docs.slice(start, start + 500).map((doc) => ({
            id: doc.id,
            managed_file_id: doc.fileId,
            content_sha256: doc.content,
            title: doc.id,
            file_name: `${MARKER}-${doc.id}.txt`
          }))
        )}`;
      }
      await sql`insert into catalyst_kb.chunks ${sql(
        contents.map((sha) => ({
          id: `chunk-${sha}`,
          content_sha256: sha,
          chunking_revision: 1,
          position: 0,
          text: MARKER,
          token_count: 1
        }))
      )}`;
      // Interrupt a later page of 100 after its files have gone.
      await sql.unsafe(`
        create function catalyst_kb.interrupt() returns trigger language plpgsql
          as $$ begin raise exception 'interrupted'; end $$;
        create trigger interrupt before delete on catalyst_kb.documents
          for each row when (old.id = '${interruptedId}') execute function catalyst_kb.interrupt();`);
    });
    expect((await deleteKnowledgeBase(world)).statusCode).toBe(200);
    await runJobs(world);
    const remaining = () =>
      inStore(
        record,
        (sql) => sql`select min(id) as first, count(*)::int as count from catalyst_kb.documents`
      );
    // Earlier pages committed; the interrupted page rolled back rows after deleting files.
    expect(await remaining()).toEqual([
      { first: `doc-${String(committed).padStart(4, "0")}`, count: total - committed }
    ]);
    expect(
      countOf(
        await inStore(record, (sql) => sql`select count(*)::int as count from catalyst_kb.contents`)
      )
    ).toBe(contentCount);
    expect(
      countOf(
        await platformSql(
          (sql) =>
            sql`select count(*)::int as count from managed_files where owner_kind = 'knowledge_base'`
        )
      )
    ).toBe(total - committed - 100);
    await expect(objects.head(required(docs[0]).objectKey)).rejects.toThrow();
    await expect(objects.head(required(docs[total - 1]).objectKey)).resolves.toBeDefined();
    await expect(
      objects.head(knowledgeExtractionKey(record.id, required(docs[0]).content))
    ).resolves.toBeDefined();
    expect(
      await world.stores.dataStores.getDataStore({ clientInstanceId, id: record.id })
    ).toMatchObject({ status: "retired" });
    await inStore(record, (sql) => sql`drop trigger interrupt on catalyst_kb.documents`);
    await removalDueNow();
    await eventually(async () => {
      await runJobs(world);
      expect(
        await world.stores.dataStores.getDataStore({ clientInstanceId, id: record.id })
      ).toBeUndefined();
    });
    expect(
      countOf(
        await platformSql(
          (sql) =>
            sql`select count(*)::int as count from managed_files where owner_kind = 'knowledge_base'`
        )
      )
    ).toBe(0);
    for (const doc of [docs[0], docs[interruptAt], docs[total - 1]].map(required)) {
      await expect(objects.head(doc.objectKey)).rejects.toThrow();
      await expect(objects.head(knowledgeExtractionKey(record.id, doc.content))).rejects.toThrow();
    }
    const events = await purgeEvents(world);
    const sum = (key: "documents" | "contents" | "files" | "extractionResults") =>
      events.reduce((total, event) => total + z.number().parse(event.metadata?.[key]), 0);
    expect(events.map((event) => event.status).sort()).toEqual(["failed", "success"]);
    expect({
      documents: sum("documents"),
      contents: sum("contents"),
      files: sum("files"),
      extractionResults: sum("extractionResults")
    }).toEqual({
      documents: total,
      contents: contentCount,
      files: total,
      extractionResults: contentCount
    });
  }, 180_000);
}
