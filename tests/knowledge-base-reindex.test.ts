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
  TEST_EMBEDDING_MODEL,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { getTestJobs } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// Changing the embedding model of a Knowledge Base (KB-8): a publish that names another binding
// states the passages, tokens and cost and asks for its confirmation; the re-index builds a
// generation beside the active one, which search keeps reading, and switches in one
// transaction; `knowledge_bases.reindex` states first and starts only with the statement's
// confirmation; an index whose model is gone answers by words and titles alone. Spec:
// data-stores-and-knowledge-bases.md, "Changing the embedding model", checks 24, 26, 27, 61, 65.

const KB = "unterlagen";
const BASE_URL = "https://embeddings.example.test/openai/v1";
const LARGE = { id: "embedding-large", model: "text-embedding-large", dimensions: 12 };

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
const errorSchema = z.object({
  error: z.object({ message: z.string(), details: z.record(z.string(), z.unknown()) })
});
const embeddingStateSchema = z.object({
  state: z.string(),
  active: z.object({ bindingId: z.string(), model: z.string() }).optional(),
  target: z.object({ bindingId: z.string(), model: z.string() }).optional(),
  progress: z.object({ embedded: z.number(), total: z.number() }).optional()
});
const stateSchema = z.object({ embedding: embeddingStateSchema.optional() });
const reindexSchema = embeddingStateSchema.extend({
  started: z.boolean(),
  statement: z
    .object({
      model: z.string(),
      chunks: z.number(),
      tokens: z.number(),
      room: z.boolean(),
      confirmation: z.string()
    })
    .optional(),
  lines: z.array(z.string()).optional()
});
const searchSchema = z.object({
  passages: z.array(z.object({ text: z.string() }).passthrough()),
  signals: z.unknown()
});

/** Markdown of `count` headings, each its own passage. */
function sections(count: number): string {
  return Array.from({ length: count }, (_, index) => `# Abschnitt ${index}\n\nText ${index}.`).join(
    "\n\n"
  );
}

/** The embeddings endpoint of the test: what it was sent, and how it answers next. */
function stubEmbeddings() {
  const requests: z.infer<typeof embeddingRequestSchema>[] = [];
  const answers: Response[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target !== `${BASE_URL}/embeddings`) return realFetch(url, init);
    const request = embeddingRequestSchema.parse(JSON.parse(String(init?.body)));
    requests.push(request);
    const scripted = answers.shift();
    if (scripted) return scripted;
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
  return {
    requests,
    /** The requests of `model`. */
    of: (model: string) => requests.filter((request) => request.model === model),
    answerNext: (...responses: Response[]) => answers.push(...responses)
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("changing the embedding model of a Knowledge Base", () => {
  const { start } = useDataStoreInstance();

  async function instance(): Promise<{ world: DataStoreInstance; record: DataStoreRecord }> {
    const attachments = createManagedObjectTestAttachmentCapability({
      maxFileBytes: 1024 * 1024
    });
    const world = await start(true, undefined, developmentAuth, undefined, {
      attachments: attachments.capability,
      embedding: true,
      embeddingBaseUrl: BASE_URL,
      extraEmbeddingBindings: [LARGE]
    });
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const written = await world.api.call("assets.put", {
      params,
      payload: { config: definition(), expectedRevision: null }
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
      expect(found).toMatchObject({ status: "ready", level: 16 });
      return required(found);
    });
    return { world, record };
  }

  const definition = (binding?: string): JsonObject => ({
    name: KB,
    title: "Unterlagen",
    description: "Plans and contracts of the objects.",
    methods: ["semantic", "keyword"],
    ...(binding ? { indexing: { embedding: { binding } } } : {})
  });

  const runJobs = (world: DataStoreInstance) => getTestJobs(world.api).runDue();

  async function add(world: DataStoreInstance, content: string): Promise<void> {
    const created = await world.api.call("conversations.create", {
      payload: { title: "Unterlagen" }
    });
    const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
    const upload = createMultipartFilePayload({
      fieldName: "file",
      contentType: "text/markdown",
      filename: "Plan.md",
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
  }

  /** Writes and publishes `config` as the next revision, with a confirmation where given. */
  async function publish(world: DataStoreInstance, config: JsonObject, confirm?: string) {
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const asset = required(
      await world.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
    );
    let revision = asset.revision;
    if (JSON.stringify(asset.config) !== JSON.stringify(config)) {
      const put = await world.api.call("assets.put", {
        params,
        payload: { config, expectedRevision: asset.revision }
      });
      expect(put.statusCode, put.body).toBe(200);
      revision = z.object({ revision: z.number() }).parse(put.json()).revision;
    }
    return world.api.call("assets.publish", {
      params,
      payload: { revision, ...(confirm ? { confirmProcessing: confirm } : {}) }
    });
  }

  async function state(world: DataStoreInstance) {
    const read = await world.api.call("knowledge_bases.get", { params: { knowledgeBase: KB } });
    expect(read.statusCode, read.body).toBe(200);
    return stateSchema.parse(read.json()).embedding;
  }

  async function reindex(world: DataStoreInstance, confirm?: string) {
    const called = await world.api.call("knowledge_bases.reindex", {
      params: { knowledgeBase: KB },
      payload: confirm ? { confirm } : {}
    });
    expect(called.statusCode, called.body).toBe(200);
    return reindexSchema.parse(called.json());
  }

  async function search(world: DataStoreInstance, query: string) {
    const searched = await world.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query }
    });
    expect(searched.statusCode, searched.body).toBe(200);
    return searchSchema.parse(searched.json()).passages;
  }

  async function inDatabase<T>(database: string, read: (sql: postgres.Sql) => Promise<T>) {
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      return await read(sql);
    } finally {
      await sql.end();
    }
  }

  const inStore = <T>(record: DataStoreRecord, read: (sql: postgres.Sql) => Promise<T>) =>
    inDatabase(record.location.database, read);

  /** The platform's own database, where the jobs are. */
  const inPlatform = async <T>(read: (sql: postgres.Sql) => Promise<T>) =>
    inDatabase(new URL(await fileTestDatabaseUrl()).pathname.slice(1), read);

  const generations = (record: DataStoreRecord) =>
    inStore(
      record,
      (sql) => sql<{ generation: number; binding_id: string; model: string; state: string }[]>`
        select generation, binding_id, model, state from catalyst_kb.index_generations
        order by generation`
    );

  const tables = (record: DataStoreRecord) =>
    inStore(record, async (sql) =>
      (
        await sql<{ name: string }[]>`
          select tablename as name from pg_tables
          where schemaname = 'catalyst_kb' and tablename like 'embeddings_%' order by tablename`
      ).map((row) => row.name)
    );

  const chunkIds = (record: DataStoreRecord) =>
    inStore(record, async (sql) =>
      (await sql<{ id: string }[]>`select id from catalyst_kb.chunks order by id`).map(
        (row) => row.id
      )
    );

  const keywordOnly = (): JsonObject => ({ ...definition(), methods: ["keyword"] });

  const embeddedChunkIds = (record: DataStoreRecord, generation: number) =>
    inStore(record, async (sql) =>
      (
        await sql.unsafe<{ id: string }[]>(
          `select chunk_id as id from catalyst_kb.embeddings_${String(generation)} order by chunk_id`
        )
      ).map((row) => row.id)
    );

  const queuedReindexJobs = () =>
    inPlatform(
      (sql) => sql<{ id: string }[]>`select id from platform_jobs
        where kind = ${KNOWLEDGE_JOB_KINDS.reindex} and status = 'queued'`
    );

  /** Makes every queued re-index job due now. */
  const dueNow = () =>
    inPlatform(
      (sql) => sql`update platform_jobs set run_after = now()
        where kind = ${KNOWLEDGE_JOB_KINDS.reindex} and status = 'queued'`
    );

  it("states a publish that names another binding first, builds beside the active index and switches in one step", async () => {
    const provider = stubEmbeddings();
    const { world, record } = await instance();
    await add(world, sections(3));
    await runJobs(world);
    expect(await generations(record)).toEqual([
      { generation: 1, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "active" }
    ]);
    const chunks = await chunkIds(record);
    expect(chunks).toHaveLength(3);

    // Without the confirmation the publish is refused with the statement, and nothing starts.
    const asked = await publish(world, definition(LARGE.id));
    expect(asked.statusCode, asked.body).toBe(422);
    const refusal = errorSchema.parse(asked.json()).error;
    expect(refusal.details).toMatchObject({
      reason: "knowledge_reindex_confirmation_required",
      chunks: 3
    });
    expect(refusal.message).toContain(`Re-embed with ${LARGE.model} (${LARGE.id}): 3 passages`);
    expect(refusal.message).toContain("estimated cost");
    const confirmation = z.string().parse(refusal.details.confirmation);
    expect(await generations(record)).toHaveLength(1);
    // The draft's read states the same and names the confirmation for a publish dialog to pass,
    // without the line that tells an API caller how.
    const draft = await world.api.call("assets.get", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB }
    });
    expect(draft.statusCode, draft.body).toBe(200);
    const question = z
      .object({ publishQuestion: z.array(z.string()), publishConfirmation: z.string() })
      .parse(draft.json());
    expect(question.publishConfirmation).toBe(confirmation);
    expect(question.publishQuestion.join("\n")).toContain(`Re-embed with ${LARGE.model}`);
    expect(question.publishQuestion.join("\n")).not.toContain("confirmProcessing");
    const wrong = await publish(world, definition(LARGE.id), "0".repeat(64));
    expect(wrong.statusCode, wrong.body).toBe(422);

    // The first batch of the new model waits on a 429: the new generation is being built, and
    // search answers from the old one, with the old model.
    provider.answerNext(
      Response.json(
        { error: { message: "slow down" } },
        { status: 429, headers: { "retry-after": "120" } }
      )
    );
    const published = await publish(world, definition(LARGE.id), confirmation);
    expect(published.statusCode, published.body).toBe(200);
    await runJobs(world);
    expect(await generations(record)).toEqual([
      { generation: 1, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "active" },
      { generation: 2, binding_id: LARGE.id, model: LARGE.model, state: "building" }
    ]);
    expect(await state(world)).toMatchObject({
      state: "reindexing",
      active: { model: TEST_EMBEDDING_MODEL },
      target: { model: LARGE.model },
      progress: { embedded: 0, total: 3 }
    });
    const before = provider.of(TEST_EMBEDDING_MODEL).length;
    expect(await search(world, "Abschnitt 1")).not.toHaveLength(0);
    expect(provider.of(TEST_EMBEDDING_MODEL)).toHaveLength(before + 1);

    // Once every passage has its vector, the new generation is the active one and the old
    // table is gone. Nothing was extracted or chunked again.
    expect(await queuedReindexJobs()).toHaveLength(1);
    await dueNow();
    await runJobs(world);
    expect(await generations(record)).toEqual([
      { generation: 1, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "retired" },
      { generation: 2, binding_id: LARGE.id, model: LARGE.model, state: "active" }
    ]);
    expect(await tables(record)).toEqual(["embeddings_2"]);
    expect(await chunkIds(record)).toEqual(chunks);
    // The batch the 429 refused, then the same three passages again.
    expect(provider.of(LARGE.model).map((request) => request.input.length)).toEqual([3, 3]);
    expect(provider.of(LARGE.model)[0]?.dimensions).toBe(LARGE.dimensions);
    expect(await state(world)).toMatchObject({ state: "current", active: { model: LARGE.model } });

    // Search embeds its query with the new model now.
    const large = provider.of(LARGE.model).length;
    expect(await search(world, "Abschnitt 2")).not.toHaveLength(0);
    expect(provider.of(LARGE.model)).toHaveLength(large + 1);

    // The re-index's usage is counted for the person who published it, under its own run.
    const [run] = await world.stores.operationRuns.list({
      clientInstanceId,
      filters: { operation: `knowledge.${KB}.reindex` }
    });
    expect(run).toMatchObject({ status: "done", actor: { kind: "user" } });
    const usage = (
      await world.stores.usage.listModelUsageEvents({ clientInstanceId, limit: 100 })
    ).filter((event) => event.purpose === "knowledge_embedding" && event.model === LARGE.model);
    // The call the 429 refused, then the one that embedded.
    expect(usage.map((event) => event.status).sort()).toEqual(["failed", "settled"]);
    for (const event of usage) {
      expect(event).toMatchObject({
        operationRunId: run?.id,
        userId: run?.actor.id,
        bindingId: LARGE.id
      });
    }
    const audit = await world.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
    expect(audit.map((event) => event.type)).toEqual(
      expect.arrayContaining(["knowledge_base.reindex_started", "knowledge_base.reindex_finished"])
    );
  });

  it("drops an index half-built for another model when the binding is set back, and embeds nothing more into it", async () => {
    const provider = stubEmbeddings();
    const { world, record } = await instance();
    await add(world, sections(3));
    await runJobs(world);

    // The re-index to the large model waits on a 429 with its generation half-built.
    const asked = await publish(world, definition(LARGE.id));
    const confirmation = z
      .string()
      .parse(errorSchema.parse(asked.json()).error.details.confirmation);
    provider.answerNext(
      Response.json(
        { error: { message: "slow down" } },
        { status: 429, headers: { "retry-after": "120" } }
      )
    );
    expect((await publish(world, definition(LARGE.id), confirmation)).statusCode).toBe(200);
    await runJobs(world);
    expect(await tables(record)).toEqual(["embeddings_1", "embeddings_2"]);
    const large = provider.of(LARGE.model).length;

    // Set back to the model it answers with: nothing to confirm.
    const back = await publish(world, definition());
    expect(back.statusCode, back.body).toBe(200);
    // A document added before the drop runs is embedded with the active model only.
    await inPlatform(
      (sql) => sql`update platform_jobs set run_after = now() + interval '1 hour'
        where kind = ${KNOWLEDGE_JOB_KINDS.reindex} and status = 'queued'`
    );
    await add(world, "# Neu\n\nNeuer Text.");
    await runJobs(world);
    expect(provider.of(LARGE.model)).toHaveLength(large);
    expect(await embeddedChunkIds(record, 1)).toEqual(await chunkIds(record));

    // Then the half-built index is dropped, and the waiting re-index ends without a call. One
    // job of the kind runs at a time per Knowledge Base, so the second runs on the next pass.
    await dueNow();
    await runJobs(world);
    await runJobs(world);
    expect(await generations(record)).toEqual([
      { generation: 1, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "active" },
      { generation: 2, binding_id: LARGE.id, model: LARGE.model, state: "retired" }
    ]);
    expect(await tables(record)).toEqual(["embeddings_1"]);
    expect(await state(world)).toMatchObject({ state: "current" });
    expect(provider.of(LARGE.model)).toHaveLength(large);
    expect(await queuedReindexJobs()).toHaveLength(0);
  });

  it("answers by words alone while the index's model is gone, and re-indexes only with the statement's confirmation", async () => {
    const provider = stubEmbeddings();
    const { world, record } = await instance();
    await add(world, sections(2));
    await runJobs(world);
    // The binding now stands for another model than the index was built with.
    await inStore(
      record,
      (sql) => sql`update catalyst_kb.index_generations set model = 'retired-model'`
    );
    expect(await state(world)).toMatchObject({
      state: "reindex_needed",
      active: { model: "retired-model" },
      target: { model: TEST_EMBEDDING_MODEL }
    });
    const sent = provider.requests.length;
    expect(await search(world, "Abschnitt 1")).not.toHaveLength(0);
    // No query embedding: the binding's model no longer matches the index.
    expect(provider.requests).toHaveLength(sent);

    // The statement starts nothing.
    const stated = await reindex(world);
    expect(stated).toMatchObject({
      started: false,
      state: "reindex_needed",
      statement: { model: TEST_EMBEDDING_MODEL, chunks: 2, room: true }
    });
    expect(stated.lines?.join("\n")).toContain("2 passages");
    expect(await reindex(world, "0".repeat(64))).toMatchObject({ started: false });
    expect(await generations(record)).toHaveLength(1);
    expect(await queuedReindexJobs()).toHaveLength(0);

    const started = await reindex(world, stated.statement?.confirmation);
    expect(started).toMatchObject({ started: true, state: "reindexing" });
    await runJobs(world);
    expect(await generations(record)).toEqual([
      { generation: 1, binding_id: "embedding", model: "retired-model", state: "retired" },
      { generation: 2, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "active" }
    ]);
    expect(await state(world)).toMatchObject({ state: "current" });
    const now = provider.requests.length;
    await search(world, "Abschnitt 1");
    expect(provider.requests).toHaveLength(now + 1);
  });

  it("embeds the passages already there when semantic search is turned on, with the statement's confirmation (KB-SEM-1)", async () => {
    const provider = stubEmbeddings();
    const { world, record } = await instance();
    expect((await publish(world, keywordOnly())).statusCode).toBe(200);
    await add(world, sections(3));
    await runJobs(world);
    expect(provider.requests).toHaveLength(0);
    expect(await generations(record)).toEqual([]);
    const chunks = await chunkIds(record);
    expect(chunks).toHaveLength(3);

    // Without the confirmation the publish is refused with the statement, and nothing starts.
    const asked = await publish(world, definition());
    expect(asked.statusCode, asked.body).toBe(422);
    const refusal = errorSchema.parse(asked.json()).error;
    expect(refusal.details).toMatchObject({
      reason: "knowledge_reindex_confirmation_required",
      chunks: 3
    });
    expect(refusal.message).toContain(
      `Embed the existing passages with ${TEST_EMBEDDING_MODEL} (embedding): 3 passages`
    );
    expect(await queuedReindexJobs()).toHaveLength(0);

    const published = await publish(
      world,
      definition(),
      z.string().parse(refusal.details.confirmation)
    );
    expect(published.statusCode, published.body).toBe(200);
    await runJobs(world);
    expect(await generations(record)).toEqual([
      { generation: 1, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "active" }
    ]);
    expect(await embeddedChunkIds(record, 1)).toEqual(chunks);
    expect(provider.of(TEST_EMBEDDING_MODEL).map((request) => request.input.length)).toEqual([3]);
    expect(await state(world)).toMatchObject({
      state: "current",
      active: { model: TEST_EMBEDDING_MODEL }
    });
    // Search embeds its query now.
    const sent = provider.requests.length;
    expect(await search(world, "Abschnitt 1")).not.toHaveLength(0);
    expect(provider.requests).toHaveLength(sent + 1);
  });

  it("drops the embeddings when semantic search is turned off, and embeds every passage with the confirmation when it is turned on again", async () => {
    const provider = stubEmbeddings();
    const { world, record } = await instance();
    await add(world, sections(2));
    await runJobs(world);
    expect(await tables(record)).toEqual(["embeddings_1"]);

    // Off: the index is dropped, and what is added meanwhile is embedded by nothing.
    expect((await publish(world, keywordOnly())).statusCode).toBe(200);
    await runJobs(world);
    expect(await generations(record)).toEqual([
      { generation: 1, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "retired" }
    ]);
    expect(await tables(record)).toEqual([]);
    await add(world, "# Neu\n\nNeuer Text.");
    await runJobs(world);
    const all = await chunkIds(record);
    expect(all).toHaveLength(3);
    const calls = provider.requests.length;
    expect(await search(world, "Abschnitt 1")).not.toHaveLength(0);
    expect(provider.requests).toHaveLength(calls);

    // On again: the statement names every passage, and the confirmed embedding builds anew.
    const asked = await publish(world, definition());
    expect(asked.statusCode, asked.body).toBe(422);
    const refusal = errorSchema.parse(asked.json()).error;
    expect(refusal.details).toMatchObject({ chunks: 3 });
    expect(refusal.message).toContain("Embed the existing passages");
    const published = await publish(
      world,
      definition(),
      z.string().parse(refusal.details.confirmation)
    );
    expect(published.statusCode, published.body).toBe(200);
    await runJobs(world);
    expect(await generations(record)).toEqual([
      { generation: 1, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "retired" },
      { generation: 2, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "active" }
    ]);
    expect(await embeddedChunkIds(record, 2)).toEqual(all);
    expect(provider.requests.slice(calls).map((request) => request.input.length)).toEqual([3]);
  });

  it("keeps the index when semantic search is turned off and on again before it is dropped", async () => {
    const provider = stubEmbeddings();
    const { world, record } = await instance();
    await add(world, sections(2));
    await runJobs(world);
    expect((await publish(world, keywordOnly())).statusCode).toBe(200);
    const calls = provider.requests.length;
    // Nothing lacks its vector, so nothing is asked, and the queued drop finds it in use.
    const published = await publish(world, definition());
    expect(published.statusCode, published.body).toBe(200);
    await runJobs(world);
    expect(await generations(record)).toEqual([
      { generation: 1, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "active" }
    ]);
    expect(await embeddedChunkIds(record, 1)).toEqual(await chunkIds(record));
    expect(provider.requests).toHaveLength(calls);
  });

  it("asks nothing when semantic search is turned on over no passage", async () => {
    stubEmbeddings();
    const { world } = await instance();
    expect((await publish(world, keywordOnly())).statusCode).toBe(200);
    const published = await publish(world, definition());
    expect(published.statusCode, published.body).toBe(200);
    expect(await queuedReindexJobs()).toHaveLength(0);
  });

  it("re-indexes a Knowledge Base that searches by meaning but has passages and no index", async () => {
    stubEmbeddings();
    const { world, record } = await instance();
    expect((await publish(world, keywordOnly())).statusCode).toBe(200);
    await add(world, sections(2));
    await runJobs(world);
    // As one published on before KB-SEM-1: semantic on, its passages never embedded.
    const asked = await publish(world, definition());
    const confirmation = z
      .string()
      .parse(errorSchema.parse(asked.json()).error.details.confirmation);
    expect((await publish(world, definition(), confirmation)).statusCode).toBe(200);
    await inPlatform(
      (sql) => sql`delete from platform_jobs where kind = ${KNOWLEDGE_JOB_KINDS.reindex}`
    );
    expect(await state(world)).toMatchObject({ state: "none" });

    const stated = await reindex(world);
    expect(stated).toMatchObject({
      started: false,
      state: "none",
      statement: { model: TEST_EMBEDDING_MODEL, chunks: 2 }
    });
    expect(stated.lines?.join("\n")).toContain("Embed the existing passages");
    const started = await reindex(world, stated.statement?.confirmation);
    expect(started).toMatchObject({ started: true, state: "reindexing" });
    await runJobs(world);
    expect(await generations(record)).toEqual([
      { generation: 1, binding_id: "embedding", model: TEST_EMBEDDING_MODEL, state: "active" }
    ]);
    expect(await embeddedChunkIds(record, 1)).toEqual(await chunkIds(record));
    expect(await state(world)).toMatchObject({ state: "current" });
  });

  it("refuses a Knowledge Base that names a binding the instance does not approve", async () => {
    stubEmbeddings();
    const { world } = await instance();
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const asset = required(
      await world.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
    );
    const refused = await world.api.call("assets.put", {
      params,
      payload: { config: definition("nope"), expectedRevision: asset.revision }
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain("names the embedding binding 'nope'");
  });
});
