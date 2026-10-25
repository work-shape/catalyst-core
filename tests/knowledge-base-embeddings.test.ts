import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  asUserId,
  KNOWLEDGE_BASE_ASSET_KIND,
  knowledgeIndexJob,
  type DataStoreRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import { KNOWLEDGE_EMBEDDING_BATCH } from "@work-shape/catalyst-data-stores";
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

// Embeddings of a Knowledge Base on the built-in backend (KB-5d): the index job embeds the
// passages of a Knowledge Base that searches by meaning through `gateway.embed`, in batches of
// at most 2,048, into generation 1 with `halfvec(<dimensions>)`; usage `knowledge_embedding`
// names the person, the workspace and the run of `add_files`; a provider 429 makes it wait.
// Chat safeguards never stop ingestion (KB-ISO). Spec: data-stores-and-knowledge-bases.md,
// "Embeddings and documents on the built-in backend", check 63.
//
// The embedding provider is an OpenAI-compatible entry in region `eu` whose `/embeddings` the
// test answers by stubbing `fetch`: the real gateway, adapter, admission and settlement run.

const KB = "objektunterlagen";
const BASE_URL = "https://embeddings.example.test/openai/v1";
const DIMENSIONS = 8;

const developmentAuth = {
  enabled: true,
  users: [{ id: "user-1", roles: ["user", "admin", "superadmin"] }].map((user) => ({
    ...user,
    externalUserId: user.id,
    displayLabel: user.id,
    permissionRefs: []
  }))
};

const documentsSchema = z.object({
  documents: z.array(
    z.object({
      id: z.string(),
      state: z.enum(["pending", "indexed", "failed"]),
      failureCode: z.string().optional(),
      waitCode: z.string().optional()
    })
  )
});
const addedSchema = z.object({
  documents: z.array(z.object({ id: z.string(), fileId: z.string() }))
});
const uploadedSchema = z.object({ attachment: z.object({ fileId: z.string() }) });
const embeddingRequestSchema = z.object({
  model: z.string(),
  input: z.array(z.string()),
  dimensions: z.number()
});

/** Markdown of `sections` headings, each its own passage. */
function sections(count: number, word = "Abschnitt"): string {
  return Array.from({ length: count }, (_, index) => `# ${word} ${index}\n\nText ${index}.`).join(
    "\n\n"
  );
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Azure's cap on the input tokens of one embeddings request, all texts together. */
const AZURE_MAX_TOKENS_PER_REQUEST = 300_000;

/** Tokens as the provider counts them, near enough for words and signs: one per piece. */
const providerTokens = (texts: readonly string[]) =>
  texts.reduce((sum, text) => sum + (text.match(/\p{L}+|\p{N}+|\S/gu)?.length ?? 0), 0);

/** The provider's 400 for a request whose texts hold more tokens than it takes in one. */
const tooManyTokens = (tokens: number) =>
  Response.json(
    {
      error: {
        code: "max_tokens_per_request",
        type: "max_tokens_per_request",
        message: `Requested ${tokens} tokens, max ${AZURE_MAX_TOKENS_PER_REQUEST} tokens per request`
      }
    },
    { status: 400 }
  );

/**
 * The embeddings endpoint of the test: what it was sent, and how it answers. Like Azure it
 * refuses a request above 300,000 tokens.
 */
function stubEmbeddings() {
  const batches: z.infer<typeof embeddingRequestSchema>[] = [];
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
    const tokens = providerTokens(request.input);
    if (tokens > AZURE_MAX_TOKENS_PER_REQUEST) return tooManyTokens(tokens);
    batches.push(request);
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
    /** The batches the provider answered with vectors, by their number of texts. */
    sizes: () => batches.map((batch) => batch.input.length),
    batches,
    /** Every request the provider got, answered or refused. */
    requests,
    /** The next calls answer these instead of vectors. */
    answerNext: (...responses: Response[]) => answers.push(...responses)
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedding the documents of a Knowledge Base", () => {
  const { start, person } = useDataStoreInstance();

  async function instanceWith(
    methods: string[],
    options: { usageSafeguards?: { modelCallsPerDay?: number }; workspace?: true } = {}
  ) {
    const { workspace, ...knowledge } = options;
    // Room for a long document: the product takes up to 25 MiB.
    const attachments = createManagedObjectTestAttachmentCapability({
      maxFileBytes: 4 * 1024 * 1024
    });
    const instance = await start(true, undefined, developmentAuth, undefined, {
      attachments: attachments.capability,
      embedding: true,
      embeddingBaseUrl: BASE_URL,
      ...knowledge
    });
    const workspaceId = workspace
      ? (
          await instance.stores.workspaces.ensurePersonalWorkspace({
            clientInstanceId,
            userId: asUserId((await person(instance, "user-1", ["user", "admin", "superadmin"])).id)
          })
        ).id
      : undefined;
    const record = await publish(instance, methods, workspaceId);
    return { instance, record, workspaceId };
  }

  async function publish(
    world: DataStoreInstance,
    methods: string[],
    workspaceId?: string
  ): Promise<DataStoreRecord> {
    const config: JsonObject = {
      name: KB,
      title: "Objektunterlagen",
      description: "Exposés, plans and contracts of the objects.",
      methods
    };
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB };
    const written = await world.api.call("assets.put", {
      params,
      payload: { config, expectedRevision: null, ...(workspaceId ? { workspaceId } : {}) }
    });
    expect(written.statusCode, written.body).toBe(200);
    const made = await world.api.call("assets.publish", {
      params,
      payload: { revision: 1, ...(workspaceId ? { workspaceId } : {}) }
    });
    expect(made.statusCode, made.body).toBe(200);
    return eventually(async () => {
      await getTestJobs(world.api).runDue();
      const record = await world.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      });
      expect(record).toMatchObject({ status: "ready", level: 16 });
      return required(record);
    });
  }

  async function add(
    world: DataStoreInstance,
    file: { filename: string; content: string }
  ): Promise<{ id: string; fileId: string }> {
    const created = await world.api.call("conversations.create", {
      payload: { title: "Unterlagen" }
    });
    const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
    const upload = createMultipartFilePayload({
      fieldName: "file",
      contentType: "text/markdown",
      ...file
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
    return required(addedSchema.parse(added.json()).documents[0]);
  }

  async function documents(world: DataStoreInstance) {
    const listed = await world.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: KB }
    });
    expect(listed.statusCode, listed.body).toBe(200);
    return documentsSchema.parse(listed.json()).documents;
  }

  const runJobs = (world: DataStoreInstance) => getTestJobs(world.api).runDue();

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
      (sql) => sql<
        {
          generation: number;
          binding_id: string;
          model: string;
          dimensions: number;
          state: string;
          embedded_count: number;
        }[]
      >`select generation, binding_id, model, dimensions, state, embedded_count
        from catalyst_kb.index_generations order by generation`
    );

  const vectorCount = (record: DataStoreRecord) =>
    inStore(record, async (sql) => {
      const [row] = await sql<{ count: number }[]>`
        select count(*)::int as count from catalyst_kb.embeddings_1`;
      return row?.count;
    });

  const embeddingUsage = async (world: DataStoreInstance) =>
    (await world.stores.usage.listModelUsageEvents({ clientInstanceId, limit: 100 })).filter(
      (event) => event.purpose === "knowledge_embedding"
    );

  /** The queued index jobs of the test's Knowledge Base, with when each is due. */
  const queuedIndexJobs = () =>
    inPlatform(
      (sql) => sql<{ id: string; run_after: Date; attempts: number }[]>`
        select id, run_after, attempts from platform_jobs
        where kind = ${knowledgeIndexJob.kind} and status = 'queued'`
    );

  /** Makes every queued index job due now. */
  const dueNow = () =>
    inPlatform(
      (sql) => sql`update platform_jobs set run_after = now()
        where kind = ${knowledgeIndexJob.kind} and status = 'queued'`
    );

  it("embeds the passages in batches of at most 2,048 into generation 1, counts the usage for the add_files run, and pays once per passage", async () => {
    const provider = stubEmbeddings();
    const { instance, record } = await instanceWith(["semantic", "keyword"]);
    const passages = KNOWLEDGE_EMBEDDING_BATCH + 52;
    const text = sections(passages);
    const added = await add(instance, { filename: "Exposé.md", content: text });
    await runJobs(instance);

    expect(provider.sizes()).toEqual([KNOWLEDGE_EMBEDDING_BATCH, 52]);
    expect(provider.batches[0]).toMatchObject({
      model: TEST_EMBEDDING_MODEL,
      dimensions: DIMENSIONS
    });
    // Each passage goes with its prefix: title, file name and heading.
    expect(provider.batches[0]?.input[1]).toBe(
      "Exposé · Exposé.md · Abschnitt 1\n\n# Abschnitt 1\n\nText 1."
    );
    expect(await documents(instance)).toMatchObject([{ id: added.id, state: "indexed" }]);

    // Generation 1, with the binding, the model and the dimensions it embeds with.
    expect(await generations(record)).toEqual([
      {
        generation: 1,
        binding_id: "embedding",
        model: TEST_EMBEDDING_MODEL,
        dimensions: DIMENSIONS,
        state: "active",
        embedded_count: passages
      }
    ]);
    expect(await vectorCount(record)).toBe(passages);
    const [column] = await inStore(
      record,
      (sql) => sql<{ type: string }[]>`
        select format_type(atttypid, atttypmod) as type from pg_attribute
        where attrelid = 'catalyst_kb.embeddings_1'::regclass and attname = 'embedding'`
    );
    expect(column?.type).toBe(`halfvec(${DIMENSIONS})`);

    // Usage names the person who added the file and the run of add_files; the provider's
    // region and the binding are on it as on every call.
    const [run] = await instance.stores.operationRuns.list({
      clientInstanceId,
      filters: { operation: `knowledge.${KB}.add_files` }
    });
    expect(run?.actor.kind).toBe("user");
    const usage = await embeddingUsage(instance);
    expect(usage).toHaveLength(2);
    for (const event of usage) {
      expect(event).toMatchObject({
        status: "settled",
        operationRunId: run?.id,
        userId: run?.actor.id,
        bindingId: "embedding",
        providerId: "azure-eu",
        region: "eu",
        model: TEST_EMBEDDING_MODEL
      });
    }
    expect(usage.map((event) => event.inputTokens).sort((a, b) => a - b)).toEqual([
      52,
      KNOWLEDGE_EMBEDDING_BATCH
    ]);

    // A rerun of the job finds every passage embedded and makes no call.
    await instance.stores.jobs.enqueue(
      knowledgeIndexJob,
      {
        knowledgeBaseId: record.id,
        contentSha256: sha256(text),
        fileId: added.fileId,
        operationRunId: required(run).id
      },
      { clientInstanceId }
    );
    await runJobs(instance);
    // So does a second file with the same bytes: its content is embedded once.
    await add(instance, { filename: "Exposé Kopie.md", content: text });
    await runJobs(instance);
    expect(provider.sizes()).toEqual([KNOWLEDGE_EMBEDDING_BATCH, 52]);
    expect(await vectorCount(record)).toBe(passages);
    expect(await embeddingUsage(instance)).toHaveLength(2);

    // The audit holds counts, never the text or the file name.
    const events = await instance.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "knowledge_base.content_indexed",
      limit: 10
    });
    expect(events[0]?.metadata).toMatchObject({ chunks: passages, embedded: passages });
    for (const event of events) expect(JSON.stringify(event)).not.toMatch(/Exposé|Abschnitt/u);
  });

  it("names the workspace that owns the Knowledge Base on its embedding usage", async () => {
    stubEmbeddings();
    const { instance, workspaceId } = await instanceWith(["semantic", "keyword"], {
      workspace: true
    });
    await add(instance, { filename: "Team.md", content: sections(2) });
    await runJobs(instance);

    const usage = await embeddingUsage(instance);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.collaborationWorkspaceId).toBe(required(workspaceId));
  });

  it("keeps each request under the provider's token cap, prefixes included, for a document of long passages", async () => {
    // The verifier's case: 700 sections of 480 words, 1.36 MB of Markdown, about 495 tokens a
    // passage with its prefix. In one request that is about 346,500 tokens, above Azure's
    // 300,000.
    const provider = stubEmbeddings();
    const { instance, record } = await instanceWith(["semantic", "keyword"]);
    const text = Array.from(
      { length: 700 },
      (_, index) => `# Section ${index}\n\n${"cat ".repeat(480)}`
    ).join("\n\n");
    expect(text.length).toBeGreaterThan(1_300_000);
    expect(text.length).toBeLessThan(25 * 1024 * 1024);
    const added = await add(instance, { filename: "Langes Exposé.md", content: text });
    await runJobs(instance);

    expect(await documents(instance)).toEqual([{ id: added.id, state: "indexed" }]);
    expect(await vectorCount(record)).toBe(700);
    expect(provider.requests.length).toBeGreaterThan(1);
    for (const request of provider.requests) {
      expect(providerTokens(request.input)).toBeLessThanOrEqual(AZURE_MAX_TOKENS_PER_REQUEST);
    }
    // Every passage was sent once, with its prefix.
    const sent = provider.requests.flatMap((request) => request.input);
    expect(sent).toHaveLength(700);
    expect(new Set(sent).size).toBe(700);
    expect(sent[0]).toMatch(/^Langes Exposé · Langes Exposé\.md · Section 0\n\n/u);
  });

  it("splits a batch the provider refuses as too large and never sends that request again", async () => {
    const provider = stubEmbeddings();
    const { instance, record } = await instanceWith(["semantic", "keyword"]);
    // A provider that counts more tokens than the bound expects refuses the first batch.
    provider.answerNext(tooManyTokens(AZURE_MAX_TOKENS_PER_REQUEST + 1));
    const added = await add(instance, { filename: "Teilung.md", content: sections(5) });
    await runJobs(instance);

    expect(provider.requests.map((request) => request.input.length)).toEqual([5, 3, 2]);
    const asSent = provider.requests.map((request) => JSON.stringify(request.input));
    expect(new Set(asSent).size).toBe(asSent.length);
    expect(await documents(instance)).toEqual([{ id: added.id, state: "indexed" }]);
    expect(await vectorCount(record)).toBe(5);
  });

  it("fails a content whose single passage the provider refuses as too large, without sending it again", async () => {
    const provider = stubEmbeddings();
    const { instance } = await instanceWith(["semantic", "keyword"]);
    provider.answerNext(tooManyTokens(1), tooManyTokens(1));
    const added = await add(instance, { filename: "Einzeln.md", content: sections(2) });
    await runJobs(instance);

    // Two passages refused together, then the first alone: no call can embed it.
    expect(provider.requests.map((request) => request.input.length)).toEqual([2, 1]);
    expect(await documents(instance)).toEqual([
      { id: added.id, state: "failed", failureCode: "knowledge_index_failed" }
    ]);
    expect(await queuedIndexJobs()).toEqual([]);
  });

  it("waits for the provider's Retry-After on a 429 without using an attempt, then goes on", async () => {
    const provider = stubEmbeddings();
    const { instance, record } = await instanceWith(["semantic", "keyword"]);
    provider.answerNext(
      Response.json(
        { error: { code: "429", message: "Requests exceed the rate limit" } },
        { status: 429, headers: { "retry-after": "120" } }
      )
    );
    const added = await add(instance, { filename: "Plan.md", content: sections(3) });
    const before = Date.now();
    await runJobs(instance);

    // Pending, with no reason on the page: a busy provider is no limit of the instance.
    expect(await documents(instance)).toEqual([{ id: added.id, state: "pending" }]);
    const [queued, ...more] = await queuedIndexJobs();
    expect(more).toEqual([]);
    expect(queued?.attempts).toBe(0);
    expect(required(queued).run_after.getTime() - before).toBeGreaterThanOrEqual(119_000);
    expect(await generations(record)).toMatchObject([{ generation: 1, embedded_count: 0 }]);

    await dueNow();
    await runJobs(instance);
    expect(provider.sizes()).toEqual([3]);
    expect(await documents(instance)).toEqual([{ id: added.id, state: "indexed" }]);
    expect(await vectorCount(record)).toBe(3);
  });

  it("finishes ingestion across batches without consuming the person's chat safeguard", async () => {
    const provider = stubEmbeddings();
    // KB-ISO: ingestion is outside chat safeguards, including the caller's product bucket.
    // The previous behaviour admitted one batch and made the rest wait for a limit raise.
    const { instance, record } = await instanceWith(["semantic", "keyword"], {
      usageSafeguards: { modelCallsPerDay: 1 }
    });
    const passages = KNOWLEDGE_EMBEDDING_BATCH + 5;
    const added = await add(instance, { filename: "Akte.md", content: sections(passages) });
    await runJobs(instance);

    expect(provider.sizes()).toEqual([KNOWLEDGE_EMBEDDING_BATCH, 5]);
    expect(await documents(instance)).toEqual([{ id: added.id, state: "indexed" }]);
    expect(await vectorCount(record)).toBe(passages);
    expect(await embeddingUsage(instance)).toHaveLength(2);
    expect(await queuedIndexJobs()).toEqual([]);
    await runJobs(instance);
    expect(provider.sizes()).toEqual([KNOWLEDGE_EMBEDDING_BATCH, 5]);
  });

  it("makes no embedding call and keeps no vectors for a Knowledge Base that searches by keyword only", async () => {
    const provider = stubEmbeddings();
    const { instance, record } = await instanceWith(["keyword"]);
    const added = await add(instance, { filename: "Glossar.md", content: sections(4) });
    await runJobs(instance);

    expect(await documents(instance)).toEqual([{ id: added.id, state: "indexed" }]);
    expect(provider.batches).toEqual([]);
    expect(await embeddingUsage(instance)).toEqual([]);
    expect(await generations(record)).toEqual([]);
    const tables = await inStore(
      record,
      (sql) => sql<{ name: string }[]>`
        select tablename as name from pg_tables
        where schemaname = 'catalyst_kb' and tablename like 'embeddings_%'`
    );
    expect(tables).toEqual([]);
    const vector = await inStore(
      record,
      (sql) => sql`select 1 from pg_extension where extname = 'vector'`
    );
    expect(vector).toHaveLength(0);
  });

  it("embeds nothing into a generation whose binding now names another model", async () => {
    const provider = stubEmbeddings();
    const { instance, record } = await instanceWith(["semantic", "keyword"]);
    await add(instance, { filename: "Eins.md", content: sections(2) });
    await runJobs(instance);
    expect(provider.sizes()).toEqual([2]);

    // Generation 1 was embedded with a model the binding no longer names: a re-index (KB-8)
    // starts a new generation, and nothing of the old model is mixed with the new one.
    await inStore(
      record,
      (sql) => sql`update catalyst_kb.index_generations set model = 'retired-model'`
    );
    const second = await add(instance, { filename: "Zwei.md", content: sections(3, "Kapitel") });
    await runJobs(instance);

    expect(provider.sizes()).toEqual([2]);
    expect((await documents(instance)).find((document) => document.id === second.id)).toEqual({
      id: second.id,
      state: "indexed"
    });
    expect(await vectorCount(record)).toBe(2);
  });
});
