import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_JOB_KINDS,
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

// Keyword languages per Knowledge Base (KB-12): `indexing.languages` builds only the listed
// full-text columns of the store's chunks, each with one GIN index, and search reads only
// those. A change of them, published, rebuilds the columns in the background through the
// re-index job without an embedding call, and search keeps answering from the old columns
// until the switch. A Knowledge Base that lists none keeps German and English. Spec:
// data-stores-and-knowledge-bases.md, Indexing settings, check 90.

const KB = "unterlagen";
const BASE_URL = "https://embeddings.example.test/openai/v1";

const developmentAuth = {
  enabled: true,
  users: [{ id: "user-1", roles: ["user", "admin", "superadmin"] }].map((user) => ({
    ...user,
    externalUserId: user.id,
    displayLabel: user.id,
    permissionRefs: []
  }))
};

const embeddingRequestSchema = z.object({
  model: z.string(),
  input: z.array(z.string()),
  dimensions: z.number()
});
const uploadedSchema = z.object({ attachment: z.object({ fileId: z.string() }) });
const searchSchema = z.object({
  passages: z.array(z.object({ text: z.string() }).passthrough()),
  signals: z.array(z.string())
});

/** German houses and French newspapers: "Haus" finds the one by German stems only, "journal" the other by French stems only. */
const TEXT = "# Bestand\n\nDie Häuser stehen leer.\n\n# Presse\n\nLes journaux nationaux.";

/** The embeddings endpoint of the test, and the requests it was sent. */
function stubEmbeddings() {
  const requests: z.infer<typeof embeddingRequestSchema>[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target !== `${BASE_URL}/embeddings`) return realFetch(url, init);
    const request = embeddingRequestSchema.parse(JSON.parse(String(init?.body)));
    requests.push(request);
    return Response.json({
      data: request.input.map((_text, index) => ({
        index,
        embedding: Array.from({ length: request.dimensions }, (_value, at) =>
          at === index % request.dimensions ? 1 : 0
        )
      })),
      usage: { prompt_tokens: request.input.length, total_tokens: request.input.length }
    });
  });
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the keyword languages of a Knowledge Base", () => {
  const { start } = useDataStoreInstance();

  const definition = (methods: string[], languages?: string[]): JsonObject => ({
    name: KB,
    title: "Unterlagen",
    description: "Plans and contracts of the objects.",
    methods,
    ...(languages ? { indexing: { languages } } : {})
  });

  const runJobs = (world: DataStoreInstance) => getTestJobs(world.api).runDue();

  async function instance(config: JsonObject) {
    const attachments = createManagedObjectTestAttachmentCapability({
      maxFileBytes: 1024 * 1024
    });
    const world = await start(true, undefined, developmentAuth, undefined, {
      attachments: attachments.capability,
      embedding: true,
      embeddingBaseUrl: BASE_URL
    });
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const written = await world.api.call("assets.put", {
      params,
      payload: { config, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
    const made = await world.api.call("assets.publish", { params, payload: { revision: 1 } });
    expect(made.statusCode, made.body).toBe(200);
    const record = await eventually(async () => {
      await runJobs(world);
      const found = await world.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      });
      expect(found).toMatchObject({ status: "ready", level: 18 });
      return required(found);
    });
    await runJobs(world);
    return { world, record };
  }

  async function add(world: DataStoreInstance, content: string, filename = "Plan.md") {
    const created = await world.api.call("conversations.create", {
      payload: { title: "Unterlagen" }
    });
    const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
    const upload = createMultipartFilePayload({
      fieldName: "file",
      contentType: "text/markdown",
      filename,
      content
    });
    const uploaded = await world.api.call("conversations.draft_attachments.upload", {
      params: { conversationId },
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const fileId = uploadedSchema.parse(uploaded.json()).attachment.fileId;
    const added = await world.api.call("knowledge_bases.add_files", {
      params: { knowledgeBase: KB },
      payload: { files: [{ conversationId, fileId }] }
    });
    expect(added.statusCode, added.body).toBe(200);
    await runJobs(world);
  }

  async function publish(world: DataStoreInstance, config: JsonObject) {
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const asset = required(
      await world.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
    );
    const put = await world.api.call("assets.put", {
      params,
      payload: { config, expectedRevision: asset.revision }
    });
    expect(put.statusCode, put.body).toBe(200);
    const revision = z.object({ revision: z.number() }).parse(put.json()).revision;
    const published = await world.api.call("assets.publish", {
      params,
      payload: { revision }
    });
    expect(published.statusCode, published.body).toBe(200);
  }

  async function search(world: DataStoreInstance, query: string) {
    const searched = await world.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query }
    });
    expect(searched.statusCode, searched.body).toBe(200);
    return searchSchema.parse(searched.json());
  }

  async function inStore<T>(record: DataStoreRecord, read: (sql: postgres.Sql) => Promise<T>) {
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      return await read(sql);
    } finally {
      await sql.end();
    }
  }

  /** The full-text columns of the chunks and the GIN indexes on them, by name. */
  const fullText = (record: DataStoreRecord) =>
    inStore(record, async (sql) => ({
      columns: (
        await sql<{ name: string }[]>`
          select attname as name from pg_attribute
          where attrelid = 'catalyst_kb.chunks'::regclass and attnum > 0 and not attisdropped
            and atttypid = 'tsvector'::regtype
          order by attname`
      ).map((row) => row.name),
      indexes: (
        await sql<{ name: string }[]>`
          select c.relname as name from pg_index x
          join pg_class c on c.oid = x.indexrelid
          join pg_am am on am.oid = c.relam
          where x.indrelid = 'catalyst_kb.chunks'::regclass and am.amname = 'gin'
          order by c.relname`
      ).map((row) => row.name)
    }));

  /** The re-index jobs still queued, in the platform's own database. */
  async function queuedReindexJobs() {
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      return await sql<{ id: string }[]>`select id from platform_jobs
        where kind = ${KNOWLEDGE_JOB_KINDS.reindex} and status = 'queued'`;
    } finally {
      await sql.end();
    }
  }

  it("keeps German and English for a Knowledge Base that lists no language", async () => {
    stubEmbeddings();
    const { world, record } = await instance(definition(["keyword"]));
    await add(world, TEXT);
    expect(await fullText(record)).toEqual({
      columns: ["search_de", "search_en"],
      indexes: ["chunks_search_de_idx", "chunks_search_en_idx"]
    });
    const found = await search(world, "Haus");
    expect(found.signals).toContain("keyword");
    expect(found.passages.map((passage) => passage.text)).toEqual([
      expect.stringContaining("Häuser")
    ]);
  });

  it("builds one full-text column and one GIN index for [de], and the change embeds nothing (check 90)", async () => {
    const requests = stubEmbeddings();
    const { world, record } = await instance(definition(["semantic", "keyword"]));
    await add(world, TEXT);
    const embedded = requests.length;
    expect(embedded).toBeGreaterThan(0);

    await publish(world, definition(["semantic", "keyword"], ["de"]));
    await eventually(async () => {
      await runJobs(world);
      expect(await fullText(record)).toEqual({
        columns: ["search_de"],
        indexes: ["chunks_search_de_idx"]
      });
    });
    // The re-index made no embedding call, and nothing was chunked again.
    expect(requests).toHaveLength(embedded);
    const read = await world.api.call("knowledge_bases.get", { params: { knowledgeBase: KB } });
    expect(read.statusCode, read.body).toBe(200);
    expect(z.object({ embedding: z.object({ state: z.string() }) }).parse(read.json())).toEqual(
      expect.objectContaining({ embedding: expect.objectContaining({ state: "current" }) })
    );
    // A passage written after the change has its German words, by the trigger.
    await add(world, "# Neu\n\nDie Gärten blühen.", "Garten.md");
    const counted = await inStore(
      record,
      (sql) => sql<{ empty: number }[]>`
        select count(*)::int as empty from catalyst_kb.chunks where search_de is null`
    );
    expect(counted).toEqual([{ empty: 0 }]);
  });

  it("builds only the listed languages of a Knowledge Base published with them", async () => {
    stubEmbeddings();
    const { world, record } = await instance(definition(["keyword"], ["fr"]));
    expect(await fullText(record)).toEqual({
      columns: ["search_fr"],
      indexes: ["chunks_search_fr_idx"]
    });
    await add(world, TEXT);
    const french = await search(world, "journal");
    expect(french.passages.map((passage) => passage.text)).toEqual([
      expect.stringContaining("journaux")
    ]);
    // German stems are not searched: "Haus" finds no passage.
    expect((await search(world, "Haus")).passages).toEqual([]);
  });

  it("keeps searching the old languages until the switch, then the new ones", async () => {
    stubEmbeddings();
    const { world, record } = await instance(definition(["keyword"], ["de"]));
    await add(world, TEXT);
    expect((await search(world, "journal")).passages).toEqual([]);

    // A French column filled and indexed beside the German one, as the job leaves it before
    // its switch: search does not read it yet.
    await inStore(record, async (sql) => {
      await sql`alter table catalyst_kb.chunks add column search_fr tsvector`;
      await sql`update catalyst_kb.chunks set search_fr = to_tsvector('french'::regconfig, text)`;
      await sql`create index chunks_search_fr_build on catalyst_kb.chunks using gin (search_fr)`;
    });
    expect((await search(world, "journal")).passages).toEqual([]);
    expect((await search(world, "Haus")).passages).toHaveLength(1);

    // Published with French alone: the job goes on from the built column and switches.
    await publish(world, definition(["keyword"], ["fr"]));
    await eventually(async () => {
      await runJobs(world);
      expect(await fullText(record)).toEqual({
        columns: ["search_fr"],
        indexes: ["chunks_search_fr_idx"]
      });
    });
    expect((await search(world, "journal")).passages).toHaveLength(1);
    expect((await search(world, "Haus")).passages).toEqual([]);
    // Nothing is left to build: publishing again queues no rebuild.
    await publish(world, { ...definition(["keyword"], ["fr"]), title: "Unterlagen 2" });
    await runJobs(world);
    expect(await queuedReindexJobs()).toEqual([]);
  });

  it("refuses an unknown language, an empty list and a language named twice", async () => {
    stubEmbeddings();
    const world = await start(true, undefined, developmentAuth, undefined, {
      embedding: true,
      embeddingBaseUrl: BASE_URL
    });
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    for (const languages of [["xx"], [], ["de", "de"]]) {
      const written = await world.api.call("assets.put", {
        params,
        payload: { config: definition(["keyword"], languages), expectedRevision: null }
      });
      expect(written.statusCode, JSON.stringify(languages)).toBe(422);
    }
    const written = await world.api.call("assets.put", {
      params,
      payload: { config: definition(["keyword"], ["de", "fr"]), expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
  });
});
