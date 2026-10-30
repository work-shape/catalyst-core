import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeAgentDataTools } from "@work-shape/catalyst-agent-runtime";
import {
  asAgentRunId,
  asToolCallId,
  asUserId,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  knowledgeOriginLinkSchema,
  readKnowledgeCitationSources,
  type AgentConfig,
  type AuthenticatedUser,
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

// DS-6b. The origin link of a document: a link to where its original lives, which a synced
// source fills and which the builder enters, changes or clears for a file added by hand. It is
// only ever an http or https address without a credential, it reaches only readers of the
// Knowledge Base (the document list and the search's passages), every change is audited by
// document id and never by the link, and a citation then offers the stored copy at its page
// and the original (check 44). Declared filters: the `filters` field of a Knowledge Base on the
// built-in backend, applied to document fields with every value bound as a parameter, refused
// where not declared, and listed in the agent's generated tool description. Spec:
// data-stores-and-knowledge-bases.md, "Origin link", "Filters", "Assigning knowledge bases to an
// agent", check 44.

const developmentAuth = {
  enabled: true,
  users: [
    { id: "user-1", roles: ["user", "admin", "superadmin"] },
    { id: "member-1", roles: ["user"] }
  ].map((user) => ({ ...user, externalUserId: user.id, displayLabel: user.id, permissionRefs: [] }))
};

const asMember = { "x-dev-user-id": "member-1" };

const ORIGINAL = "https://dms.example.test/akten/4711/mietvertrag.pdf";

const passageSchema = z.object({
  ref: z.string(),
  knowledgeBase: z.string(),
  documentId: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  title: z.string(),
  page: z.number().optional(),
  text: z.string(),
  originLink: z.string().optional()
});
const searchSchema = z.object({ passages: z.array(passageSchema) });
const toolOutputSchema = z.object({
  passages: z.array(passageSchema),
  skipped: z
    .array(z.object({ knowledgeBase: z.string(), reason: z.string(), message: z.string() }))
    .optional()
});
const documentsSchema = z.object({
  documents: z.array(
    z.object({ id: z.string(), fileName: z.string(), originLink: z.string().optional() })
  )
});
const addedSchema = z.object({
  documents: z.array(z.object({ id: z.string(), fileId: z.string() }))
});
const uploadedSchema = z.object({ attachment: z.object({ fileId: z.string() }) });

describe("the origin link and declared filters of a Knowledge Base (DS-6b)", () => {
  const { start, person } = useDataStoreInstance();

  async function instance() {
    const attachments = createManagedObjectTestAttachmentCapability();
    return start(true, undefined, developmentAuth, undefined, {
      attachments: attachments.capability
    });
  }

  async function putKnowledgeBase(
    world: DataStoreInstance,
    name: string,
    config: JsonObject = {}
  ): Promise<{ statusCode: number; body: string }> {
    return world.api.call("assets.put", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name },
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
  }

  async function publishKnowledgeBase(
    world: DataStoreInstance,
    name: string,
    config: JsonObject = {}
  ): Promise<DataStoreRecord> {
    const written = await putKnowledgeBase(world, name, config);
    expect(written.statusCode, written.body).toBe(200);
    const made = await world.api.call("assets.publish", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name },
      payload: { revision: 1 }
    });
    expect(made.statusCode, made.body).toBe(200);
    return eventually(async () => {
      await getTestJobs(world.api).runDue();
      const record = await world.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${name}`
      });
      expect(record).toMatchObject({ status: "ready", level: 19 });
      return required(record);
    });
  }

  async function addFiles(
    world: DataStoreInstance,
    knowledgeBase: string,
    files: readonly { filename: string; content: string }[]
  ) {
    const created = await world.api.call("conversations.create", {
      payload: { title: "Unterlagen" }
    });
    const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
    const refs: { conversationId: string; fileId: string }[] = [];
    for (const file of files) {
      const upload = createMultipartFilePayload({
        fieldName: "file",
        filename: file.filename,
        contentType: "text/plain",
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

  /** Makes a document one of a Workflow-fed source, with its path and time at the source. */
  async function fromSource(
    record: DataStoreRecord,
    documentId: string,
    item: { path: string; modifiedAt: string }
  ) {
    await inStore(record, async (sql) => {
      await sql`insert into catalyst_kb.source_items
          (id, source_id, item_id, version, path, name, mime, size, modified_at, document_id, state)
        values (${`item-${documentId}`}, 'workflow:feed', ${documentId}, '1', ${item.path},
          'x.txt', 'text/plain', 1, ${item.modifiedAt}, ${documentId}, 'fetched')`;
      await sql`update catalyst_kb.documents set source_item_id = ${`item-${documentId}`}
        where id = ${documentId}`;
    });
  }

  const setLink = (
    world: DataStoreInstance,
    knowledgeBase: string,
    payload: JsonObject,
    headers: Record<string, string> = {}
  ) =>
    world.api.call("knowledge_bases.set_origin_link", {
      params: { knowledgeBase },
      payload,
      headers
    });

  const documentsOf = async (
    world: DataStoreInstance,
    knowledgeBase: string,
    headers: Record<string, string> = {}
  ) => {
    const listed = await world.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase },
      headers
    });
    return { statusCode: listed.statusCode, body: listed.body, json: () => listed.json() };
  };

  const search = async (world: DataStoreInstance, knowledgeBase: string, payload: JsonObject) => {
    const answered = await world.api.call("knowledge_bases.search", {
      params: { knowledgeBase },
      payload
    });
    return { statusCode: answered.statusCode, body: answered.body, json: () => answered.json() };
  };

  describe("the origin link", () => {
    it("takes only an http or https address that carries no credential", () => {
      for (const link of [ORIGINAL, "http://intranet.example.test/a?id=7#seite=2"]) {
        expect(knowledgeOriginLinkSchema.safeParse(link).success, link).toBe(true);
      }
      for (const link of [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "ftp://dms.example.test/a",
        "https://user:secret@dms.example.test/a",
        "https://dms.example.test/a?access_token=abc",
        "https://bucket.example.test/a?X-Amz-Signature=abc&X-Amz-Credential=def",
        "https://share.example.test/a?sv=2024&sig=abc",
        "https://dms.example.test/a#access_token=abc",
        "not a link"
      ]) {
        expect(knowledgeOriginLinkSchema.safeParse(link).success, link).toBe(false);
      }
    });

    it("is entered, changed and cleared by the builder for a file added by hand, audited without the link, and shown only to readers", async () => {
      const world = await instance();
      await publishKnowledgeBase(world, "akten");
      const [document] = await addFiles(world, "akten", [
        { filename: "Mietvertrag.txt", content: "Die Kaution beträgt drei Monatsmieten." }
      ]);
      const documentId = required(document).id;

      const set = await setLink(world, "akten", { documentId, originLink: ORIGINAL });
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json()).toEqual({ documentId, change: "set" });
      const listed = documentsSchema.parse((await documentsOf(world, "akten")).json());
      expect(listed.documents).toEqual([
        expect.objectContaining({ id: documentId, originLink: ORIGINAL })
      ]);
      const found = searchSchema.parse((await search(world, "akten", { query: "Kaution" })).json());
      expect(found.passages[0]).toMatchObject({ documentId, originLink: ORIGINAL });

      // Refused before anything changes: no web address, a credential, an unknown document.
      for (const originLink of [
        "javascript:alert(1)",
        "ftp://dms.example.test/a",
        "https://user:pw@dms.example.test/a",
        "https://dms.example.test/a?token=abc"
      ]) {
        const refused = await setLink(world, "akten", { documentId, originLink });
        expect(refused.statusCode, originLink).toBe(422);
      }
      expect(
        (await setLink(world, "akten", { documentId: "kbdoc_none", originLink: ORIGINAL }))
          .statusCode
      ).toBe(404);

      // A member without the right to change the Knowledge Base changes nothing, and one who
      // may not use it reads neither the list nor the link.
      await person(world, "member-1", ["user"]);
      expect(
        (await setLink(world, "akten", { documentId, originLink: null }, asMember)).statusCode
      ).toBe(403);
      const memberList = await documentsOf(world, "akten", asMember);
      expect(memberList.statusCode).not.toBe(200);
      expect(memberList.body).not.toContain("dms.example.test");

      // Changed, then cleared.
      const changed = "https://dms.example.test/akten/4711/mietvertrag-v2.pdf";
      expect((await setLink(world, "akten", { documentId, originLink: changed })).statusCode).toBe(
        200
      );
      expect(
        documentsSchema.parse((await documentsOf(world, "akten")).json()).documents[0]?.originLink
      ).toBe(changed);
      const cleared = await setLink(world, "akten", { documentId, originLink: null });
      expect(cleared.json()).toEqual({ documentId, change: "cleared" });
      expect(
        documentsSchema.parse((await documentsOf(world, "akten")).json()).documents[0]
      ).not.toHaveProperty("originLink");
      const none = searchSchema.parse((await search(world, "akten", { query: "Kaution" })).json());
      expect(none.passages[0]).not.toHaveProperty("originLink");

      // Every change is audited by document, never with the link.
      const audit = await world.stores.audit.listAuditEvents({
        clientInstanceId,
        type: "knowledge_base.origin_link_changed",
        limit: 10
      });
      expect(audit.map((event) => event.metadata)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ knowledgeBase: "akten", documentId, change: "set" }),
          expect.objectContaining({ knowledgeBase: "akten", documentId, change: "cleared" })
        ])
      );
      expect(audit).toHaveLength(3);
      const runs = await world.stores.operationRuns.list({ clientInstanceId });
      expect(JSON.stringify([audit, runs])).not.toContain("dms.example.test");
    });

    it("is the source's own for a synced or Workflow-fed document, which refuses an edit", async () => {
      const world = await instance();
      const record = await publishKnowledgeBase(world, "synced");
      const [document] = await addFiles(world, "synced", [
        { filename: "Expose.txt", content: "Ein Exposé." }
      ]);
      const documentId = required(document).id;
      await fromSource(record, documentId, {
        path: "/a/Expose.txt",
        modifiedAt: "2024-05-01T10:00:00Z"
      });
      const refused = await setLink(world, "synced", { documentId, originLink: ORIGINAL });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({
        error: { details: { reason: "knowledge_origin_link_synced" } }
      });
    });

    it("C44 makes a citation offer the stored copy at its page and the original", async () => {
      const world = await instance();
      await publishKnowledgeBase(world, "richtlinien");
      const [document] = await addFiles(world, "richtlinien", [
        { filename: "Reise.txt", content: "Hotelkosten werden bis 145 Euro je Nacht erstattet." }
      ]);
      const documentId = required(document).id;
      expect(
        (await setLink(world, "richtlinien", { documentId, originLink: ORIGINAL })).statusCode
      ).toBe(200);
      const agent: AgentConfig = {
        name: "reise",
        displayName: "Reise",
        instructions: "Answer from the documents.",
        modelProviderId: "local",
        toolNames: [],
        skillNames: [],
        knowledgeBases: ["richtlinien"],
        initialPrompts: []
      };
      const saved = await world.api.call("assets.put", {
        params: { kind: "agent", name: "reise" },
        payload: { config: agent, expectedRevision: null }
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const admin = await person(world, "user-1", ["user", "admin", "superadmin"]);
      const answer = await askTool(world, admin, "reise", { query: "Hotelkosten" });
      // What the turn keeps as the sources of its answer: the stored copy and the original.
      const [source] = readKnowledgeCitationSources(answer.passages);
      expect(source).toEqual({
        ref: expect.stringMatching(/^K\d+$/u),
        knowledgeBase: "richtlinien",
        documentId,
        fileId: required(document).fileId,
        fileName: "Reise.txt",
        originLink: ORIGINAL
      });
      // The stored copy opens through the platform with the reader's use of the Knowledge Base.
      const opened = await world.api.call("knowledge_bases.open_document", {
        params: { knowledgeBase: "richtlinien", documentId }
      });
      expect(opened.statusCode).toBe(200);
      expect(opened.body).toContain("145 Euro");
    });
  });

  async function askTool(
    world: DataStoreInstance,
    user: AuthenticatedUser,
    agentName: string,
    input: JsonObject
  ) {
    const workspace = await world.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(user.id)
    });
    const conversation = await world.stores.conversations.createConversation({
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: user.id,
      createdByExternalUserId: user.id,
      visibility: "private",
      title: "Fragen",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });
    const result = await world.execution.localAgentRuntimeOptions.runTool(
      {
        toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
        toolCallId: asToolCallId(`call-${Math.random()}`),
        agentRunId: asAgentRunId("run-ds6b"),
        conversationId: conversation.id,
        agentName,
        input
      },
      { clientInstanceId, user, locale: "en", correlationId: `corr_${Math.random()}` }
    );
    expect(result.status, JSON.stringify(result)).toBe("success");
    return toolOutputSchema.parse(result.status === "success" ? result.output : undefined);
  }

  describe("declared filters", () => {
    const FILTERS: JsonObject[] = [
      { name: "datei", type: "string", description: "The exact file name", field: "file_name" },
      {
        name: "titel_beginnt",
        type: "string",
        description: "Only documents whose title starts so",
        field: "title",
        op: "prefix"
      },
      {
        name: "ordner",
        type: "string",
        description: "Only documents below this folder of the source",
        field: "path",
        op: "prefix"
      },
      {
        name: "stand_nach",
        type: "date",
        description: "Only documents changed at the source on or after",
        field: "modified_at",
        op: "gte"
      }
    ];

    it("refuses a filter on a field a document lacks, a type that does not fit, a comparison the type lacks, and filters on a Data Store", async () => {
      const world = await instance();
      const refusals: [JsonObject, string][] = [
        [
          {
            filters: [{ name: "objekt", type: "string", description: "Object", field: "objekt_id" }]
          },
          "extracted fields come later"
        ],
        [
          { filters: [{ name: "datei", type: "date", description: "File", field: "file_name" }] },
          "is of type 'string'"
        ],
        [
          {
            filters: [
              { name: "stand", type: "date", description: "Date", field: "added_at", op: "prefix" }
            ]
          },
          "compares with"
        ],
        [
          {
            filters: [
              { name: "a", type: "string", description: "A", field: "title" },
              { name: "a", type: "string", description: "B", field: "file_name" }
            ]
          },
          "declared once"
        ],
        // A name every object has would read a value no caller passed.
        [
          {
            filters: [{ name: "constructor", type: "string", description: "C", field: "title" }]
          },
          "cannot be named 'constructor'"
        ],
        [
          {
            methods: ["structured"],
            backend: { dataStore: "findings" },
            tables: [{ name: "findings", description: "One row per finding." }],
            filters: [{ name: "a", type: "string", description: "A", field: "title" }]
          },
          "Filters narrow the search"
        ]
      ];
      for (const [index, [config, words]] of refusals.entries()) {
        const written = await putKnowledgeBase(world, `refused-${index}`, config);
        expect(written.statusCode, written.body).toBe(422);
        expect(written.body).toContain(words);
      }
    });

    it("narrows search by bound values, refuses one not declared, and takes text that looks like SQL as a value", async () => {
      const world = await instance();
      const record = await publishKnowledgeBase(world, "objekte", { filters: FILTERS });
      const [alt, neu, hand] = await addFiles(world, "objekte", [
        { filename: "Alt.txt", content: "Die Kaution beträgt zwei Monatsmieten." },
        { filename: "Neu.txt", content: "Die Kaution beträgt drei Monatsmieten." },
        { filename: "Hand.txt", content: "Die Kaution liegt auf dem Treuhandkonto." }
      ]);
      await fromSource(record, required(alt).id, {
        path: "/Objekte/A/Alt.txt",
        modifiedAt: "2023-03-01T10:00:00Z"
      });
      await fromSource(record, required(neu).id, {
        path: "/Objekte/B/Neu.txt",
        modifiedAt: "2025-03-01T10:00:00Z"
      });
      const found = async (filters?: JsonObject) => {
        const answered = await search(world, "objekte", {
          query: "Kaution",
          ...(filters ? { filters } : {})
        });
        expect(answered.statusCode, answered.body).toBe(200);
        return searchSchema
          .parse(answered.json())
          .passages.map((passage) => passage.fileName)
          .sort();
      };
      expect(await found()).toEqual(["Alt.txt", "Hand.txt", "Neu.txt"]);
      expect(await found({ datei: "Neu.txt" })).toEqual(["Neu.txt"]);
      expect(await found({ titel_beginnt: "Ha" })).toEqual(["Hand.txt"]);
      expect(await found({ ordner: "/Objekte/A/" })).toEqual(["Alt.txt"]);
      expect(await found({ stand_nach: "2024-01-01" })).toEqual(["Neu.txt"]);
      // Two filters both hold; a document added by hand has no path, so a path filter leaves it out.
      expect(await found({ ordner: "/Objekte/", stand_nach: "2020-01-01" })).toEqual([
        "Alt.txt",
        "Neu.txt"
      ]);
      // A value is a value: quotes and SQL words find nothing and change nothing.
      expect(await found({ datei: "Neu.txt' or '1'='1" })).toEqual([]);
      expect(await found({ titel_beginnt: "%" })).toEqual([]);
      expect(await found()).toHaveLength(3);
      // A filter the Knowledge Base does not declare, and a date that is none, are refused.
      expect(
        (await search(world, "objekte", { query: "Kaution", filters: { objekt: "7" } })).statusCode
      ).toBe(422);
      // A name every object has is no declared filter either.
      expect(
        (await search(world, "objekte", { query: "Kaution", filters: { constructor: "x" } }))
          .statusCode
      ).toBe(422);
      expect(
        (await search(world, "objekte", { query: "Kaution", filters: { stand_nach: "gestern" } }))
          .statusCode
      ).toBe(422);
      // The audit names the filters applied, never their values.
      const audit = await world.stores.audit.listAuditEvents({
        clientInstanceId,
        type: "knowledge_base.searched",
        limit: 50
      });
      expect(audit.map((event) => event.metadata)).toContainEqual(
        expect.objectContaining({ filters: ["datei"] })
      );
      expect(JSON.stringify(audit)).not.toContain("Neu.txt");
      expect(hand).toBeDefined();
    });

    it("lists each Knowledge Base's filters in the generated tool description and searches only those that declare a filter passed", async () => {
      const world = await instance();
      const record = await publishKnowledgeBase(world, "objekte", { filters: FILTERS });
      // The same name as a filter of `objekte`, of another type: a text, not a date.
      await publishKnowledgeBase(world, "glossar", {
        filters: [
          {
            name: "stand_nach",
            type: "string",
            description: "Only entries whose title starts so",
            field: "title",
            op: "prefix"
          }
        ]
      });
      const [objekt] = await addFiles(world, "objekte", [
        { filename: "Objekt.txt", content: "Die Kaution des Objekts liegt beim Verwalter." }
      ]);
      await addFiles(world, "glossar", [
        { filename: "Glossar.txt", content: "Kaution: eine Sicherheit des Vermieters." }
      ]);
      await fromSource(record, required(objekt).id, {
        path: "/Objekte/A/Objekt.txt",
        modifiedAt: "2025-01-01T10:00:00Z"
      });
      const agent: AgentConfig = {
        name: "berater",
        displayName: "Berater",
        instructions: "Answer from the documents.",
        modelProviderId: "local",
        toolNames: [],
        skillNames: [],
        knowledgeBases: ["objekte", "glossar"],
        initialPrompts: []
      };
      const saved = await world.api.call("assets.put", {
        params: { kind: "agent", name: "berater" },
        payload: { config: agent, expectedRevision: null }
      });
      expect(saved.statusCode, saved.body).toBe(200);

      const tools = await describeAgentDataTools(
        agent,
        world.execution.localAgentRuntimeOptions.dataTools,
        10_000
      );
      const tool = tools.described.find((entry) => entry.name === KNOWLEDGE_SEARCH_TOOL_NAME);
      expect(tool?.description).toContain(
        "  - filter stand_nach (a date YYYY-MM-DD; modified_at on or after it): Only documents changed at the source on or after"
      );
      expect(tool?.description).toContain(
        "  - filter ordner (a text; path starting with it): Only documents below this folder of the source"
      );
      expect(tool?.description).toContain('send "filters"');
      expect(tool?.inputJsonSchema).toMatchObject({
        properties: {
          filters: {
            type: "object",
            additionalProperties: false,
            properties: {
              // Declared as a date by one and as a text by the other: no format claimed.
              stand_nach: {
                type: "string",
                description: expect.stringContaining("different types")
              },
              datei: { type: "string" }
            }
          }
        }
      });

      const admin = await person(world, "user-1", ["user", "admin", "superadmin"]);
      const unfiltered = await askTool(world, admin, "berater", { query: "Kaution" });
      expect(new Set(unfiltered.passages.map((passage) => passage.knowledgeBase))).toEqual(
        new Set(["objekte", "glossar"])
      );
      const filtered = await askTool(world, admin, "berater", {
        query: "Kaution",
        filters: { ordner: "/Objekte/" }
      });
      expect(filtered.passages.map((passage) => passage.fileName)).toEqual(["Objekt.txt"]);
      expect(filtered.skipped).toEqual([
        {
          knowledgeBase: "glossar",
          reason: "filter_not_declared",
          message: "It declares no filter 'ordner', so it was not searched."
        }
      ]);
      // A value that fits only the Knowledge Base that takes it as a text: the other, which takes
      // a date, is skipped with the reason, and the call does not fail.
      const text = await askTool(world, admin, "berater", {
        query: "Kaution",
        filters: { stand_nach: "Glos" }
      });
      expect(text.passages.map((passage) => passage.fileName)).toEqual(["Glossar.txt"]);
      expect(text.skipped).toEqual([
        {
          knowledgeBase: "objekte",
          reason: "filter_value_invalid",
          message: expect.stringContaining("does not fit the Knowledge Base 'objekte'")
        }
      ]);
      // A value that fits no Knowledge Base that declares its filter fails the call.
      const wrong = await world.execution.localAgentRuntimeOptions.runTool(
        {
          toolName: KNOWLEDGE_SEARCH_TOOL_NAME,
          toolCallId: asToolCallId("call-wrong"),
          agentRunId: asAgentRunId("run-wrong"),
          conversationId: (
            await world.stores.conversations.createConversation({
              clientInstanceId,
              collaborationWorkspaceId: (
                await world.stores.workspaces.ensurePersonalWorkspace({
                  clientInstanceId,
                  userId: asUserId(admin.id)
                })
              ).id,
              createdByUserId: admin.id,
              createdByExternalUserId: admin.id,
              visibility: "private",
              title: "Fragen",
              retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
            })
          ).id,
          agentName: "berater",
          input: { query: "Kaution", filters: { stand_nach: "gestern", datei: "Objekt.txt" } }
        },
        { clientInstanceId, user: admin, locale: "en", correlationId: "corr_wrong" }
      );
      expect(wrong).toMatchObject({ status: "failed", error: { code: "validation_failed" } });
    });
  });
});
