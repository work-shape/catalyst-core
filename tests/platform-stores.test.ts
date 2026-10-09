import { afterEach, describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asConversationId,
  type ClientInstanceId,
  type PlatformStores
} from "@vivd-catalyst/core";
import { usePostgresSuite } from "./support/postgres-suite";

// A real database is required: skipping would leave transaction semantics unverified.
describe("named Postgres stores", () => {
  const db = usePostgresSuite("named_stores");
  const instances: ClientInstanceId[] = [];
  afterEach(async () => {
    for (const id of instances.splice(0)) {
      await db.sql`delete from approval_requests where client_instance_id = ${id}`;
      await db.sql`delete from model_usage_events where client_instance_id = ${id}`;
      await db.sql`delete from config_asset_revisions where client_instance_id = ${id}`;
      await db.sql`delete from config_assets where client_instance_id = ${id}`;
      await db.sql`delete from config_asset_state where client_instance_id = ${id}`;
      await db.sql`delete from service_principals where client_instance_id = ${id}`;
    }
  });

  for (const outcome of ["commit", "rollback"] as const) {
    it(`binds every domain to one transaction and ${outcome}s cross-store writes`, async () => {
      const clientInstanceId = db.clientInstance(outcome);
      instances.push(clientInstanceId);
      const scope = { clientInstanceId };
      const failure = new Error("rollback all named stores");
      const result = db.store.transaction(async (stores) => {
        const records = await writeEveryDomain(stores, clientInstanceId);
        const inTransaction = await readEveryDomain(stores, clientInstanceId, records);
        expect(inTransaction).toEqual(present);
        // A second pool cannot see any of these writes before the callback commits.
        expect(await readEveryDomain(db.secondStore, clientInstanceId, records)).toEqual(absent);
        if (outcome === "rollback") throw failure;
        return records;
      });
      if (outcome === "rollback") {
        await expect(result).rejects.toBe(failure);
        expect(await db.secondStore.users.listUsers(scope)).toEqual([]);
        expect(await db.secondStore.audit.listAuditEvents(scope)).toEqual([]);
        expect(await db.secondStore.apiAccess.listServicePrincipals(scope)).toEqual([]);
        expect(
          await db.secondStore.approvals.listApprovalRequests({ ...scope, kinds: ["test"] })
        ).toEqual([]);
        expect(await db.secondStore.configAssets.getConfigAssetState(scope)).toEqual({
          version: 0
        });
        expect(await db.secondStore.usage.listModelUsageEvents(scope)).toEqual([]);
        // Conversation-owned rows cascade; the independent file row must also be rolled back.
        const rows = await db.sql<
          { count: number }[]
        >`select count(*)::int as count from managed_files where client_instance_id = ${clientInstanceId}`;
        expect(rows[0]?.count).toBe(0);
      } else {
        const records = await result;
        expect(await readEveryDomain(db.secondStore, clientInstanceId, records)).toEqual(present);
      }
    });
  }

  it("rolls back a successful inner savepoint with its outer transaction", async () => {
    const clientInstanceId = db.clientInstance("outer_rollback");
    instances.push(clientInstanceId);
    const scope = { clientInstanceId };
    await expect(
      db.store.transaction(async (stores) => {
        await stores.users.createUser({ ...scope, displayLabel: "outer" });
        await stores.transaction(async (nested) => {
          await nested.users.createUser({ ...scope, displayLabel: "inner" });
          await nested.audit.appendAuditEvent({
            ...scope,
            type: "inner",
            status: "success",
            correlationId: "outer_rollback"
          });
        });
        expect(await stores.users.listUsers(scope)).toHaveLength(2);
        throw new Error("outer rollback");
      })
    ).rejects.toThrow("outer rollback");
    expect(await db.secondStore.users.listUsers(scope)).toEqual([]);
    expect(await db.secondStore.audit.listAuditEvents(scope)).toEqual([]);
  });

  it("recovers a nested SQL error without retaining partial writes", async () => {
    const clientInstanceId = db.clientInstance("sql_error");
    instances.push(clientInstanceId);
    const scope = { clientInstanceId };
    await db.store.transaction(async (stores) => {
      await expect(
        stores.transaction(async (nested) => {
          await nested.audit.appendAuditEvent({
            ...scope,
            type: "partial",
            status: "success",
            correlationId: "sql_error"
          });
          // The real foreign key fails this SQL statement after the audit write succeeded.
          await nested.structuredData.publishStructuredDataResource({
            ...scope,
            conversationId: asConversationId(globalThis.crypto.randomUUID()),
            resourceKey: "missing",
            title: "missing",
            state: { title: "missing", sections: [] }
          });
        })
      ).rejects.toMatchObject({ cause: { code: "23503" } });
      expect(await stores.audit.listAuditEvents(scope)).toEqual([]);
      await stores.users.createUser({ ...scope, displayLabel: "after SQL error" });
    });
    expect(await db.secondStore.audit.listAuditEvents(scope)).toEqual([]);
    expect(await db.secondStore.users.listUsers(scope)).toHaveLength(1);
  });

  it("uses savepoints for nested calls and keeps the outer transaction usable after rejection", async () => {
    const clientInstanceId = db.clientInstance("savepoint");
    instances.push(clientInstanceId);
    const scope = { clientInstanceId };
    await db.store.transaction(async (stores) => {
      await stores.users.createUser({ ...scope, displayLabel: "outer" });
      await expect(
        stores.transaction(async (nested) => {
          await nested.users.createUser({ ...scope, displayLabel: "inner" });
          await nested.audit.appendAuditEvent({
            ...scope,
            type: "inner",
            status: "success",
            correlationId: "nested"
          });
          throw new Error("nested rollback");
        })
      ).rejects.toThrow("nested rollback");
      expect((await stores.users.listUsers(scope)).map((user) => user.displayLabel)).toEqual([
        "outer"
      ]);
      expect(await stores.audit.listAuditEvents(scope)).toEqual([]);
      await stores.audit.appendAuditEvent({
        ...scope,
        type: "outer",
        status: "success",
        correlationId: "nested"
      });
      // A successful inner savepoint is still part of the outer transaction.
      await stores.transaction(async (nested) => {
        await nested.users.createUser({ ...scope, displayLabel: "inner committed" });
      });
      expect(await db.secondStore.users.listUsers(scope)).toEqual([]);
    });
    expect(await db.secondStore.users.listUsers(scope)).toHaveLength(2);
    expect(await db.secondStore.audit.listAuditEvents(scope)).toMatchObject([{ type: "outer" }]);
  });
});

const present = {
  users: 1,
  workspaces: true,
  conversations: true,
  agentRuns: true,
  files: true,
  audit: 1,
  usage: 1,
  apiAccess: 1,
  configAssets: 1,
  approvals: true,
  executionWorkspaces: true,
  structuredData: true
};
const absent = {
  users: 0,
  workspaces: false,
  conversations: false,
  agentRuns: false,
  files: false,
  audit: 0,
  usage: 0,
  apiAccess: 0,
  configAssets: 0,
  approvals: false,
  executionWorkspaces: false,
  structuredData: false
};

async function writeEveryDomain(stores: PlatformStores, clientInstanceId: ClientInstanceId) {
  const scope = { clientInstanceId };
  const user = await stores.users.createUser({ ...scope, displayLabel: "transaction user" });
  const workspace = await stores.workspaces.ensurePersonalWorkspace({ ...scope, userId: user.id });
  const conversation = await stores.conversations.createConversation({
    ...scope,
    collaborationWorkspaceId: workspace.id,
    visibility: "workspace",
    createdByUserId: user.id,
    createdByExternalUserId: "test",
    title: "transaction",
    retainedUntil: "2099-01-01T00:00:00.000Z"
  });
  const message = await stores.conversations.appendMessage({
    ...scope,
    conversationId: conversation.id,
    role: "user",
    text: "start"
  });
  const run = await stores.agentRuns.createAgentRun({
    ...scope,
    id: asAgentRunId(globalThis.crypto.randomUUID()),
    conversationId: conversation.id,
    ownerUserId: user.id,
    inputMessageId: message.id,
    agentName: "test",
    correlationId: "transaction"
  });
  const file = await stores.files.createManagedFile({
    ...scope,
    ownerUserId: user.id,
    filename: "transaction.txt",
    byteSize: 1,
    checksum: "transaction",
    objectKey: "transaction"
  });
  await stores.audit.appendAuditEvent({
    ...scope,
    type: "transaction",
    status: "success",
    correlationId: "transaction"
  });
  await stores.usage.appendModelUsageEvent({
    ...scope,
    conversationId: conversation.id,
    agentRunId: run.id,
    agentName: "test",
    providerId: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    source: "provider_reported",
    webSearchCallCount: 0,
    fastMode: false,
    customerBillableCost: {
      status: "unpriced",
      source: "rate_card",
      calculationVersion: 1,
      missingMeters: ["model_rate"]
    },
    correlationId: "transaction"
  });
  await stores.apiAccess.createServicePrincipal({ ...scope, displayLabel: "transaction" });
  await stores.configAssets.applyConfigAssetMutations({
    ...scope,
    mutations: [
      {
        type: "upsert",
        kind: "skill",
        name: "transaction",
        config: { name: "transaction", description: "test", content: "test" }
      }
    ]
  });
  const approval = await stores.approvals.createApprovalRequest({
    ...scope,
    kind: "test",
    summary: "transaction",
    payload: {},
    requestedBy: { id: user.id, displayLabel: user.displayLabel }
  });
  const execution = await stores.executionWorkspaces.ensureExecutionWorkspace({
    ...scope,
    conversationId: conversation.id,
    ownerUserId: user.id
  });
  const structured = await stores.structuredData.publishStructuredDataResource({
    ...scope,
    conversationId: conversation.id,
    resourceKey: "transaction",
    title: "transaction",
    state: { title: "transaction", sections: [] }
  });
  return { workspace, conversation, run, file, approval, execution, structured };
}

async function readEveryDomain(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  records: Awaited<ReturnType<typeof writeEveryDomain>>
) {
  const scope = { clientInstanceId };
  return {
    users: (await stores.users.listUsers(scope)).length,
    workspaces: !!(await stores.workspaces.getWorkspace(clientInstanceId, records.workspace.id)),
    conversations: !!(await stores.conversations.getConversation(
      clientInstanceId,
      records.conversation.id
    )),
    agentRuns: !!(await stores.agentRuns.getAgentRun({ ...scope, runId: records.run.id })),
    files: !!(await stores.files.getManagedFile({ ...scope, fileId: records.file.id })),
    audit: (await stores.audit.listAuditEvents(scope)).length,
    usage: (await stores.usage.listModelUsageEvents(scope)).length,
    apiAccess: (await stores.apiAccess.listServicePrincipals(scope)).length,
    configAssets: (await stores.configAssets.getConfigAssetState(scope)).version,
    approvals: !!(await stores.approvals.getApprovalRequest({
      ...scope,
      requestId: records.approval.id
    })),
    executionWorkspaces: !!(await stores.executionWorkspaces.getExecutionWorkspace({
      ...scope,
      workspaceId: records.execution.id
    })),
    structuredData: !!(await stores.structuredData.getStructuredDataResource({
      ...scope,
      conversationId: records.conversation.id,
      structuredDataResourceId: records.structured.id
    }))
  };
}
