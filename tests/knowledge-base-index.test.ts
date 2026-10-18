import { createHash } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import {
  asManagedFileId,
  defineKnowledgeExtractHandler,
  enqueueKnowledgeIndex,
  KnowledgeExtractionError,
  knowledgeExtractionKey,
  KNOWLEDGE_BASE_ASSET_KIND,
  knowledgeIndexJob,
  storeKnowledgeExtraction,
  verifyKnowledgeExtractor,
  type DataStoreRecord,
  type JsonObject,
  type Logger,
  type KnowledgeExtractor
} from "@work-shape/catalyst-core";
import {
  chunkKnowledgeText,
  estimateKnowledgeTokens,
  KNOWLEDGE_CHUNK_MAX_TOKENS,
  knowledgeChunkPrefix
} from "@work-shape/catalyst-data-stores";
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

// The keyword index of a Knowledge Base on the built-in backend (KB-5c): the job
// `knowledge_base.index` cuts TXT and Markdown into passages in the store the Knowledge Base
// owns, skips what is indexed, fails with a code and is retried; a PDF goes through the
// extract handoff of core. Spec: data-stores-and-knowledge-bases.md, "Ingestion as jobs",
// checks 56, 57 (TXT, MD) and 64.

const KB = "objektunterlagen";

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent
};

const developmentAuth = {
  enabled: true,
  users: [
    { id: "user-1", roles: ["user", "admin", "superadmin"] },
    { id: "member-1", roles: ["user"] }
  ].map((user) => ({ ...user, externalUserId: user.id, displayLabel: user.id, permissionRefs: [] }))
};
const asMember = { "x-dev-user-id": "member-1" };

const MARKDOWN = [
  "# Mietvertrag",
  "",
  "Zwischen Vermieterin und Mieter wird folgender Vertrag geschlossen.",
  "",
  "## Kaltmiete",
  "",
  "Die Kaltmiete beträgt 1.250 EUR monatlich.",
  "",
  "## Kaution",
  "",
  "Die Kaution beträgt drei Monatsmieten."
].join("\n");

const documentsSchema = z.object({
  documents: z.array(
    z.object({
      id: z.string(),
      fileId: z.string(),
      fileName: z.string(),
      title: z.string(),
      format: z.string(),
      bytes: z.number(),
      state: z.enum(["pending", "indexed", "failed"]),
      failureCode: z.string().optional(),
      failurePageLimit: z.number().optional(),
      failurePageCount: z.number().optional(),
      addedAt: z.string(),
      updatedAt: z.string()
    })
  ),
  nextCursor: z.string().optional()
});
const addedSchema = z.object({
  documents: z.array(z.object({ id: z.string(), fileId: z.string() }))
});
const uploadedSchema = z.object({ attachment: z.object({ fileId: z.string() }) });
const errorSchema = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()).optional() })
});

describe("chunking a document", () => {
  it("cuts Markdown at its headings and keeps every passage under the cap, prefix included", () => {
    const long = Array.from({ length: 400 }, (_, index) => `Satz ${index} über die Wohnung.`).join(
      " "
    );
    const chunks = chunkKnowledgeText({
      format: "markdown",
      pages: [{ text: `${MARKDOWN}\n\n### Anlage\n\n${long}` }],
      title: "Mietvertrag",
      fileName: "Mietvertrag.md"
    });
    expect(chunks.map((chunk) => chunk.position)).toEqual(chunks.map((_, index) => index));
    expect(chunks.slice(0, 3).map((chunk) => chunk.heading)).toEqual([
      "Mietvertrag",
      "Mietvertrag > Kaltmiete",
      "Mietvertrag > Kaution"
    ]);
    expect(chunks[1]?.text).toContain("1.250 EUR");
    const annex = chunks.filter((chunk) => chunk.heading === "Mietvertrag > Kaution > Anlage");
    expect(annex.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const prefix = knowledgeChunkPrefix({
        title: "Mietvertrag",
        fileName: "Mietvertrag.md",
        ...(chunk.heading === undefined ? {} : { heading: chunk.heading })
      });
      expect(chunk.tokenCount).toBe(estimateKnowledgeTokens(chunk.text));
      expect(chunk.tokenCount + estimateKnowledgeTokens(prefix)).toBeLessThanOrEqual(
        KNOWLEDGE_CHUNK_MAX_TOKENS
      );
      expect(chunk.page).toBeUndefined();
    }
    // Nothing is lost or repeated: no overlap. The heading line stays in the text.
    expect(annex.map((chunk) => chunk.text).join(" ")).toBe(`### Anlage\n\n${long}`);
  });

  it("keeps the pages of an extracted file and cuts a word longer than a passage", () => {
    const chunks = chunkKnowledgeText({
      format: "pdf",
      pages: [
        { page: 1, text: "Exposé Seite eins" },
        { page: 2, text: "" },
        { page: 3, text: "x".repeat(5_000) }
      ],
      title: "Exposé",
      fileName: "expose.pdf"
    });
    expect(chunks[0]).toMatchObject({ page: 1, text: "Exposé Seite eins" });
    expect(chunks.slice(1).every((chunk) => chunk.page === 3)).toBe(true);
    expect(
      chunks
        .slice(1)
        .map((chunk) => chunk.text)
        .join("")
    ).toBe("x".repeat(5_000));
    expect(chunks.every((chunk) => chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS)).toBe(true);
  });
});

/** An extractor that reads the test's own "PDF": the text after the marker, one page per form feed. */
const fakeExtractor: KnowledgeExtractor = {
  revision: 1,
  extract({ bytes }) {
    const text = new TextDecoder().decode(bytes);
    if (!text.startsWith("%FAKE-PDF\n")) {
      return Promise.reject(new KnowledgeExtractionError("knowledge_file_unreadable", "No PDF"));
    }
    return Promise.resolve({
      pages: text
        .slice("%FAKE-PDF\n".length)
        .split("\f")
        .map((page, index) => ({ page: index + 1, text: page }))
    });
  }
};

describe("the extract contract a producer checks", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("passes an extractor that holds to it", async () => {
    expect(
      await verifyKnowledgeExtractor(fakeExtractor, {
        samples: [{ format: "pdf", bytes: encode("%FAKE-PDF\neins\fzwei"), expectText: "zwei" }],
        unreadable: [{ format: "pdf", bytes: encode("garbage") }]
      })
    ).toEqual([]);
  });

  it("names what an extractor gets wrong", async () => {
    const broken: KnowledgeExtractor = {
      revision: 0,
      extract: ({ bytes }) =>
        new TextDecoder().decode(bytes) === "garbage"
          ? Promise.reject(new Error("converter crashed"))
          : Promise.resolve({
              pages: [
                { page: 2, text: "b" },
                { page: 1, text: "a" }
              ]
            })
    };
    const problems = await verifyKnowledgeExtractor(broken, {
      samples: [{ format: "docx", bytes: encode("x"), expectText: "a" }],
      unreadable: [{ format: "docx", bytes: encode("garbage") }]
    });
    expect(problems).toEqual([
      "revision 0 is not a whole number from 1",
      "sample 1 (docx) threw: The extractor answered pages outside the contract",
      "unreadable 1 (docx) threw an error that is retried instead of KnowledgeExtractionError: Error"
    ]);
  });
});

describe("indexing the documents of a Knowledge Base", () => {
  const { start } = useDataStoreInstance();

  async function instanceWith(options: { documents?: true; maxPagesPerDocument?: number } = {}) {
    const attachments = createManagedObjectTestAttachmentCapability();
    const instance = await start(true, undefined, developmentAuth, undefined, {
      attachments: attachments.capability,
      ...options
    });
    const record = await published(instance);
    return { instance, record };
  }

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
    return eventually(async () => {
      await getTestJobs(world.api).runDue();
      const record = await world.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      });
      expect(record).toMatchObject({ status: "ready", level: 12 });
      return required(record);
    });
  }

  /** Adds one file through a Conversation of the caller and answers the document. */
  async function add(
    world: DataStoreInstance,
    file: { filename: string; contentType: string; content: string }
  ): Promise<{ id: string; fileId: string }> {
    const created = await world.api.call("conversations.create", {
      payload: { title: "Unterlagen" }
    });
    const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
    const upload = createMultipartFilePayload({ fieldName: "file", ...file });
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

  async function list(world: DataStoreInstance, query: Record<string, string> = {}) {
    const listed = await world.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: KB },
      query
    });
    expect(listed.statusCode, listed.body).toBe(200);
    return documentsSchema.parse(listed.json());
  }

  const runJobs = (world: DataStoreInstance) => getTestJobs(world.api).runDue();

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

  const chunkRows = (record: DataStoreRecord) =>
    inStore(
      record,
      (sql) => sql<{ id: string; content_sha256: string; heading: string | null; text: string }[]>`
        select id, content_sha256, heading, text from catalyst_kb.chunks
        order by content_sha256, position`
    );

  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  it("indexes TXT and Markdown into passages found by German full text, once per content, and replaces them on a rerun", async () => {
    const { instance, record } = await instanceWith();
    const markdown = await add(instance, {
      filename: "Mietvertrag.md",
      contentType: "text/markdown",
      content: MARKDOWN
    });
    const text = "Die Heizung wurde 2019 erneuert.";
    await add(instance, { filename: "Heizung.txt", contentType: "text/plain", content: text });
    expect((await list(instance)).documents.map((document) => document.state)).toEqual([
      "pending",
      "pending"
    ]);

    await runJobs(instance);
    const { documents } = await list(instance);
    expect(documents).toMatchObject([
      { fileName: "Heizung.txt", format: "txt", state: "indexed", bytes: Buffer.byteLength(text) },
      { id: markdown.id, fileName: "Mietvertrag.md", format: "markdown", state: "indexed" }
    ]);
    const chunks = await chunkRows(record);
    expect(chunks).toHaveLength(4);
    expect(chunks.filter((chunk) => chunk.content_sha256 === sha256(MARKDOWN))).toMatchObject([
      { id: `${sha256(MARKDOWN)}:1:0`, heading: "Mietvertrag" },
      { heading: "Mietvertrag > Kaltmiete" },
      { heading: "Mietvertrag > Kaution" }
    ]);
    const found = await inStore(
      record,
      (sql) => sql<{ heading: string }[]>`select heading from catalyst_kb.chunks
        where search_de @@ websearch_to_tsquery('german', 'Kautionen')`
    );
    expect(found).toEqual([{ heading: "Mietvertrag > Kaution" }]);

    // A second file with the same bytes points to the same passages: nothing is written again.
    const copy = await add(instance, {
      filename: "Mietvertrag Kopie.md",
      contentType: "text/markdown",
      content: MARKDOWN
    });
    await runJobs(instance);
    expect((await list(instance)).documents[0]).toMatchObject({ id: copy.id, state: "indexed" });
    expect(await chunkRows(record)).toEqual(chunks);

    // A rerun at another chunking revision replaces the passages and never doubles them.
    await inStore(
      record,
      (sql) => sql`update catalyst_kb.contents set chunking_revision = 0
        where sha256 = ${sha256(MARKDOWN)}`
    );
    await instance.stores.jobs.enqueue(
      knowledgeIndexJob,
      {
        knowledgeBaseId: record.id,
        contentSha256: sha256(MARKDOWN),
        fileId: markdown.fileId,
        operationRunId: "run-test"
      },
      { clientInstanceId }
    );
    await runJobs(instance);
    expect(await chunkRows(record)).toEqual(chunks);

    // The audit names the Knowledge Base, a file, counts: no file name, no text.
    const events = await instance.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "knowledge_base.content_indexed",
      limit: 10
    });
    expect(events.map((event) => event.status)).toEqual(["success", "success", "success"]);
    for (const event of events) {
      expect(JSON.stringify(event)).not.toMatch(/Mietvertrag\.md|Heizung|Kaution/u);
    }
  });

  it("fails a file that is no text and one without text with their codes, and Retry indexes it again", async () => {
    const { instance, record } = await instanceWith();
    const binary = await add(instance, {
      filename: "kaputt.txt",
      contentType: "text/plain",
      content: "ab\u0000cd"
    });
    const empty = await add(instance, {
      filename: "leer.md",
      contentType: "text/markdown",
      content: "  \n\n "
    });
    await runJobs(instance);
    const byId = (documents: z.infer<typeof documentsSchema>["documents"]) =>
      new Map(documents.map((document) => [document.id, document]));
    let listed = byId((await list(instance)).documents);
    expect(listed.get(binary.id)).toMatchObject({
      state: "failed",
      failureCode: "knowledge_text_unreadable"
    });
    expect(listed.get(empty.id)).toMatchObject({
      state: "failed",
      failureCode: "knowledge_text_empty"
    });

    // A member without the write right cannot retry.
    const refused = await instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [binary.id] },
      headers: asMember
    });
    expect([403, 404]).toContain(refused.statusCode);

    // Retry puts it back to pending; the same bytes fail the same way again.
    const retried = await instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [binary.id, "kbdoc_unknown"] }
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toEqual({ documents: [{ id: binary.id, state: "pending" }], queued: 1 });
    await runJobs(instance);
    listed = byId((await list(instance)).documents);
    expect(listed.get(binary.id)).toMatchObject({ failureCode: "knowledge_text_unreadable" });

    // A content fixed underneath is indexed by Retry.
    await inStore(
      record,
      (sql) => sql`update catalyst_kb.contents set state = 'failed',
        failure_code = 'knowledge_index_failed'`
    );
    const object = required(
      await instance.stores.files.getManagedFile({
        clientInstanceId,
        fileId: asManagedFileId(empty.fileId)
      })
    ).objectKey;
    await createFilesystemObjectStorage(instance.filesRoot).put(
      object,
      new TextEncoder().encode("Jetzt mit Text.")
    );
    const again = await instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [empty.id] }
    });
    expect(again.statusCode, again.body).toBe(200);
    await runJobs(instance);
    expect(byId((await list(instance)).documents).get(empty.id)).toMatchObject({
      state: "indexed"
    });
    expect(
      (await chunkRows(record)).filter((chunk) => chunk.text === "Jetzt mit Text.")
    ).toHaveLength(1);

    const unknown = await instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: ["kbdoc_unknown"] }
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorSchema.parse(unknown.json()).error.details?.reason).toBe(
      "knowledge_documents_not_found"
    );
  });

  it("pages the list of documents newest first", async () => {
    const { instance } = await instanceWith();
    for (const name of ["a", "b", "c"]) {
      await add(instance, { filename: `${name}.txt`, contentType: "text/plain", content: name });
    }
    const first = await list(instance, { limit: "2" });
    expect(first.documents.map((document) => document.fileName)).toEqual(["c.txt", "b.txt"]);
    const second = await list(instance, { limit: "2", cursor: required(first.nextCursor) });
    expect(second).toMatchObject({ documents: [{ fileName: "a.txt" }] });
    expect(second.nextCursor).toBeUndefined();
  });

  it("fails a PDF with the contract's code where no extraction serves it", async () => {
    const { instance, record } = await instanceWith();
    const document = await add(instance, {
      filename: "Heizung.txt",
      contentType: "text/plain",
      content: "Heizung"
    });
    // A PDF that reached the store, as on an instance whose document processing was turned off.
    await inStore(record, (sql) => sql`update catalyst_kb.contents set format = 'pdf'`);
    await runJobs(instance);
    expect((await list(instance)).documents).toMatchObject([
      { id: document.id, state: "failed", failureCode: "knowledge_file_format_unavailable" }
    ]);
  });

  it("hands a PDF to the extract job and indexes the pages it stores, and stores a failure for an unreadable one", async () => {
    const { instance, record } = await instanceWith({ documents: true });
    const objects = createFilesystemObjectStorage(instance.filesRoot);
    const extractWorker = createJobWorker({
      stores: instance.stores,
      clientInstanceId,
      logger: silent,
      handlers: [
        defineKnowledgeExtractHandler({
          clientInstanceId,
          objects,
          extractor: fakeExtractor,
          maxPages: 500,
          slots: 1
        })
      ]
    });
    const pdf = await add(instance, {
      filename: "Expose.pdf",
      contentType: "application/pdf",
      content: "%FAKE-PDF\nLage und Umgebung\fGrundriss Erdgeschoss"
    });
    const broken = await add(instance, {
      filename: "Kaputt.pdf",
      contentType: "application/pdf",
      content: "%PDF-1.7 not readable"
    });
    // The index job asks for extraction and leaves the document pending.
    await runJobs(instance);
    expect((await list(instance)).documents.map((document) => document.state)).toEqual([
      "pending",
      "pending"
    ]);
    await eventually(async () => {
      await extractWorker.runDue();
      await runJobs(instance);
      const listed = new Map(
        (await list(instance)).documents.map((document) => [document.id, document])
      );
      expect(listed.get(pdf.id)).toMatchObject({ state: "indexed" });
      expect(listed.get(broken.id)).toMatchObject({
        state: "failed",
        failureCode: "knowledge_file_unreadable"
      });
    });
    const pages = await inStore(
      record,
      (sql) => sql<{ page: number; text: string }[]>`select page, text from catalyst_kb.chunks
        order by position`
    );
    expect(pages).toEqual([
      { page: 1, text: "Lage und Umgebung" },
      { page: 2, text: "Grundriss Erdgeschoss" }
    ]);
    const extracted = await inStore(
      record,
      (sql) => sql<{ extraction_revision: number; page_count: number }[]>`
        select extraction_revision, page_count from catalyst_kb.contents where state = 'extracted'`
    );
    expect(extracted).toEqual([{ extraction_revision: 1, page_count: 2 }]);
    // The failure is stored on the content and its stored result removed, so Retry extracts again.
    const brokenSha = sha256("%PDF-1.7 not readable");
    await expect(objects.head(knowledgeExtractionKey(record.id, brokenSha))).rejects.toThrow();
    await expect(
      objects.head(
        knowledgeExtractionKey(
          record.id,
          sha256("%FAKE-PDF\nLage und Umgebung\fGrundriss Erdgeschoss")
        )
      )
    ).resolves.toMatchObject({ size: expect.any(Number) });
    await extractWorker.stop();
  });

  it("extracts a failed or empty PDF afresh on Retry, and indexes a stored text again without extraction", async () => {
    const { instance, record } = await instanceWith({ documents: true });
    const objects = createFilesystemObjectStorage(instance.filesRoot);
    // An extractor that first answers no text and fails, then is fixed.
    let fixed = false;
    let extractions = 0;
    const extractor: KnowledgeExtractor = {
      revision: 1,
      extract({ bytes }) {
        extractions += 1;
        const text = new TextDecoder().decode(bytes);
        if (fixed) return Promise.resolve({ pages: [{ page: 1, text: `Gelesen ${text}` }] });
        if (text.includes("leer")) return Promise.resolve({ pages: [{ page: 1, text: " \n " }] });
        return Promise.reject(new KnowledgeExtractionError("knowledge_file_unreadable", "No PDF"));
      }
    };
    const extractWorker = createJobWorker({
      stores: instance.stores,
      clientInstanceId,
      logger: silent,
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
    const settle = async () => {
      for (let round = 0; round < 4; round += 1) {
        await runJobs(instance);
        await extractWorker.runDue();
      }
      await runJobs(instance);
    };
    const empty = await add(instance, {
      filename: "Leer.pdf",
      contentType: "application/pdf",
      content: "leer"
    });
    const broken = await add(instance, {
      filename: "Kaputt.pdf",
      contentType: "application/pdf",
      content: "kaputt"
    });
    await settle();
    expect(
      new Map((await list(instance)).documents.map((document) => [document.id, document]))
    ).toEqual(
      new Map([
        [
          empty.id,
          expect.objectContaining({ state: "failed", failureCode: "knowledge_text_empty" })
        ],
        [
          broken.id,
          expect.objectContaining({ state: "failed", failureCode: "knowledge_file_unreadable" })
        ]
      ])
    );
    // No result without text is kept for Retry to read.
    const emptyKey = knowledgeExtractionKey(record.id, sha256("leer"));
    await expect(objects.head(emptyKey)).rejects.toThrow();
    // A job that ended between storing the failure and deleting its result left it behind.
    await storeKnowledgeExtraction(
      objects,
      { knowledgeBaseId: record.id, contentSha256: sha256("kaputt") },
      { status: "failed", code: "knowledge_file_unreadable" }
    );

    fixed = true;
    const before = extractions;
    const retried = await instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [empty.id, broken.id] }
    });
    expect(retried.statusCode, retried.body).toBe(200);
    await settle();
    expect((await list(instance)).documents.map((document) => document.state)).toEqual([
      "indexed",
      "indexed"
    ]);
    expect(extractions - before).toBe(2);
    const texts = await inStore(
      record,
      (sql) => sql<{ text: string }[]>`select text from catalyst_kb.chunks order by text`
    );
    expect(texts).toEqual([{ text: "Gelesen kaputt" }, { text: "Gelesen leer" }]);

    // A new chunking revision indexes the stored text again and extracts nothing.
    await inStore(record, (sql) => sql`update catalyst_kb.contents set chunking_revision = 0`);
    const reindexed = extractions;
    for (const document of [empty, broken]) {
      const content = document === empty ? "leer" : "kaputt";
      await enqueueKnowledgeIndex(
        instance.stores.jobs,
        {
          knowledgeBaseId: record.id,
          contentSha256: sha256(content),
          fileId: document.fileId,
          operationRunId: "reindex"
        },
        { clientInstanceId }
      );
    }
    await settle();
    expect(extractions).toBe(reindexed);
    expect(
      await inStore(
        record,
        (sql) => sql<{ chunking_revision: number; state: string }[]>`
          select chunking_revision, state from catalyst_kb.contents`
      )
    ).toEqual([
      { chunking_revision: 1, state: "extracted" },
      { chunking_revision: 1, state: "extracted" }
    ]);
    await extractWorker.stop();
  });

  it("persists a conversion timeout and its page count through extraction, indexing and listing", async () => {
    const { instance } = await instanceWith({ documents: true, maxPagesPerDocument: 8_000 });
    const objects = createFilesystemObjectStorage(instance.filesRoot);
    const document = await add(instance, {
      filename: "long.pdf",
      contentType: "application/pdf",
      content: "%FAKE-PDF\nlong"
    });
    const worker = createJobWorker({
      stores: instance.stores,
      clientInstanceId,
      logger: silent,
      handlers: [
        defineKnowledgeExtractHandler({
          clientInstanceId,
          objects,
          maxPages: 8_000,
          slots: 1,
          extractor: {
            revision: 1,
            extract: async () => {
              throw new KnowledgeExtractionError("knowledge_conversion_timeout", "Too slow", 6_001);
            }
          }
        })
      ]
    });
    try {
      await runJobs(instance);
      await worker.runDue();
      await runJobs(instance);
      expect((await list(instance)).documents.find((row) => row.id === document.id)).toMatchObject({
        state: "failed",
        failureCode: "knowledge_conversion_timeout",
        failurePageCount: 6_001
      });
    } finally {
      await worker.stop();
    }
  });

  it("fails a PDF over the page limit with its code before converting it, indexes one at the limit, and Retry after a raised limit indexes it", async () => {
    // The API already runs the raised release config while the old extraction worker drains.
    // Both processing stages therefore accept the raised limit once that worker restarts.
    const { instance } = await instanceWith({ documents: true, maxPagesPerDocument: 1_000 });
    const objects = createFilesystemObjectStorage(instance.filesRoot);
    // Counts the pages first, as the capability does from the PDF's metadata, and converts
    // only a file within the limit it is given.
    const converted: number[] = [];
    const extractor: KnowledgeExtractor = {
      revision: 1,
      async extract(input) {
        const pages = (await fakeExtractor.extract(input)).pages;
        if (pages.length > input.maxPages) {
          throw new KnowledgeExtractionError("knowledge_file_too_many_pages", "Too many pages");
        }
        converted.push(pages.length);
        return { pages };
      }
    };
    const extractWorkerWith = (maxPages: number) =>
      createJobWorker({
        stores: instance.stores,
        clientInstanceId,
        logger: silent,
        handlers: [
          defineKnowledgeExtractHandler({
            clientInstanceId,
            objects,
            extractor,
            maxPages,
            slots: 1
          })
        ]
      });
    const settle = async (worker: ReturnType<typeof extractWorkerWith>) => {
      for (let round = 0; round < 4; round += 1) {
        await runJobs(instance);
        await worker.runDue();
      }
      await runJobs(instance);
    };
    const pdfOf = (pages: number, word: string) =>
      `%FAKE-PDF\n${Array.from({ length: pages }, (_, index) => `${word} ${index + 1}`).join("\f")}`;
    const long = await add(instance, {
      filename: "Akte.pdf",
      contentType: "application/pdf",
      content: pdfOf(600, "Akte")
    });
    const atLimit = await add(instance, {
      filename: "Handbuch.pdf",
      contentType: "application/pdf",
      content: pdfOf(500, "Handbuch")
    });
    const worker = extractWorkerWith(500);
    await settle(worker);
    await worker.stop();
    expect(
      new Map((await list(instance)).documents.map((document) => [document.id, document]))
    ).toEqual(
      new Map([
        [
          long.id,
          expect.objectContaining({
            state: "failed",
            failureCode: "knowledge_file_too_many_pages",
            failurePageLimit: 1_000
          })
        ],
        [atLimit.id, expect.objectContaining({ state: "indexed" })]
      ])
    );
    expect(converted).toEqual([500]);

    // The operator raises the limit, the worker restarts, and Retry extracts the file again.
    const raised = extractWorkerWith(1_000);
    const retried = await instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [long.id] }
    });
    expect(retried.statusCode, retried.body).toBe(200);
    await settle(raised);
    await raised.stop();
    expect((await list(instance)).documents.map((document) => document.state)).toEqual([
      "indexed",
      "indexed"
    ]);
    expect(converted).toEqual([500, 600]);
  });
});
