import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeAgentDataTools, materializeModelTools } from "@work-shape/catalyst-agent-runtime";
import {
  asAgentRunId,
  asToolCallId,
  asUserId,
  fuseByReciprocalRank,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_QUERY_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  knowledgeSearchOperationName,
  type AgentConfig,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
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

// Search over the documents of a Knowledge Base on the built-in backend and the agent tool over
// an agent's Knowledge Bases (KB-7a): German and English full text and titles fused by
// reciprocal rank, cosine over the active generation where there is one, withdrawn documents
// left out in the same statement, `knowledge_base.use` on every call, one recorded run per
// Knowledge Base, and no query text in a run, an audit row or a log line. Spec:
// data-stores-and-knowledge-bases.md, "Search, the agent tool and citations", checks 10, 23,
// 32 and 35 to 37.

const developmentAuth = {
  enabled: true,
  users: [
    { id: "user-1", roles: ["user", "admin", "superadmin"] },
    { id: "member-1", roles: ["user"] }
  ].map((user) => ({ ...user, externalUserId: user.id, displayLabel: user.id, permissionRefs: [] }))
};

const MIETVERTRAG = [
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

const passageSchema = z.object({
  ref: z.string(),
  knowledgeBase: z.string(),
  documentId: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  title: z.string(),
  page: z.number().optional(),
  heading: z.string().optional(),
  text: z.string(),
  score: z.number(),
  originLink: z.string().optional()
});
const searchSchema = z.object({
  passages: z.array(passageSchema),
  signals: z.array(z.enum(["semantic", "keyword", "title"]))
});
const toolOutputSchema = z.object({
  passages: z.array(passageSchema),
  skipped: z
    .array(z.object({ knowledgeBase: z.string(), reason: z.string(), message: z.string() }))
    .optional()
});
const addedSchema = z.object({
  documents: z.array(z.object({ id: z.string(), fileId: z.string() }))
});
const uploadedSchema = z.object({ attachment: z.object({ fileId: z.string() }) });

interface TextFile {
  filename: string;
  content: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The vector the deterministic adapter answers for `text`, as `embedDeterministically` makes it. */
function deterministicVector(text: string, dimensions: number): number[] {
  const values: number[] = [];
  for (let round = 0; values.length < dimensions; round += 1) {
    const digest = createHash("sha256").update(`${round}\u0000${text}`).digest();
    for (const byte of digest.subarray(0, Math.min(32, dimensions - values.length))) {
      values.push(byte / 127.5 - 1);
    }
  }
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / length);
}

describe("fusing ranked lists by reciprocal rank", () => {
  it("adds 1 / (60 + place) over the lists, so a passage in two lists beats the top of one", () => {
    const fused = fuseByReciprocalRank(
      [
        ["b", "a", "c"],
        ["a", "d"]
      ],
      (entry) => entry
    );
    expect(fused.map(({ entry }) => entry)).toEqual(["a", "b", "d", "c"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    // A tie keeps the order of the lists: the first list's place wins.
    expect(
      fuseByReciprocalRank([["x"], ["y"]], (entry) => entry).map(({ entry }) => entry)
    ).toEqual(["x", "y"]);
  });
});

describe("searching the documents of a Knowledge Base", () => {
  const { start, person, publishStore } = useDataStoreInstance();
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function instanceWith(options: { embedding?: true } = {}) {
    const attachments = createManagedObjectTestAttachmentCapability();
    return start(true, undefined, developmentAuth, undefined, {
      attachments: attachments.capability,
      ...options
    });
  }

  /** Writes and publishes a Knowledge Base that keeps documents, and answers its store. */
  async function publishKnowledgeBase(
    world: DataStoreInstance,
    name: string,
    config: JsonObject = {}
  ): Promise<DataStoreRecord> {
    const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name };
    const written = await world.api.call("assets.put", {
      params,
      payload: {
        config: {
          name,
          title: name,
          description: `Documents of ${name}.`,
          methods: ["keyword"],
          ...config
        },
        expectedRevision: null
      }
    });
    expect(written.statusCode, written.body).toBe(200);
    const made = await world.api.call("assets.publish", { params, payload: { revision: 1 } });
    expect(made.statusCode, made.body).toBe(200);
    return eventually(async () => {
      await getTestJobs(world.api).runDue();
      const record = await world.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${name}`
      });
      expect(record).toMatchObject({ status: "ready", level: 12 });
      return required(record);
    });
  }

  /** Adds text files through a Conversation of the administrator and indexes them. */
  async function addFiles(
    world: DataStoreInstance,
    knowledgeBase: string,
    files: readonly TextFile[]
  ): Promise<{ id: string; fileId: string }[]> {
    const created = await world.api.call("conversations.create", {
      payload: { title: "Unterlagen" }
    });
    const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
    const refs: { conversationId: string; fileId: string }[] = [];
    for (const file of files) {
      const upload = createMultipartFilePayload({
        fieldName: "file",
        filename: file.filename,
        contentType: file.filename.endsWith(".md") ? "text/markdown" : "text/plain",
        content: file.content
      });
      const uploaded = await world.api.call("conversations.draft_attachments.upload", {
        params: { conversationId },
        headers: upload.headers,
        payload: upload.payload
      });
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      refs.push({
        conversationId,
        fileId: uploadedSchema.parse(uploaded.json()).attachment.fileId
      });
    }
    const added = await world.api.call("knowledge_bases.add_files", {
      params: { knowledgeBase },
      payload: { files: refs }
    });
    expect(added.statusCode, added.body).toBe(200);
    await getTestJobs(world.api).runDue();
    return addedSchema.parse(added.json()).documents;
  }

  async function search(
    world: DataStoreInstance,
    knowledgeBase: string,
    payload: JsonObject,
    headers: Record<string, string> = {}
  ) {
    const answered = await world.api.call("knowledge_bases.search", {
      params: { knowledgeBase },
      payload,
      headers
    });
    expect(answered.statusCode, answered.body).toBe(200);
    return searchSchema.parse(answered.json());
  }

  async function inStore<T>(record: DataStoreRecord, work: (sql: postgres.Sql) => Promise<T>) {
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      return await work(sql);
    } finally {
      await sql.end();
    }
  }

  it("finds passages by German and English stems with file, heading and ref, and never a withdrawn document", async () => {
    const instance = await instanceWith();
    const record = await publishKnowledgeBase(instance, "objekte");
    const [mietvertrag, heating] = await addFiles(instance, "objekte", [
      { filename: "Mietvertrag.md", content: MIETVERTRAG },
      { filename: "heating.txt", content: "The heating systems were renewed in 2019." }
    ]);

    // German: the plural finds the singular. The passage names its document and file.
    const german = await search(instance, "objekte", { query: "Kautionen" });
    expect(german.signals).toEqual(["keyword", "title"]);
    expect(german.passages[0]).toMatchObject({
      ref: "K1",
      knowledgeBase: "objekte",
      documentId: mietvertrag?.id,
      fileId: mietvertrag?.fileId,
      fileName: "Mietvertrag.md",
      title: "Mietvertrag",
      heading: "Mietvertrag > Kaution",
      text: expect.stringContaining("drei Monatsmieten")
    });
    expect(german.passages).toHaveLength(1);
    // English: "renewing heating system" finds "heating systems were renewed".
    const english = await search(instance, "objekte", { query: "renewing heating system" });
    expect(english.passages.map((passage) => passage.documentId)).toEqual([heating?.id]);
    // The title alone: every passage of the Mietvertrag shares its place.
    const titled = await search(instance, "objekte", { query: "Mietvertrag", limit: 2 });
    expect(titled.passages).toHaveLength(2);
    expect(new Set(titled.passages.map((passage) => passage.documentId))).toEqual(
      new Set([mietvertrag?.id])
    );

    // Withdrawn: out of the next search in the same statement, while its passages still exist.
    await inStore(
      record,
      (sql) =>
        sql`update catalyst_kb.documents set withdrawn_at = now() where id = ${mietvertrag?.id ?? ""}`
    );
    expect((await search(instance, "objekte", { query: "Kautionen" })).passages).toEqual([]);
    expect((await search(instance, "objekte", { query: "Mietvertrag" })).passages).toEqual([]);
    const held = await inStore(
      record,
      (sql) => sql<{ count: number }[]>`select count(*)::int as count from catalyst_kb.chunks
        where content_sha256 = ${sha256(MIETVERTRAG)}`
    );
    expect(held[0]?.count).toBeGreaterThan(0);
  });

  it("C12 finds relevant passages for full German and English questions without weakening explicit search syntax", async () => {
    const instance = await instanceWith();
    await publishKnowledgeBase(instance, "questions");
    await addFiles(instance, "questions", [
      {
        filename: "notes.txt",
        content: "Die Kaution beträgt drei Monatsmieten. The deposit equals three monthly rents."
      }
    ]);
    for (const query of [
      "Wie hoch ist die Kaution für diese Wohnung?",
      "How much deposit is required for this apartment?"
    ]) {
      const answer = await search(instance, "questions", { query });
      expect(answer.passages.some((hit) => hit.text.includes("drei Monatsmieten"))).toBe(true);
    }
    expect(
      (await search(instance, "questions", { query: '\"Kaution Wohnung\"' })).passages
    ).toEqual([]);
    expect(
      (await search(instance, "questions", { query: "Kaution -Monatsmieten" })).passages
    ).toEqual([]);
    expect((await search(instance, "questions", { query: "unfindableword" })).passages).toEqual([]);
    expect((await search(instance, "questions", { query: "' ; --" })).passages).toEqual([]);
  });

  it("ranks a passage in the keyword and the title list above one that is only first by words", async () => {
    const instance = await instanceWith();
    await publishKnowledgeBase(instance, "regeln");
    const [hausordnung, kaution] = await addFiles(instance, "regeln", [
      {
        filename: "Hausordnung.txt",
        content: "Kaution Kaution Kaution. Die Kaution wird verzinst, die Kaution ist sicher."
      },
      { filename: "Kaution.txt", content: "Hinterlegt wird eine Kaution." }
    ]);
    const answer = await search(instance, "regeln", { query: "Kaution" });
    // By words alone the Hausordnung is first; Kaution.txt is second there and first by title.
    expect(answer.passages.map((passage) => passage.documentId)).toEqual([
      kaution?.id,
      hausordnung?.id
    ]);
    expect(answer.passages[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 9);
    expect(answer.passages[1]?.score).toBeCloseTo(1 / 61, 9);
  });

  it("answers a keyword Knowledge Base without a model call, and records only a hash of the query", async () => {
    const instance = await instanceWith({ embedding: true });
    await publishKnowledgeBase(instance, "glossar");
    await addFiles(instance, "glossar", [
      {
        filename: "Begriffe.md",
        content: "# Grundschuld\n\nEine Grundschuld sichert ein Darlehen."
      }
    ]);
    const marker = "Grundschuldbestellungsurkunde Darlehen";
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const answer = await search(instance, "glossar", { query: "Grundschuld" });
    expect(answer.passages).toHaveLength(1);
    await search(instance, "glossar", { query: marker });
    // A query the schema refuses fails without naming it either.
    const refused = await instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: "glossar" },
      payload: { query: marker, limit: 51 }
    });
    expect(refused.statusCode).toBe(422);
    vi.restoreAllMocks();

    expect(await instance.stores.usage.listModelUsageEvents({ clientInstanceId })).toEqual([]);
    const runs = (await instance.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.operation === knowledgeSearchOperationName("glossar")
    );
    expect(runs.length).toBeGreaterThanOrEqual(2);
    const audit = await instance.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "knowledge_base.searched",
      limit: 10
    });
    expect(audit).toHaveLength(2);
    expect(audit.map((event) => event.metadata)).toContainEqual(
      expect.objectContaining({
        knowledgeBase: "glossar",
        queryHash: sha256(marker),
        // The plain-query fallback finds Darlehen even though the compound word is absent.
        results: 1,
        signals: ["keyword", "title"]
      })
    );
    const kept = JSON.stringify([runs, audit, written]);
    expect(kept).not.toContain("Grundschuldbestellungsurkunde");
    expect(kept).not.toContain("Begriffe.md");
    expect(kept).not.toContain("sichert ein Darlehen");
  });

  it("fuses cosine over the active generation, records the query's embedding, and falls back to words without one", async () => {
    const instance = await instanceWith({ embedding: true });
    const record = await publishKnowledgeBase(instance, "expose", {
      methods: ["semantic", "keyword"]
    });
    const question = "Wo befindet sich das Objekt?";

    // No generation yet, before any document: words and titles answer, and no model is asked.
    const before = await search(instance, "expose", { query: question });
    expect(before.signals).toEqual(["keyword", "title"]);
    expect(before.passages).toEqual([]);
    expect(await instance.stores.usage.listModelUsageEvents({ clientInstanceId })).toEqual([]);

    // The index job embeds the passages into generation 1. The passage on the location gets
    // the question's own vector, so it is the nearest; no word of the question is in it.
    await addFiles(instance, "expose", [
      { filename: "Lage.txt", content: "Die Wohnung liegt ruhig am Stadtpark." },
      { filename: "Ausstattung.txt", content: "Einbauküche und Fußbodenheizung." }
    ]);
    await inStore(record, async (sql) => {
      const [generation] = await sql<{ generation: number; dimensions: number }[]>`
        select generation, dimensions from catalyst_kb.index_generations where state = 'active'`;
      expect(generation).toEqual({ generation: 1, dimensions: 8 });
      const embedded = await sql<{ count: number }[]>`
        select count(*)::int as count from catalyst_kb.embeddings_1`;
      expect(embedded[0]?.count).toBe(2);
      await sql`update catalyst_kb.embeddings_1 set embedding =
          ${`[${deterministicVector(question, 8).join(",")}]`}::public.halfvec(8)
        where chunk_id in (select id from catalyst_kb.chunks where text like '%Stadtpark%')`;
    });
    const after = await search(instance, "expose", { query: question, limit: 1 });
    expect(after.signals).toEqual(["semantic", "keyword", "title"]);
    expect(after.passages).toMatchObject([
      { fileName: "Lage.txt", text: expect.stringContaining("Stadtpark") }
    ]);
    const runs = (await instance.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.operation === knowledgeSearchOperationName("expose")
    );
    const events = (await instance.stores.usage.listModelUsageEvents({ clientInstanceId })).filter(
      (event) => event.purpose === "knowledge_query"
    );
    expect(events).toMatchObject([{ bindingId: "embedding", status: "settled" }]);
    expect(runs.map((run) => run.id)).toContain(events[0]?.operationRunId);
  });

  describe("through the agent tool", () => {
    const agentOf = (knowledgeBases: string[]): AgentConfig => ({
      name: "berater",
      displayName: "Berater",
      instructions: "Answer from the documents.",
      modelProviderId: "local",
      toolNames: [],
      skillNames: [],
      knowledgeBases,
      initialPrompts: []
    });

    async function putAgent(
      world: DataStoreInstance,
      knowledgeBases: string[],
      revision: number | null
    ) {
      const saved = await world.api.call("assets.put", {
        params: { kind: "agent", name: "berater" },
        payload: { config: agentOf(knowledgeBases), expectedRevision: revision }
      });
      expect(saved.statusCode, saved.body).toBe(200);
    }

    async function conversationOf(
      world: DataStoreInstance,
      user: AuthenticatedUser,
      usedIn?: CollaborationWorkspaceId
    ) {
      const workspace = await world.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(user.id)
      });
      return world.stores.conversations.createConversation({
        clientInstanceId,
        collaborationWorkspaceId: usedIn ?? workspace.id,
        createdByUserId: user.id,
        createdByExternalUserId: user.id,
        visibility: "private",
        title: "Fragen",
        retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
      });
    }

    async function seeded(world: DataStoreInstance) {
      for (const [name, file] of [
        ["mieten", { filename: "Mietvertrag.md", content: MIETVERTRAG }],
        [
          "kautionen",
          { filename: "Kautionsbuch.txt", content: "Die Kaution liegt auf dem Treuhandkonto." }
        ],
        [
          "protokolle",
          { filename: "Protokoll.txt", content: "Die Kaution wurde im Protokoll erwähnt." }
        ]
      ] as const) {
        await publishKnowledgeBase(world, name);
        await addFiles(world, name, [file]);
      }
    }

    it("is one tool over every Knowledge Base with documents; a third adds only to its description, one of tables adds knowledge.query", async () => {
      const instance = await instanceWith();
      await seeded(instance);
      await publishStore(instance);
      const params = { kind: KNOWLEDGE_BASE_ASSET_KIND, name: "befunde" };
      const written = await instance.api.call("assets.put", {
        params,
        payload: {
          config: {
            name: "befunde",
            title: "Befunde",
            description: "What the monthly check found.",
            methods: ["structured"],
            backend: { dataStore: "findings" },
            tables: [{ name: "findings", description: "One row per finding of a run." }]
          },
          expectedRevision: null
        }
      });
      expect(written.statusCode, written.body).toBe(200);
      const made = await instance.api.call("assets.publish", { params, payload: { revision: 1 } });
      expect(made.statusCode, made.body).toBe(200);
      const runtime = instance.execution.localAgentRuntimeOptions;
      const toolsOf = async (knowledgeBases: string[]) => {
        const agent = agentOf(knowledgeBases);
        const tools = await describeAgentDataTools(agent, runtime.dataTools, 10_000);
        expect(tools.missing).toEqual([]);
        const offered = materializeModelTools({
          agent,
          capabilities: { nativeTools: [] },
          toolRegistry: { listDescriptorsForAgent: () => [] },
          dataTools: tools.described
        });
        return {
          offered: offered.map((tool) => tool.name),
          search: tools.described.find((tool) => tool.name === KNOWLEDGE_SEARCH_TOOL_NAME),
          query: tools.described.find((tool) => tool.name === KNOWLEDGE_QUERY_TOOL_NAME)
        };
      };
      const two = await toolsOf(["mieten", "kautionen"]);
      expect(two.offered).toEqual([KNOWLEDGE_SEARCH_TOOL_NAME]);
      const three = await toolsOf(["mieten", "kautionen", "protokolle"]);
      expect(three.offered).toEqual([KNOWLEDGE_SEARCH_TOOL_NAME]);
      expect(two.search?.description).not.toContain("protokolle");
      expect(three.search?.description).toContain(
        '- protokolle ("protokolle"): Documents of protokolle.'
      );
      expect(three.search?.description).toContain("[K1]");
      expect(three.search?.inputJsonSchema).toMatchObject({
        required: ["query"],
        properties: { knowledgeBases: { items: { enum: ["kautionen", "mieten", "protokolle"] } } }
      });
      // One of tables adds `knowledge.query`, which names its tables, and nothing else.
      const mixed = await toolsOf(["mieten", "kautionen", "befunde"]);
      expect([...mixed.offered].sort()).toEqual(
        [KNOWLEDGE_QUERY_TOOL_NAME, KNOWLEDGE_SEARCH_TOOL_NAME].sort()
      );
      expect(mixed.query?.description).toContain("findings");
      expect(mixed.query?.description).not.toContain("mieten");
      expect(mixed.search?.description).not.toContain("befunde");
    });

    it("answers one ranked list naming each Knowledge Base, narrows to the named ones, refuses one not assigned, and skips one the person may not use", async () => {
      const instance = await instanceWith();
      await seeded(instance);
      await putAgent(instance, ["mieten", "kautionen", "protokolle"], null);
      const runtime = instance.execution.localAgentRuntimeOptions;
      const admin = await person(instance, "user-1", ["user", "admin", "superadmin"]);
      const member = await person(instance, "member-1", ["user"]);
      let call = 0;
      let usedIn: CollaborationWorkspaceId | undefined;
      const ask = async (
        user: AuthenticatedUser,
        input: JsonObject,
        runId = "run-1",
        locale: "en" | "de" = "en"
      ) => {
        const conversation = await conversationOf(instance, user, usedIn);
        call += 1;
        return runtime.runTool(
          {
            toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
            toolCallId: asToolCallId(`call-${call}`),
            agentRunId: asAgentRunId(runId),
            conversationId: conversation.id,
            agentName: "berater",
            input
          },
          { clientInstanceId, user, locale, correlationId: `corr_search_${call}` }
        );
      };

      // All three: one list, each passage naming its Knowledge Base, refs unique in the run.
      const all = await ask(admin, { query: "Kaution" });
      expect(all.status).toBe("success");
      const merged = toolOutputSchema.parse(all.status === "success" ? all.output : undefined);
      expect(new Set(merged.passages.map((passage) => passage.knowledgeBase))).toEqual(
        new Set(["mieten", "kautionen", "protokolle"])
      );
      expect(merged.passages.map((passage) => passage.ref)).toEqual(
        merged.passages.map((_, index) => `K${index + 1}`)
      );
      expect(merged.skipped).toBeUndefined();
      // The narrowing parameter: only the named one, and refs go on within the same run.
      const narrowed = await ask(admin, { query: "Kaution", knowledgeBases: ["kautionen"] });
      const only = toolOutputSchema.parse(
        narrowed.status === "success" ? narrowed.output : undefined
      );
      expect(only.passages.map((passage) => [passage.knowledgeBase, passage.ref])).toEqual([
        ["kautionen", `K${merged.passages.length + 1}`]
      ]);
      // A Knowledge Base not assigned to the agent is refused, and nothing is searched.
      expect(await ask(admin, { query: "Kaution", knowledgeBases: ["fremd"] })).toMatchObject({
        status: "failed",
        error: { code: "not_allowed", details: { reason: "knowledge_base_not_assigned" } }
      });

      const workspace = await instance.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Nordlicht",
        creatorUserId: asUserId(admin.id)
      });
      await instance.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        userId: asUserId(member.id),
        role: "member"
      });
      usedIn = workspace.id;
      // Upgrade and new assets grant no use until somebody explicitly saves availability.
      expect(await ask(member, { query: "Kaution" })).toMatchObject({
        status: "failed",
        error: { code: "permission_missing", message: expect.stringContaining("permission") }
      });
      const germanRefusal = await ask(member, { query: "Kaution" }, "run-de", "de");
      expect(germanRefusal).toMatchObject({
        status: "failed",
        error: { code: "permission_missing", message: expect.stringContaining("user-1") }
      });
      expect(germanRefusal.status === "failed" ? germanRefusal.error.message : "").toContain(
        "Dir fehlt das Recht"
      );
      expect(JSON.stringify(germanRefusal)).not.toMatch(/no_access|not_allowed/u);
      for (const name of ["mieten", "kautionen"]) {
        const granted = await instance.api.call("assets.set_availability", {
          params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name },
          payload: { mode: "selected", collaborationWorkspaceIds: [workspace.id] }
        });
        expect(granted.statusCode, granted.body).toBe(200);
      }
      const before = (await instance.stores.operationRuns.list({ clientInstanceId })).length;
      const partial = await ask(member, { query: "Kaution" }, "run-2");
      const answer = toolOutputSchema.parse(
        partial.status === "success" ? partial.output : undefined
      );
      expect(new Set(answer.passages.map((passage) => passage.knowledgeBase))).toEqual(
        new Set(["mieten", "kautionen"])
      );
      expect(answer.passages[0]?.ref).toBe("K1");
      expect(answer.skipped).toEqual([
        {
          knowledgeBase: "protokolle",
          reason: "permission_missing",
          message: expect.stringContaining("permission")
        }
      ]);
      // Each Knowledge Base searched is its own recorded call, the refused one included.
      const runs = (await instance.stores.operationRuns.list({ clientInstanceId }))
        .slice(0, (await instance.stores.operationRuns.list({ clientInstanceId })).length - before)
        .filter((run) => run.origin.kind === "agent");
      expect(runs.map((run) => [run.operation, run.status]).sort()).toEqual(
        [
          [knowledgeSearchOperationName("kautionen"), "done"],
          [knowledgeSearchOperationName("mieten"), "done"],
          [knowledgeSearchOperationName("protokolle"), "denied"]
        ].sort()
      );
      expect(runs.every((run) => run.actor.id === member.id)).toBe(true);
      const secondWorkspace = await instance.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Other shared chat",
        creatorUserId: asUserId(admin.id)
      });
      await instance.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: secondWorkspace.id,
        userId: asUserId(member.id),
        role: "member"
      });
      usedIn = secondWorkspace.id;
      expect(await ask(member, { query: "Kaution", knowledgeBases: ["kautionen"] })).toMatchObject({
        status: "failed",
        error: { code: "permission_missing" }
      });
      usedIn = workspace.id;
      const kb = required(
        await instance.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: KNOWLEDGE_BASE_ASSET_KIND,
          name: "mieten"
        })
      );
      await instance.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: member.id,
        action: KNOWLEDGE_BASE_ACTIONS.use,
        effect: "deny",
        scopeKind: "asset",
        scopeId: kb.id,
        grantedBy: asUserId(admin.id)
      });
      expect(await ask(member, { query: "Kaution", knowledgeBases: ["mieten"] })).toMatchObject({
        status: "failed",
        error: { code: "permission_missing" }
      });
      await instance.stores.workspaces.removeMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        userId: asUserId(member.id)
      });
      const other = await instance.stores.workspaces.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name: "Other team",
        creatorUserId: asUserId(admin.id)
      });
      await instance.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: other.id,
        userId: asUserId(member.id),
        role: "member"
      });
      expect(await ask(member, { query: "Kaution", knowledgeBases: ["kautionen"] })).toMatchObject({
        status: "failed",
        error: { code: "permission_missing" }
      });
    });
  });
});
