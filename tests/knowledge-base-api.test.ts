import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeAgentDataTools } from "@vivd-catalyst/agent-runtime";
import {
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_QUERY_TOOL_NAME,
  asAgentRunId,
  asToolCallId,
  asUserId,
  knowledgeQueryOperationName,
  type JsonObject
} from "@vivd-catalyst/core";
import { required } from "./support/assertions";
import {
  clientInstanceId,
  finding,
  useDataStoreInstance,
  type DataStoreInstance
} from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// A Knowledge Base on the Data Store backend through the assembled instance: its definition is
// written and published with the asset operations, its query is reached over HTTP and through
// the one agent tool, with the asker's `knowledge_base.use`, one recorded run per call and a
// read-only transaction as the store's app role.

const KB = "findings-kb";

const definition = (tables: JsonObject[] = [findingsTable]): JsonObject => ({
  name: KB,
  title: "Findings",
  description: "What the monthly check of bookings found, one row per finding.",
  methods: ["structured"],
  backend: { dataStore: "findings" },
  tables
});
const findingsTable = { name: "findings", description: "One row per finding of a run." };

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

const stateSchema = z.object({
  status: z.string(),
  tables: z.array(z.object({ name: z.string(), readable: z.boolean() })),
  revision: z.number().optional(),
  problem: z.string().optional()
});

const developmentAuth = {
  enabled: true,
  users: [
    { id: "user-1", roles: ["user", "admin", "superadmin"] },
    { id: "member-1", roles: ["user"] }
  ].map((user) => ({ ...user, externalUserId: user.id, displayLabel: user.id, permissionRefs: [] }))
};
const asMember = { "x-dev-user-id": "member-1" };

describe("a Knowledge Base on a Data Store", () => {
  const { start, publishStore, person } = useDataStoreInstance();

  const putKnowledgeBase = (
    { api }: DataStoreInstance,
    config: JsonObject = definition(),
    expectedRevision: number | null = null
  ) =>
    api.call("assets.put", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { config, expectedRevision }
    });
  const publishKnowledgeBase = ({ api }: DataStoreInstance, revision: number) =>
    api.call("assets.publish", {
      params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name: KB },
      payload: { revision }
    });
  const query = (
    { api }: DataStoreInstance,
    payload: JsonObject,
    headers: Record<string, string> = {}
  ) => api.call("knowledge_bases.query", { params: { knowledgeBase: KB }, payload, headers });

  /** A store with one finding, and the Knowledge Base on it written and published. */
  async function published(world: DataStoreInstance) {
    await publishStore(world);
    const inserted = await world.api.call("data_stores.insert", {
      params: { store: "findings" },
      payload: { table: "findings", rows: [finding] }
    });
    expect(inserted.statusCode, inserted.body).toBe(200);
    const written = await putKnowledgeBase(world);
    expect(written.statusCode, written.body).toBe(200);
    const made = await publishKnowledgeBase(world, 1);
    expect(made.statusCode, made.body).toBe(200);
  }

  it("is off by default and needs the Data Stores on", async () => {
    const instance = await start(true);

    const written = await putKnowledgeBase(instance);
    const queried = await query(instance, { sql: "select 1" });

    expect(written.statusCode).toBe(404);
    expect(written.json<ErrorBody>().error.details).toMatchObject({
      reason: "module_off",
      module: "knowledge"
    });
    expect(queried.statusCode).toBe(404);
    expect(instance.execution.configAssets.kinds.get(KNOWLEDGE_BASE_ASSET_KIND)).toBeUndefined();
    await expect(start(false, undefined, undefined, undefined, true)).rejects.toThrow(
      "Module 'knowledge' requires module 'dataStores', which is off"
    );
  });

  it("checks the described tables on publish, answers rows with their source and keeps the check", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);
    await published(instance);

    const answered = await query(instance, {
      sql: "select client_id, amount from findings where rule_id = $1",
      parameters: [{ type: "text", value: "vat-rate" }]
    });
    const state = await instance.api.call("knowledge_bases.get", {
      params: { knowledgeBase: KB }
    });

    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toEqual({
      columns: [
        { name: "client_id", type: "text", nativeType: "text" },
        { name: "amount", type: "number", nativeType: "numeric" }
      ],
      rows: [{ client_id: "client-secret-7", amount: "119.50" }],
      truncated: false,
      source: { knowledgeBase: KB, title: "Findings", tables: ["findings"] }
    });
    expect(stateSchema.parse(state.json())).toMatchObject({
      status: "ok",
      revision: 1,
      tables: [{ name: "findings", readable: true }]
    });
    // One recorded run per read of a customer's rows, with no row value in its audit.
    const runs = (await instance.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.operation === knowledgeQueryOperationName(KB)
    );
    expect(runs.map((run) => run.status)).toEqual(["done"]);
    const audit = await instance.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
    expect(JSON.stringify(audit)).not.toContain("client-secret-7");
  });

  it("refuses a write statement inside its read-only transaction, and the run says so", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);
    await published(instance);

    const written = await query(instance, { sql: "delete from findings" });
    const counted = await query(instance, {
      sql: "select count(*)::integer as count from findings"
    });

    expect(written.statusCode).toBeGreaterThanOrEqual(400);
    expect(written.statusCode).toBeLessThan(500);
    expect(counted.json()).toMatchObject({ rows: [{ count: 1 }] });
    const runs = (await instance.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.operation === knowledgeQueryOperationName(KB)
    );
    expect(runs.map((run) => run.status).sort()).toEqual(["done", "failed"]);
  });

  it("refuses to publish a definition that describes a table the store does not have", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);
    await publishStore(instance);
    await putKnowledgeBase(
      instance,
      definition([findingsTable, { name: "invoices", description: "One row per invoice." }])
    );

    const refused = await publishKnowledgeBase(instance, 1);

    expect(refused.statusCode).toBe(422);
    expect(refused.json<ErrorBody>().error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("'invoices'"),
      details: { reason: "knowledge_base_needs_attention", tables: ["invoices"] }
    });
    // Nothing is published, so nothing answers.
    expect((await query(instance, { sql: "select 1" })).statusCode).toBe(404);
  });

  it("refuses a definition with a field of a later slice and one without a backend", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);

    const prompted = await putKnowledgeBase(instance, { ...definition(), answerPrompt: "Be nice" });
    const { backend: _backend, ...withoutBackend } = definition();
    const builtIn = await putKnowledgeBase(instance, withoutBackend);
    const semantic = await putKnowledgeBase(instance, { ...definition(), methods: ["semantic"] });

    for (const refused of [prompted, builtIn, semantic]) {
      expect(refused.statusCode, refused.body).toBe(422);
    }
    expect(builtIn.body).toContain("DS-4");
    expect(semantic.body).toContain("structured");
  });

  it("answers a member only with `knowledge_base.use`, and needs no right on the store behind it", async () => {
    const instance = await start(true, undefined, developmentAuth, undefined, true);
    await published(instance);
    const sql = "select client_id from findings";

    const refused = await query(instance, { sql }, asMember);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<ErrorBody>().error.details).toMatchObject({
      action: KNOWLEDGE_BASE_ACTIONS.use
    });
    expect(refused.body).not.toContain("client-secret-7");

    // The member as the sign-in made them, named by the run of the refused call.
    const member = required(
      (await instance.stores.operationRuns.list({ clientInstanceId })).find(
        (run) => run.actor.label === "member-1"
      )
    ).actor;
    const asset = required(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: KB
      })
    );
    const granted = await instance.api.call("permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: member.id,
        action: KNOWLEDGE_BASE_ACTIONS.use,
        scopeKind: "asset",
        scopeId: asset.id
      }
    });
    expect(granted.statusCode, granted.body).toBe(200);

    const answered = await query(instance, { sql }, asMember);
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json()).toMatchObject({ rows: [{ client_id: "client-secret-7" }] });
    // The store's own rows stay closed to the member.
    const direct = await instance.api.call("data_stores.query", {
      params: { store: "findings" },
      payload: { sql },
      headers: asMember
    });
    expect(direct.statusCode).toBe(403);
  });

  it("gives an agent that lists it one tool, which reads only the Knowledge Bases it lists", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);
    await published(instance);
    const agent = {
      name: "analyst",
      displayName: "Analyst",
      instructions: "Answer from the findings.",
      modelProviderId: "local",
      toolNames: [],
      skillNames: [],
      knowledgeBases: [KB],
      initialPrompts: []
    };
    const saved = await instance.api.call("assets.put", {
      params: { kind: "agent", name: "analyst" },
      payload: { config: agent, expectedRevision: null }
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const unknown = await instance.api.call("assets.put", {
      params: { kind: "agent", name: "guesser" },
      payload: {
        config: { ...agent, name: "guesser", knowledgeBases: ["nowhere"] },
        expectedRevision: null
      }
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.body).toContain("'nowhere'");

    const runtime = instance.execution.localAgentRuntimeOptions;
    const tools = await describeAgentDataTools(agent, runtime.dataTools, 10_000);
    expect(tools.missing).toEqual([]);
    const tool = required(tools.described.find((each) => each.name === KNOWLEDGE_QUERY_TOOL_NAME));
    expect(tool.effect).toBe("reading");
    expect(tool.description).toContain(`- ${KB} ("Findings")`);
    expect(tool.description).toContain("table findings: One row per finding of a run.");
    expect(tool.inputJsonSchema).toMatchObject({
      required: ["knowledgeBase", "sql"],
      properties: { knowledgeBase: { enum: [KB] } }
    });

    const admin = await person(instance, "user-1", ["user", "admin", "superadmin"]);
    const workspace = await instance.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(admin.id)
    });
    const conversation = await instance.stores.conversations.createConversation({
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: admin.id,
      createdByExternalUserId: "user-1",
      visibility: "workspace",
      title: "Findings",
      retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
    });
    const call = (input: JsonObject) =>
      runtime.runTool(
        {
          toolName: KNOWLEDGE_QUERY_TOOL_NAME,
          toolCallId: asToolCallId("call-1"),
          agentRunId: asAgentRunId("run-1"),
          conversationId: conversation.id,
          agentName: "analyst",
          input
        },
        { clientInstanceId, user: admin, correlationId: "corr_knowledge" }
      );

    const answered = await call({ knowledgeBase: KB, sql: "select rule_id from findings" });
    const elsewhere = await call({ knowledgeBase: "other-kb", sql: "select 1" });
    const nameless = await call({ sql: "select 1" });

    expect(answered).toMatchObject({
      status: "success",
      output: { rows: [{ rule_id: "vat-rate" }], source: { knowledgeBase: KB } }
    });
    expect(elsewhere).toMatchObject({
      status: "failed",
      error: { code: "not_allowed", details: { reason: "knowledge_base_not_assigned" } }
    });
    expect(nameless).toMatchObject({ status: "failed", error: { code: "validation_failed" } });
    // The call is the Knowledge Base's own operation, run as the person in the chat.
    const runs = (await instance.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.origin.kind === "agent"
    );
    expect(runs.map((run) => [run.operation, run.status, run.actor.label])).toEqual([
      [knowledgeQueryOperationName(KB), "done", "user-1"]
    ]);
  });

  it("checks again on demand and says which table it can no longer read", async () => {
    const instance = await start(true, undefined, undefined, undefined, true);
    await published(instance);
    const record = required(
      await instance.stores.dataStores.findDataStoreByName({ clientInstanceId, name: "findings" })
    );
    // A migration outside the platform's knowledge renames the described table.
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe("alter table findings rename to findings_old");
    } finally {
      await sql.end();
    }

    const checked = await instance.api.call("knowledge_bases.check", {
      params: { knowledgeBase: KB },
      headers: { "idempotency-key": "check-1" }
    });

    expect(checked.statusCode, checked.body).toBe(200);
    expect(stateSchema.parse(checked.json())).toMatchObject({
      status: "needs_attention",
      tables: [{ name: "findings", readable: false }]
    });
  });
});
