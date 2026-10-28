import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asUserId,
  type JsonObject,
  dataStoreDescriptionSchema,
  DATA_STORE_DESCRIPTION_TOOL_NAME
} from "@work-shape/catalyst-core";
import { clientInstanceId, useDataStoreInstance, finding } from "./support/data-store-instance";
import { injectStartConversationRun, drainRunEvents } from "./support/chat-server-run-harness";
import { eventually } from "./support/assertions";
import { getTestJobs } from "./support/test-instance";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { required } from "./support/assertions";
import { inDays } from "./support/personal-api-keys";

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

  it("requires the page's read right on the specific store and refuses in a plain sentence", async () => {
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
    expect(unreadable).toMatchObject({
      status: "failed",
      error: { code: "NOT_FOUND", message: "This Data Store is not available to you." }
    });
    expect(missing).toMatchObject({
      status: "failed",
      error: { code: "NOT_FOUND", message: "This Data Store is not available to you." }
    });
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
