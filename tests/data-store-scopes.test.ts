import { createKnowledgeBases } from "@work-shape/catalyst-data-stores";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  NoopAuditRecorder,
  asClientInstanceId,
  createPlatformId,
  createAuthorizer,
  type JsonObject,
  type DataStoreKnowledgeTarget,
  type ActorAccess,
  type AuthenticatedUser,
  type OperationExecutionContext,
  type ScopeAssignmentInput
} from "@work-shape/catalyst-core";
import { useDataStoreWorld, manifest, refusal } from "./support/data-store-world";
import { accessOf } from "./support/access";
import { eventually, required } from "./support/assertions";

const dimension = { mandant: { label: "Mandant", valueType: "text" as const } };
const scoped = manifest("tables: { findings: { scope: { mandant: mandant_nr } } }\n");
const init = {
  path: "migrations/0001_init.sql",
  text: `create table findings (id int primary key, mandant_nr text not null default '103', note text); insert into findings values (1, '101', 'A'), (2, '102', 'B'), (3, '103', 'C');`
};
const person: AuthenticatedUser = {
  id: "scope-person",
  externalUserId: "scope-person",
  displayLabel: "Scope person",
  clientInstanceId: asClientInstanceId("scope-tests"),
  roles: ["admin"],
  permissionRefs: [],
  authSource: "test"
};
const assignment = (values: ScopeAssignmentInput["values"]): ScopeAssignmentInput => ({
  dimension: "mandant",
  holderKind: "user",
  holderId: person.id,
  effect: "allow",
  values
});
const access = (values: ScopeAssignmentInput["values"]) =>
  accessOf(person, { scopeAssignments: [assignment(values)] });

describe("scoped Data Store rows", () => {
  const { db, setup, publish, settle, recordOf } = useDataStoreWorld("scope_rows");
  const world = async () => {
    const world = await setup(
      "scopes",
      {},
      undefined,
      {
        async *read() {
          yield [{ id: 4 }];
        }
      },
      undefined,
      dimension
    );
    const id = await publish(world, [scoped, init]);
    await settle(world, id, 1);
    return world;
  };
  type World = Awaited<ReturnType<typeof world>>;
  async function call(
    world: World,
    part: string,
    input: unknown,
    viewer: ActorAccess,
    extra: Partial<OperationExecutionContext> = {}
  ) {
    const operation = required(
      await world.dataStores.operationSource.resolve(`data_store.findings.${part}`)
    );
    return operation.execute(operation.inputSchema.parse(input), {
      runId: createPlatformId("opr"),
      actor: person,
      access: viewer,
      origin: { kind: "user" },
      runtime: {},
      correlationId: "scopes",
      audit: new NoopAuditRecorder(),
      ...extra
    });
  }
  it("filters preview, query and paged rows; all sees every row and none sees the notice", async () => {
    const w = await world();
    for (const part of ["preview_rows", "query", "rows"]) {
      const input = part === "query" ? { sql: "select * from findings" } : { table: "findings" };
      const result = await call(w, part, input, access(["101", "102"]));
      expect(result).toMatchObject({
        rows:
          part === "rows"
            ? [{ values: { mandant_nr: "101" } }, { values: { mandant_nr: "102" } }]
            : [{ mandant_nr: "101" }, { mandant_nr: "102" }]
      });
      expect(await call(w, part, input, access("all"))).toMatchObject({
        rows: [expect.anything(), expect.anything(), expect.anything()]
      });
      expect(await call(w, part, input, access([]))).toMatchObject({ rows: [] });
    }
    expect(await call(w, "rows", { table: "findings" }, access([]))).toMatchObject({
      scopeUnassigned: "Mandant"
    });
  });
  it("uses server-owned bindings for authored SQL, including the all flag, and filters unbound reads", async () => {
    const w = await world();
    const sql =
      "select * from findings where $viewer.scope_all('mandant') or mandant_nr = any($viewer.scope('mandant')) order by id";
    expect(await call(w, "query", { sql }, access(["101"]), { byAppAction: true })).toMatchObject({
      rows: [{ mandant_nr: "101" }]
    });
    expect(await call(w, "query", { sql }, access("all"), { byAppAction: true })).toMatchObject({
      rows: [expect.anything(), expect.anything(), expect.anything()]
    });
    expect(
      await call(
        w,
        "query",
        { sql: "select * from findings -- $viewer.scope('mandant')" },
        access(["101"]),
        { byAppAction: true }
      )
    ).toMatchObject({ rows: [{ mandant_nr: "101" }] });
  });
  it.each([
    ["or true", "select mandant_nr from findings where mandant_nr = '102' or true", ["101"]],
    [
      "a union",
      "select mandant_nr from findings union all select mandant_nr from findings order by 1",
      ["101", "101"]
    ],
    [
      "a join, a subquery and folded case",
      "with r(n) as (select 1) select f.mandant_nr, (select count(*)::text from FINDINGS) as n from r, findings f",
      ["101"]
    ],
    [
      "a recursive CTE",
      "with recursive r(n) as (select 1 union all select n + 1 from r where n < 2) select f.mandant_nr from r, findings f",
      ["101", "101"]
    ],
    [
      // Run first on every row, an error would tell another scope's value.
      "a predicate that fails on another scope's row",
      "select mandant_nr from findings where 1 / (id - 3) = 0",
      ["101"]
    ]
  ])("filters free SQL with %s to the caller's rows", async (_shape, sql, expected) => {
    const w = await world();
    const result = z
      .object({ rows: z.array(z.object({ mandant_nr: z.string() })) })
      // Seven values make the scope filter the costlier predicate, which a planner would run
      // last; more would make it a hashed lookup again.
      .parse(
        await call(
          w,
          "query",
          { sql },
          access(["101", ...Array.from({ length: 6 }, (_, index) => `unused-${index}`)])
        )
      );
    expect(result.rows.map((row) => row.mandant_nr)).toEqual(expected);
  });
  it("lets an all holder filter by Mandant and count every row (M3)", async () => {
    const w = await world();
    expect(
      await call(
        w,
        "query",
        { sql: "select id from findings where mandant_nr = $1", parameters: ["103"] },
        access("all")
      )
    ).toMatchObject({ rows: [{ id: 3 }] });
    expect(
      await call(w, "query", { sql: "select count(*)::int as n from findings" }, access("all"))
    ).toMatchObject({ rows: [{ n: 3 }] });
    expect(
      await call(w, "query", { sql: "select count(*)::int as n from findings" }, access(["101"]))
    ).toMatchObject({ rows: [{ n: 1 }] });
  });
  it.each([
    "select * from public.findings",
    'select * from "public" . "findings"',
    'select * from U&"findings"',
    "select query_to_xml('select * from findings', true, false, '')",
    "select table_to_xml('findings', true, false, '')",
    "select * from pg_catalog.pg_stats"
  ])("refuses SQL that reaches past the filter: %s", async (sql) => {
    const w = await world();
    expect(await refusal(call(w, "query", { sql }, access(["101"])))).toMatchObject({
      details: { reason: "scoped_sql_refused" }
    });
  });
  it("refuses missing scope values, out-of-scope inserts and cross-scope value cursors", async () => {
    const w = await world();
    expect(
      await refusal(call(w, "insert", { table: "findings", rows: [{ id: 4 }] }, access("all")))
    ).toMatchObject({ details: { reason: "scope_value_required" } });
    expect(
      await refusal(
        call(
          w,
          "insert",
          { table: "findings", rows: [{ id: 4, mandant_nr: "103" }] },
          access(["101"])
        )
      )
    ).toMatchObject({ code: "FORBIDDEN" });
    const page = await call(w, "rows", { table: "findings" }, access("all"));
    const parsed = z
      .object({
        rows: z.array(z.object({ at: z.string() }))
      })
      .parse(page);
    const at = required(parsed.rows[2]).at;
    expect(
      await refusal(call(w, "value", { table: "findings", column: "note", at }, access(["101"])))
    ).toMatchObject({ code: "NOT_FOUND" });
  });
  it("reads the person's current group membership, including on a personal key, and the Workflow principal's own assignment", async () => {
    const w = await world();
    const member = await db.store.users.resolveUserIdentity({
      clientInstanceId: w.clientInstanceId,
      authSource: "test",
      externalUserId: "group-reader",
      displayLabel: "Group reader",
      roles: ["user"],
      permissionRefs: [],
      permissions: [],
      groups: ["staff"]
    });
    await db.store.access.setScopeAssignment({
      clientInstanceId: w.clientInstanceId,
      dimension: "mandant",
      holderKind: "group",
      holderId: "staff",
      effect: "allow",
      values: ["101", "102"]
    });
    await db.store.access.setScopeAssignment({
      clientInstanceId: w.clientInstanceId,
      dimension: "mandant",
      holderKind: "user",
      holderId: member.id,
      effect: "deny",
      values: ["102"]
    });
    const authorizer = createAuthorizer(db.store.access);
    const personalKey = { ...member, keyScopes: ["data_store.read"] };
    expect((await authorizer.forActor(personalKey)).scopeOf("mandant")).toEqual(["101"]);
    expect(
      await call(
        w,
        "query",
        { sql: "select * from findings" },
        await authorizer.forActor(personalKey)
      )
    ).toMatchObject({ rows: [{ mandant_nr: "101" }] });
    await db.store.users.resolveUserIdentity({
      clientInstanceId: w.clientInstanceId,
      authSource: "test",
      externalUserId: "group-reader",
      displayLabel: "Group reader",
      roles: ["user"],
      permissionRefs: [],
      permissions: [],
      groups: []
    });
    expect((await authorizer.forActor(personalKey)).scopeOf("mandant")).toEqual([]);
    const principal = await db.store.apiAccess.createServicePrincipal({
      clientInstanceId: w.clientInstanceId,
      displayLabel: "Nightly Workflow"
    });
    await db.store.access.setScopeAssignment({
      clientInstanceId: w.clientInstanceId,
      dimension: "mandant",
      holderKind: "service_principal",
      holderId: principal.id,
      effect: "allow",
      values: "all"
    });
    const actor = {
      kind: "service" as const,
      id: principal.id,
      displayLabel: principal.displayLabel,
      clientInstanceId: w.clientInstanceId,
      authSource: "workflow",
      permissions: [],
      permissionRefs: [],
      scopes: [],
      workflowRunId: createPlatformId<"WorkflowRunId">("wfr")
    };
    expect(
      await call(w, "query", { sql: "select * from findings" }, await authorizer.forActor(actor), {
        actor,
        origin: { kind: "workflow", workflowRunId: actor.workflowRunId, stepRunId: "scope-step" }
      })
    ).toMatchObject({ rows: [expect.anything(), expect.anything(), expect.anything()] });
  });

  it("filters a published named query, with or without a binding, and refuses free SQL even for all", async () => {
    const w = await world();
    const kb = createKnowledgeBases({
      defaultLocale: "en",
      clientInstanceId: w.clientInstanceId,
      stores: db.store,
      backend: w.dataStores.knowledgeBackend,
      embedding: {},
      documentFormats: [],
      maxDocuments: 100,
      logger: w.logger
    });
    const sql =
      "-- @param note text optional\nselect * from findings where ($viewer.scope_all('mandant') or mandant_nr = any($viewer.scope('mandant'))) and ($note is null or note = $note) order by id";
    const config: JsonObject = {
      name: "scoped-kb",
      title: "Scoped data",
      description: "Client findings",
      backend: { dataStore: "findings" },
      tables: [{ name: "findings", description: "One finding per client" }],
      queries: [
        { name: "findings", file: "queries/findings.sql", sql },
        { name: "unbound", file: "queries/unbound.sql", sql: "select * from findings order by id" }
      ]
    };
    const written = await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: w.clientInstanceId,
      baseRevisions: { "knowledge_base:scoped-kb": null },
      mutations: [
        { type: "upsert", kind: "knowledge_base", name: "scoped-kb", config, draft: true }
      ]
    });
    const assetId = required(written.assetIds["knowledge_base:scoped-kb"]);
    const revision = required(written.revisions["knowledge_base:scoped-kb"]);
    const stored = required(
      await db.store.configAssets.getConfigAssetRevision({
        clientInstanceId: w.clientInstanceId,
        kind: "knowledge_base",
        name: "scoped-kb",
        revision
      })
    );
    const target: DataStoreKnowledgeTarget = {
      backend: "dataStore",
      assetId,
      name: "scoped-kb",
      dataStore: "findings",
      tables: [{ name: "findings" }]
    };
    try {
      expect(
        kb.assetKind.read([
          {
            name: "documents",
            title: "Documents",
            description: "Documents",
            methods: ["keyword"],
            queries: [{ name: "findings", file: "queries/findings.sql", sql }]
          }
        ]).refused
      ).toHaveLength(1);
      await kb.publish(db.store, {
        access: access("all"),
        assetId,
        revision,
        config,
        replaced: undefined
      });
      await db.store.configAssets.publishConfigAssetRevision({
        clientInstanceId: w.clientInstanceId,
        kind: "knowledge_base",
        name: "scoped-kb",
        assetId,
        revision,
        revisionId: stored.id
      });
      const operation = required(
        await kb.operationSource(undefined).resolve("knowledge.scoped-kb.query")
      );
      const run = (input: unknown, viewer = access(["101"])) =>
        operation.execute(operation.inputSchema.parse(input), {
          runId: createPlatformId("opr"),
          actor: person,
          access: viewer,
          origin: { kind: "user" },
          runtime: {},
          correlationId: "named-query",
          audit: new NoopAuditRecorder()
        });
      expect(await run({ query: "findings" })).toMatchObject({ rows: [{ mandant_nr: "101" }] });
      expect(await run({ query: "findings" }, access("all"))).toMatchObject({
        rows: [expect.anything(), expect.anything(), expect.anything()]
      });
      expect(await run({ query: "findings" }, access([]))).toMatchObject({ rows: [] });
      expect(await refusal(run({ sql: "select * from findings" }, access("all")))).toMatchObject({
        details: { reason: "scoped_sql_refused" }
      });
      expect(
        await refusal(run({ query: "findings", parameters: { viewer: ["103"] } }))
      ).toMatchObject({ details: { reason: "named_query_parameters" } });
      expect(await run({ query: "unbound" })).toMatchObject({ rows: [{ mandant_nr: "101" }] });
    } finally {
      await w.dataStores.knowledgeBackend.retire(db.store, target);
    }
  });

  it.each([
    "drop column mandant_nr",
    "alter column mandant_nr drop not null",
    "alter column mandant_nr type varchar(50)"
  ])("refuses publishing invalid scope column: %s", async (ddl) => {
    const w = await world();
    const drop = {
      path: "migrations/0002_remove_scope.sql",
      text: `alter table findings ${ddl}`
    };
    expect(await refusal(publish(w, [scoped, init, drop]))).toMatchObject({
      details: { reason: "scope_column_invalid" }
    });
    expect(await call(w, "query", { sql: "select * from findings" }, access("all"))).toMatchObject({
      rows: [expect.anything(), expect.anything(), expect.anything()]
    });
  });

  it("refuses a load missing the scope value and checks old and new scope values on mutations", async () => {
    const w = await world();
    expect(
      await refusal(
        call(
          w,
          "load",
          { table: "findings", dataset: { $dataset: "missing-scope", rowCount: 1, bytes: 10 } },
          access("all")
        )
      )
    ).toMatchObject({ details: { reason: "scope_value_required" } });
    expect(
      await refusal(
        call(
          w,
          "update",
          { table: "findings", rows: [{ key: { id: 3 }, set: { note: "changed" } }] },
          access(["101"])
        )
      )
    ).toMatchObject({ details: { reason: "key_not_found" } });
    expect(
      await refusal(
        call(
          w,
          "update",
          { table: "findings", rows: [{ key: { id: 1 }, set: { mandant_nr: "103" } }] },
          access(["101"])
        )
      )
    ).toMatchObject({ details: { reason: "scope_value_denied" } });
    expect(
      await call(
        w,
        "update",
        { table: "findings", rows: [{ key: { id: 1 }, set: { note: "changed" } }] },
        access(["101"])
      )
    ).toMatchObject({ updated: 1 });
    expect(
      await refusal(
        call(w, "delete_rows", { table: "findings", keys: [{ id: 3 }] }, access(["101"]))
      )
    ).toMatchObject({ details: { reason: "key_not_found" } });
  });
  it("never activates an initially nullable scope column", async () => {
    const w = await setup("nullable", {}, undefined, undefined, undefined, dimension);
    const id = await publish(w, [
      scoped,
      { ...init, text: init.text.replace("mandant_nr text not null", "mandant_nr text") }
    ]);
    const record = await eventually(async () => {
      await w.worker.runDue();
      const record = await recordOf(w, id);
      expect(record.status).toBe("ready");
      expect(record.failure !== undefined || record.level > 0).toBe(true);
      return record;
    });
    expect(record).toMatchObject({ level: 0, failure: { code: "scope_column_invalid" } });
  });
});
