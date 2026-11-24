import { describe, expect, it, vi } from "vitest";
import {
  createPlatformTools,
  platformModules,
  PLATFORM_TOOL_NAMES
} from "@work-shape/catalyst-client-assembly";
import {
  createModuleRegistry,
  createPlatformId,
  asConversationId,
  DATA_STORE_USE_TOOL_NAME,
  type ConversationId,
  type DataToolDescriptor,
  asAgentRunId,
  asUserId,
  type JsonObject,
  dataStoreDescriptionSchema,
  DATA_STORE_DESCRIPTION_TOOL_NAME,
  type AgentRun
} from "@work-shape/catalyst-core";
import {
  createToolOperationRunner,
  ToolRegistry,
  runOperation
} from "@work-shape/catalyst-tool-execution";
import { clientInstanceId, useDataStoreInstance, finding } from "./support/data-store-instance";
import { required, eventually } from "./support/assertions";
import { injectStartConversationRun, drainRunEvents } from "./support/chat-server-run-harness";
import { getTestJobs } from "./support/test-instance";
import { inDays } from "./support/personal-api-keys";
import postgres from "postgres";
import { fileTestDatabaseUrl } from "./support/test-database";

const verbs = ["describe", "query", "preview_rows", "insert", "update", "delete_rows"];
const names = verbs.map((verb) => `data_store.findings.${verb}`);
/** A store's row tool; `data_store.use` is the platform's, offered to every holder. */
const isRowTool = (name: string) =>
  name.startsWith("data_store.") && name !== DATA_STORE_USE_TOOL_NAME;

describe("a conversation about a Data Store offers its own tools", () => {
  const { start, publishStore, put, person } = useDataStoreInstance();
  async function setup(ready = true) {
    const world = await start(true, "allow");
    if (ready) await publishStore(world);
    else expect((await put(world)).statusCode).toBe(200);
    const source = required(world.execution.modulesStarted.dataToolSources[0]);
    const platform = createPlatformTools({
      stores: world.stores,
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => source
    });
    platform.registry(platform.tools, new Set());
    const created = await world.api.call("conversations.create", {
      payload: { title: "Holiday requests", subject: { kind: "data_store", name: "findings" } }
    });
    expect(created.statusCode, created.body).toBe(200);
    const conversationId = asConversationId(created.json<{ id: string }>().id);
    const offer = (
      conversationId: ConversationId,
      agentToolNames: readonly string[] = PLATFORM_TOOL_NAMES
    ) => platform.conversationOffer.offerOf({ clientInstanceId, conversationId, agentToolNames });
    return { world, source, platform, conversationId, offer };
  }

  it("offers the six published-store tools, and insert dispatch reads this conversation's offer", async () => {
    const { world, source, conversationId, offer } = await setup();
    const listing = vi.spyOn(world.execution.store.dataStores, "listDataStores");
    expect((await offer(conversationId))?.toolNames.filter((name) => isRowTool(name))).toEqual(
      names
    );
    expect(listing).not.toHaveBeenCalled();
    listing.mockRestore();
    const actor = await person(world, "subject-admin", ["user", "admin", "superadmin"]);
    const deps = {
      ...world.execution.operationCalls.deps,
      agentToolNames: async (_name: string, id?: ConversationId) =>
        id
          ? [...PLATFORM_TOOL_NAMES, ...((await offer(id))?.toolNames ?? [])]
          : [...PLATFORM_TOOL_NAMES]
    };
    const runTool = createToolOperationRunner(deps, new ToolRegistry({ tools: [] }), { source });
    const answer = await runTool(
      {
        toolName: "data_store.findings.insert",
        toolCallId: createPlatformId("tc"),
        agentRunId: createPlatformId("agr"),
        conversationId,
        agentName: "platform",
        input: {
          table: "findings",
          rows: [
            {
              run_id: "holiday",
              client_id: "Alex",
              rule_id: "holiday",
              revision: 1,
              severity: "info"
            }
          ]
        }
      },
      { clientInstanceId, correlationId: "subject-store", user: actor }
    );
    expect(answer, JSON.stringify(answer)).toMatchObject({
      status: "success",
      output: { table: "findings", inserted: 1, skipped: 0 }
    });
    const stored = await world.api.call("data_stores.query", {
      params: { store: "findings" },
      payload: { sql: "select client_id from findings" }
    });
    expect(stored.json()).toMatchObject({ rows: [{ client_id: "Alex" }] });
  });

  it("offers none for a draft subject", async () => {
    const draft = await setup(false);
    expect(
      (await draft.offer(draft.conversationId))?.toolNames.filter((name) => isRowTool(name))
    ).toEqual([]);
  });

  it("offers no row tools for an agent without platform tools, an App subject, a denied policy or a source that cannot be described", async () => {
    const ready = await setup();
    const { world, source, conversationId } = ready;
    expect(
      (await ready.offer(ready.conversationId, []))?.toolNames.filter((name) => isRowTool(name))
    ).toEqual([]);
    // Changing just the conversation's subject must drop every store tool.
    const other = createPlatformTools({
      stores: {
        conversations: {
          getConversation: async () => ({
            ...required(
              await ready.world.stores.conversations.getConversation(
                clientInstanceId,
                ready.conversationId
              )
            ),
            subject: { kind: "app", name: "holidays" }
          })
        }
      },
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => ready.source
    });
    other.registry(other.tools, new Set());
    const offered = await other.conversationOffer.offerOf({
      clientInstanceId,
      conversationId: ready.conversationId,
      agentToolNames: PLATFORM_TOOL_NAMES
    });
    expect(offered?.toolNames.filter((name) => isRowTool(name))).toEqual([]);

    // A tool whose policy denies it is left out.
    const platform1 = createPlatformTools({
      stores: world.stores,
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => ({
        describe: async (names, scope) =>
          (await source.describe(names, scope)).map((tool): DataToolDescriptor =>
            tool.name.endsWith(".insert") ? { ...tool, permission: { mode: "deny" } } : tool
          )
      })
    });
    platform1.registry(platform1.tools, new Set());
    const offer1 = await platform1.conversationOffer.offerOf({
      clientInstanceId,
      conversationId,
      agentToolNames: PLATFORM_TOOL_NAMES
    });
    expect(offer1?.toolNames).not.toContain("data_store.findings.insert");
    expect(offer1?.toolNames).toContain("data_store.findings.update");

    // The ordinary policy resolution applies when a central setting denies a subject tool.
    const platform2 = createPlatformTools({
      stores: world.stores,
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => source,
      policy: {
        instanceDefaults: { reading: "allow", changing: "confirm" },
        centralSettings: () => [{ operation: "data_store.findings.update", value: "deny" }]
      }
    });
    platform2.registry(platform2.tools, new Set());
    const offer2 = await platform2.conversationOffer.offerOf({
      clientInstanceId,
      conversationId,
      agentToolNames: PLATFORM_TOOL_NAMES
    });
    expect(offer2?.toolNames).not.toContain("data_store.findings.update");
    expect(offer2?.toolNames).toContain("data_store.findings.insert");
    expect(offer2?.toolNames).toContain("data_store.findings.delete_rows");

    // No row tools when their source cannot be described.
    const platform3 = createPlatformTools({
      stores: world.stores,
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => ({
        describe: async () => {
          throw new Error("Unavailable synthetic source");
        }
      })
    });
    platform3.registry(platform3.tools, new Set());
    const offer3 = await platform3.conversationOffer.offerOf({
      clientInstanceId,
      conversationId,
      agentToolNames: PLATFORM_TOOL_NAMES
    });
    expect(offer3?.toolNames.filter((name) => isRowTool(name))).toEqual([]);
  });
});

// Real stored values must never reach metadata answers, including via outside keys.
describe("Data Store discovery without rows", () => {
  const { start, startWithAgent, put, publish, settle, publishStore, person } =
    useDataStoreInstance();

  it("describes schema, estimates and rights over HTTP and outside keys, never stored values or defaults", async () => {
    const world = await start(true, "allow", undefined, undefined, { apiAccess: true });
    expect(
      (
        await put(world, [
          { path: "store.yaml", text: "id: findings\nname: Findings\n" },
          {
            path: "migrations/0001_init.sql",
            text: `create table findings (id integer primary key, note text default 'DEFAULT_SENTINEL'); comment on column findings.note is 'Explanation of the finding';`
          }
        ])
      ).statusCode
    ).toBe(200);
    expect((await publish(world, 1)).statusCode).toBe(200);
    await settle(world, 1);
    // The ordinary row boundary, not a metadata-only fixture.
    const insert = await world.api.call("data_stores.insert", {
      params: { store: "findings" },
      payload: { table: "findings", rows: [{ id: 1, note: "ROW_SENTINEL_4b8f" }] }
    });
    expect(insert.statusCode, insert.body).toBe(200);
    async function publishedUse(kind: string, name: string, config: JsonObject) {
      const key = `${kind}:${name}`;
      const saved = await world.stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [key]: null },
        mutations: [{ type: "upsert", kind, name, config }]
      });
      const revision = required(saved.revisions[key]);
      const stored = required(
        await world.stores.configAssets.getConfigAssetRevision({
          clientInstanceId,
          kind,
          name,
          revision
        })
      );
      await world.stores.configAssets.publishConfigAssetRevision({
        clientInstanceId,
        kind,
        name,
        assetId: required(saved.assetIds[key]),
        revision,
        revisionId: stored.id
      });
    }
    await publishedUse("workflow", "fill-findings", {
      manifest: {
        name: "Monthly check",
        steps: [{ id: "write", type: "operation", operation: "data_store.findings.insert" }]
      }
    });
    await publishedUse("app", "read-findings", {
      title: "Findings overview",
      manifest: { actions: [{ kind: "sql", dataStore: "findings", effect: "reading" }] }
    });
    const read = await world.api.call("data_stores.description", { params: { store: "findings" } });
    expect(read.statusCode, read.body).toBe(200);
    const metadata = dataStoreDescriptionSchema.parse(read.json());
    expect(metadata).toMatchObject({
      name: "findings",
      title: "Findings",
      owner: { kind: "instance" },
      published: true,
      schemaAvailable: true,
      filledBy: [{ kind: "workflow", name: "fill-findings", title: "Monthly check" }],
      readBy: [{ kind: "app", name: "read-findings", title: "Findings overview" }],
      rights: { read: true, add: true, change: true },
      chat: { canReadRows: false, nextStep: expect.stringContaining("data_store.use") },
      tables: [
        {
          name: "findings",
          rowEstimate: expect.any(Number),
          fields: [
            { name: "id", type: "integer", nullable: false },
            { name: "note", type: "text", description: "Explanation of the finding" }
          ]
        }
      ]
    });
    expect(read.body).not.toContain("ROW_SENTINEL");
    expect(read.body).not.toContain("DEFAULT_SENTINEL");
    expect(read.body).not.toContain("default");
    const issued = await world.api.call("me.api_keys.create", {
      payload: { name: "Describe only", scopes: ["data_store.read"], expiresAt: inDays(1) }
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const secret = issued.json<{ secret: string }>().secret;
    const exchanged = await world.api.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${secret}` }
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const headers = {
      authorization: `Bearer ${exchanged.json<{ accessToken: string }>().accessToken}`
    };
    const outside = await world.api.call("data_stores.description", {
      params: { store: "findings" },
      headers
    });
    expect(outside.statusCode, outside.body).toBe(200);
    expect(dataStoreDescriptionSchema.parse(outside.json())).toMatchObject({
      tables: metadata.tables,
      filledBy: [],
      readBy: [],
      usesTruncated: true,
      rights: { read: true, add: false, change: false },
      chat: { canReadRows: false }
    });
    for (const operation of ["data_stores.query", "data_stores.preview_rows"] as const) {
      const response = await world.api.call(operation, {
        params: { store: "findings" },
        headers,
        ...(operation === "data_stores.query"
          ? { payload: { sql: "select * from findings" } }
          : { query: { table: "findings" } })
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.body).not.toContain("ROW_SENTINEL");
    }
  });

  it("requires the page's read right on the specific store and refuses it as a store that does not exist", async () => {
    const world = await start(true);
    const record = await publishStore(world);
    const reader = await person(world, "metadata-reader", ["user"]);
    const admin = await person(world, "user-1", ["user", "admin", "superadmin"]);
    const describe = async (store: string) =>
      (
        await runOperation(
          {
            operation: DATA_STORE_DESCRIPTION_TOOL_NAME,
            effect: "reading",
            input: { store },
            actor: reader,
            origin: { kind: "user" },
            correlationId: "describe-rights"
          },
          world.execution.operationCalls.deps
        )
      ).result;
    const missing = await describe("unknown-store");
    const unreadable = await describe("findings");
    // An unreadable store is refused as one that does not exist.
    const refused = {
      status: "failed",
      error: { code: "NOT_FOUND", message: "This Data Store is not available to you." }
    };
    expect(unreadable).toMatchObject(refused);
    expect(missing).toMatchObject(refused);
    await world.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: reader.id,
      action: "data_store.write",
      effect: "allow",
      scopeKind: "asset",
      scopeId: record.id,
      grantedBy: asUserId(admin.id)
    });
    expect(await describe("findings")).toMatchObject({
      status: "failed",
      error: { code: "NOT_FOUND" }
    });
    await world.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: reader.id,
      action: "data_store.read",
      effect: "allow",
      scopeKind: "asset",
      scopeId: record.id,
      grantedBy: asUserId(admin.id)
    });
    expect(await describe("findings")).toMatchObject({
      status: "done",
      output: { rights: { read: true, add: false, change: false } }
    });
    expect(await describe("unknown-store")).toMatchObject({
      status: "failed",
      error: { code: "NOT_FOUND" }
    });
  });

  it("uses the actual run's row tools, without replacing the chat's subject", async () => {
    const world = await startWithAgent();
    await publishStore(world);
    for (const attached of [false, true]) {
      const created = await world.api.call("conversations.create", {
        payload: {
          title: "Describe findings",
          ...(attached ? { subject: { kind: "data_store", name: "findings" } } : {})
        }
      });
      expect(created.statusCode, created.body).toBe(200);
      const conversationId = created.json<{ id: string }>().id;
      const started = await injectStartConversationRun(
        world.api,
        conversationId,
        `/tool ${DATA_STORE_DESCRIPTION_TOOL_NAME} {"store":"findings"}`
      );
      await eventually(async () => {
        await getTestJobs(world.api).runDue();
        const run = await world.stores.agentRuns.getAgentRun({
          clientInstanceId,
          runId: asAgentRunId(started.run.id)
        });
        expect(run?.status).toBe("completed");
      });
      const events = await drainRunEvents(world.api, conversationId, started.run.id);
      expect(events).toContain(`"canReadRows":${attached}`);
      expect(events).not.toContain(String(finding.client_id));
    }
  });
});

describe("row tools in the platform agent's real conversation path", () => {
  const { startWithAgent, put, publish, settle } = useDataStoreInstance();

  it("pauses every write by default, resumes with frozen input, and a declined write changes nothing", async () => {
    const world = await startWithAgent();
    expect(
      (
        await put(world, [
          { path: "store.yaml", text: "id: findings\nname: Holiday requests\n" },
          {
            path: "migrations/0001_init.sql",
            text: "create table holidays (person text primary key, ends date);"
          }
        ])
      ).statusCode
    ).toBe(200);
    expect((await publish(world, 1)).statusCode).toBe(200);
    const record = await settle(world, 1);
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const sql = postgres(url.toString(), { max: 1 });
    const created = await world.api.call("conversations.create", {
      payload: { title: "Holiday requests", subject: { kind: "data_store", name: "findings" } }
    });
    const conversationId = created.json<{ id: string }>().id;
    async function until(runId: string, status: string) {
      let run: AgentRun | undefined;
      await eventually(async () => {
        await getTestJobs(world.api).runDue();
        run = await world.stores.agentRuns.getAgentRun({
          clientInstanceId,
          runId: asAgentRunId(runId)
        });
        expect(run?.status).toBe(status);
      });
      return required(run);
    }
    const snapshot = async () => [
      ...(await sql`select person, ends::text from holidays order by person`)
    ];
    try {
      for (const [verb, input, decision, expected] of [
        [
          "insert",
          { table: "holidays", rows: [{ person: "Alex", ends: "2026-11-06" }] },
          "confirm",
          [{ person: "Alex", ends: "2026-11-06" }]
        ],
        [
          "update",
          { table: "holidays", rows: [{ key: { person: "Alex" }, set: { ends: "2026-11-05" } }] },
          "decline",
          [{ person: "Alex", ends: "2026-11-06" }]
        ],
        [
          "update",
          { table: "holidays", rows: [{ key: { person: "Alex" }, set: { ends: "2026-11-05" } }] },
          "confirm",
          [{ person: "Alex", ends: "2026-11-05" }]
        ],
        ["delete_rows", { table: "holidays", keys: [{ person: "Alex" }] }, "confirm", []]
      ] as const) {
        const before = await snapshot();
        const said = await injectStartConversationRun(
          world.api,
          conversationId,
          `/tool data_store.findings.${verb} ${JSON.stringify(input)}`
        );
        const waiting = await until(said.run.id, "waiting_for_decision");
        expect(await snapshot()).toEqual(before);
        const held = required(
          (await world.stores.operationRuns.list({ clientInstanceId })).find(
            (run) =>
              run.origin.kind === "agent" &&
              run.origin.agentRunId === waiting.id &&
              run.status === "pending_confirmation"
          )
        );
        const observations = await world.stores.agentRuns.listRunObservations({
          clientInstanceId,
          runId: waiting.id
        });
        const requested = observations
          .map((observation) => observation.payload)
          .find((event) => event.type === "tool_decision_requested");
        expect(requested).toMatchObject({
          type: "tool_decision_requested",
          targetTitle: "Holiday requests",
          inputPreview: input
        });
        const operation = required(
          await world.execution.operationCalls.registry.resolve(held.operation)
        );
        expect(operation.changeClass).toBe(verb === "insert" ? "reversible" : "irreversible");
        const answered = await world.api.call("operations.decide", {
          params: { runId: held.id },
          payload: { decision }
        });
        expect(answered.statusCode, answered.body).toBe(200);
        await until(said.run.id, "completed");
        const ended = await world.stores.operationRuns.get({ clientInstanceId, id: held.id });
        expect(ended, JSON.stringify(ended)).toMatchObject({
          status: decision === "decline" ? "denied" : "done"
        });
        expect(await snapshot()).toEqual(expected);
        const usage = await world.api.call("data_stores.used_by", {
          params: { store: "findings" }
        });
        expect(usage.statusCode, usage.body).toBe(200);
        expect(usage.json()).toMatchObject({
          conversationWriters: { agents: 1, conversations: 1, truncated: false }
        });
        expect(JSON.stringify(usage.json())).not.toContain(conversationId);

        if (decision === "decline") {
          expect(
            await world.stores.operationRuns.get({ clientInstanceId, id: held.id })
          ).toMatchObject({ status: "denied", decision: { mode: "declined" } });
        }
      }
      // A busy store bounds the history before filtering for conversation writers. An older
      // chat write beyond that slice is not read or counted, and the page is told it is partial.
      const completed = required(
        (await world.stores.operationRuns.list({ clientInstanceId })).find(
          (run) => run.operation === "data_store.findings.insert" && run.status === "done"
        )
      );
      const oldId = createPlatformId<"OperationRunId">("oprun");
      const oldAt = "2020-01-01T00:00:00.000Z";
      const oldOrigin = completed.origin;
      expect(oldOrigin.kind).toBe("agent");
      if (oldOrigin.kind !== "agent") throw new Error("Expected the completed chat insert");
      await world.stores.operationRuns.create({
        ...completed,
        id: oldId,
        startedAt: oldAt,
        idempotencyKey: "retired-store-write",
        origin: { ...oldOrigin, agentName: "retired-store-agent" }
      });
      await world.stores.operationRuns.finish({
        clientInstanceId,
        id: oldId,
        end: { status: "done", finishedAt: oldAt, output: { value: { inserted: 1 } } }
      });
      const currentUsage = await world.api.call("data_stores.used_by", {
        params: { store: "findings" }
      });
      expect(currentUsage.statusCode).toBe(200);
      expect(currentUsage.json()).toMatchObject({
        conversationWriters: { agents: 1, conversations: 1, truncated: false }
      });
      // Workflow agent calls have an agent origin too, but act as the Workflow's principal.
      const listWriters = vi
        .spyOn(world.stores.operationRuns, "list")
        .mockImplementation(async ({ filters }) =>
          filters?.operation === "data_store.findings.insert"
            ? [
                completed,
                {
                  ...completed,
                  actor: { kind: "service_principal", id: "workflow-principal", label: "Workflow" },
                  origin: {
                    ...oldOrigin,
                    agentName: "workflow-agent",
                    conversationId: asConversationId("workflow-thread")
                  }
                }
              ]
            : []
        );
      try {
        const withWorkflow = await world.api.call("data_stores.used_by", {
          params: { store: "findings" }
        });
        expect(withWorkflow.statusCode, withWorkflow.body).toBe(200);
        expect(withWorkflow.json()).toMatchObject({
          conversationWriters: { agents: 1, conversations: 1, truncated: false }
        });
      } finally {
        listWriters.mockRestore();
      }
      const recent = Array.from({ length: 1_000 }, () => ({
        ...completed,
        origin: { kind: "user" as const }
      }));
      const listed = vi
        .spyOn(world.stores.operationRuns, "list")
        .mockImplementation(async ({ filters }) =>
          filters?.operation === "data_store.findings.insert" ? [...recent, completed] : []
        );
      try {
        const partial = await world.api.call("data_stores.used_by", {
          params: { store: "findings" }
        });
        expect(partial.statusCode, partial.body).toBe(200);
        expect(listed).toHaveBeenCalledWith({
          clientInstanceId,
          filters: { operation: "data_store.findings.insert", since: expect.any(String) },
          page: { limit: 1_001 }
        });
        expect(partial.json()).toMatchObject({
          conversationWriters: { agents: 0, conversations: 0, truncated: true }
        });
      } finally {
        listed.mockRestore();
      }
    } finally {
      await sql.end();
    }
  });
});
