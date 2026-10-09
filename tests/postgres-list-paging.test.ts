import { afterEach, describe, expect, it } from "vitest";
import { asAgentRunId, asConversationId, type ClientInstanceId } from "@vivd-catalyst/core";
import { required } from "./support/assertions";
import { usePostgresSuite } from "./support/postgres-suite";

describe("named store keyset paging", () => {
  const suite = usePostgresSuite("list_paging");
  const additionalCleanup: ClientInstanceId[] = [];
  afterEach(async () => {
    for (const clientInstanceId of additionalCleanup.splice(0)) {
      await suite.sql`delete from model_usage_events where client_instance_id = ${clientInstanceId}`;
      await suite.sql`delete from approval_requests where client_instance_id = ${clientInstanceId}`;
      await suite.sql`delete from config_assets where client_instance_id = ${clientInstanceId}`;
      await suite.sql`delete from config_asset_state where client_instance_id = ${clientInstanceId}`;
    }
  });

  it("pages tied conversations after a deleted anchor without including newer inserts", async () => {
    const clientInstanceId = suite.clientInstance("conversations");
    const user = await suite.store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
    const workspace = await suite.store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: user.id
    });
    const created = [];
    const updatedAt = "2026-10-09T12:00:00.000Z";
    for (let index = 0; index < 4; index++) {
      const conversation = await suite.store.conversations.createConversation({
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        createdByUserId: user.id,
        createdByExternalUserId: "owner",
        visibility: "workspace",
        title: String(index),
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      created.push(
        await suite.store.conversations.updateConversationTitle({
          clientInstanceId,
          conversationId: conversation.id,
          title: String(index),
          updatedAt
        })
      );
    }
    const input = {
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      scope: { kind: "lifecycle" }
    } as const;
    const first = await suite.store.conversations.listConversationsForWorkspace({
      ...input,
      page: { limit: 2 }
    });
    expect(first).toHaveLength(2);
    const anchor = required(first.at(-1));
    await suite.store.conversations.deleteConversation({
      clientInstanceId,
      conversationId: anchor.id,
      deletedAt: new Date().toISOString()
    });
    await suite.store.conversations.createConversation({
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: user.id,
      createdByExternalUserId: "owner",
      visibility: "workspace",
      title: "Newer",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const second = await suite.store.conversations.listConversationsForWorkspace({
      ...input,
      page: { limit: 2, after: [anchor.updatedAt, anchor.id] }
    });
    expect(second.map((row) => row.id)).toEqual(
      created
        .map((row) => row.id)
        .sort()
        .reverse()
        .slice(2)
    );
  });

  it("filters hidden users before limiting and matches byte ordering across case and accents", async () => {
    const clientInstanceId = suite.clientInstance("users");
    for (const displayLabel of ["A", "Z", "a", "Ä", "😀"]) {
      await suite.store.users.createUser({
        clientInstanceId,
        displayLabel,
        roles: displayLabel === "A" ? ["superadmin"] : ["user"]
      });
    }
    const first = await suite.store.users.listUsers({
      clientInstanceId,
      excludeSuperadmins: true,
      page: { limit: 2 }
    });
    expect(first.map((row) => row.displayLabel)).toEqual(["Z", "a"]);
    const anchor = required(first.at(-1));
    const second = await suite.store.users.listUsers({
      clientInstanceId,
      excludeSuperadmins: true,
      page: { limit: 2, after: [anchor.displayLabel, anchor.id] }
    });
    expect(second.map((row) => row.displayLabel)).toEqual(["Ä", "😀"]);
  });

  it("pages audit and usage events with createdAt/id keys", async () => {
    const clientInstanceId = suite.clientInstance("events");
    additionalCleanup.push(clientInstanceId);
    for (let index = 0; index < 3; index++) {
      await suite.store.audit.appendAuditEvent({
        clientInstanceId,
        type: "test",
        status: "success",
        correlationId: String(index)
      });
      await suite.store.usage.appendModelUsageEvent({
        clientInstanceId,
        conversationId: asConversationId("test"),
        agentRunId: asAgentRunId("test"),
        agentName: "test",
        providerId: "test",
        model: "test",
        correlationId: String(index),
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
        }
      });
    }
    const audit = await suite.store.audit.listAuditEvents({ clientInstanceId, page: { limit: 2 } });
    const usage = await suite.store.usage.listModelUsageEvents({
      clientInstanceId,
      page: { limit: 2 }
    });
    const auditAnchor = required(audit.at(-1));
    const usageAnchor = required(usage.at(-1));
    expect(
      await suite.store.audit.listAuditEvents({
        clientInstanceId,
        page: { limit: 2, after: [auditAnchor.createdAt, auditAnchor.id] }
      })
    ).toHaveLength(1);
    expect(
      await suite.store.usage.listModelUsageEvents({
        clientInstanceId,
        page: { limit: 2, after: [usageAnchor.createdAt, usageAnchor.id] }
      })
    ).toHaveLength(1);
  });

  it("pages revisions and approval requests instead of imposing an upstream cap", async () => {
    const clientInstanceId = suite.clientInstance("assets");
    additionalCleanup.push(clientInstanceId);
    for (let index = 0; index < 3; index++) {
      await suite.store.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        mutations: [
          { type: "upsert", kind: "agent", name: "test", config: { instructions: String(index) } }
        ]
      });
      await suite.store.approvals.createApprovalRequest({
        clientInstanceId,
        kind: "test",
        summary: "Test",
        payload: {},
        checks: [],
        requestedBy: { id: "test", displayLabel: "Test" }
      });
    }
    const revisions = await suite.store.configAssets.listConfigAssetRevisions({
      clientInstanceId,
      kind: "agent",
      name: "test",
      page: { limit: 2 }
    });
    expect(revisions.map((row) => row.revision)).toEqual([1, 2]);
    expect(
      (
        await suite.store.configAssets.listConfigAssetRevisions({
          clientInstanceId,
          kind: "agent",
          name: "test",
          page: { limit: 2, after: [2] }
        })
      ).map((row) => row.revision)
    ).toEqual([3]);
    const requests = await suite.store.approvals.listApprovalRequests({
      clientInstanceId,
      kinds: ["test"],
      page: { limit: 2 }
    });
    const anchor = required(requests.at(-1));
    expect(
      await suite.store.approvals.listApprovalRequests({
        clientInstanceId,
        kinds: ["test"],
        page: { limit: 2, after: [anchor.createdAt, anchor.id] }
      })
    ).toHaveLength(1);
  });
});
