import { describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  asClientInstanceId,
  asAgentRunId,
  asToolCallId,
  type ApprovalCheckResult,
  readApprovalDecisionMetadata
} from "@vivd-catalyst/core";
import { PostgresPlatformStore } from "@vivd-catalyst/postgres-store";

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Postgres approval request store", () => {
  it("scopes and bounds reads and atomically allows only one pending transition", async () => {
    const store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    const sql = postgres(databaseUrl!, { max: 1 });
    const clientInstanceId = asClientInstanceId(`approval_${globalThis.crypto.randomUUID()}`);
    const owner = await store.createUser({ clientInstanceId, displayLabel: "Owner" });
    const workspace = await store.ensurePersonalWorkspace({ clientInstanceId, userId: owner.id });
    const conversation = await store.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: owner.id,
      createdByExternalUserId: "owner",
      title: "Approval origin",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const checks: ApprovalCheckResult[] = [
      { id: "example_check", status: "warned", message: "Review the proposed content." }
    ];
    try {
      const request = await store.createApprovalRequest({
        clientInstanceId,
        kind: "fake",
        summary: "Proposed",
        checks,
        payload: { value: "new" },
        requestedBy: { id: "requester", displayLabel: "Requester" },
        origin: {
          conversationId: conversation.id,
          agentRunId: asAgentRunId("run"),
          toolCallId: asToolCallId("call"),
          agentName: "agent"
        }
      });
      expect(request).toMatchObject({ status: "pending", checks });
      expect(
        await store.getApprovalRequest({
          clientInstanceId: asClientInstanceId("other"),
          requestId: request.id
        })
      ).toBeUndefined();
      expect(
        await store.listApprovalRequests({
          clientInstanceId,
          kinds: ["fake"],
          conversationId: conversation.id
        })
      ).toEqual([request]);
      expect(await store.listApprovalRequests({ clientInstanceId, kinds: [] })).toEqual([]);
      expect(await store.countPendingApprovalRequests({ clientInstanceId, kinds: ["fake"] })).toBe(
        1
      );
      let applied = 0;
      const transition = () =>
        store.transitionPendingApprovalRequest({
          clientInstanceId,
          requestId: request.id,
          resolve: async () => {
            applied += 1;
            return {
              status: "approved",
              applyResult: { value: "applied" },
              decision: {
                approved: true,
                decidedBy: "reviewer",
                decidedByLabel: "Reviewer",
                decidedAt: new Date().toISOString()
              }
            };
          }
        });
      const outcomes = await Promise.allSettled([transition(), transition()]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
        reason: { code: "CONFLICT" }
      });
      expect(applied).toBe(1);
      const approved = await store.getApprovalRequest({ clientInstanceId, requestId: request.id });
      if (!approved) {
        throw new Error("Expected approved request");
      }
      await Promise.all([
        store.appendApprovalDecision(approved),
        store.appendApprovalDecision(approved)
      ]);
      const history = await store.listMessages({
        clientInstanceId,
        conversationId: conversation.id
      });
      expect(history).toHaveLength(1);
      expect(readApprovalDecisionMetadata(history[0]?.metadata)).toMatchObject({
        requestId: request.id,
        status: "approved",
        decidedByLabel: "Reviewer"
      });
      const reverted = await store.transitionApprovedApprovalRequest({
        clientInstanceId,
        requestId: request.id,
        resolve: async (current) => ({
          status: "reverted",
          decision: current.decision,
          applyResult: current.applyResult,
          reversion: {
            revertedBy: "other-reviewer",
            revertedByLabel: "Other reviewer",
            revertedAt: new Date().toISOString()
          }
        })
      });
      await store.appendApprovalDecision(reverted);
      expect(
        (await store.listMessages({ clientInstanceId, conversationId: conversation.id })).map(
          (message) => readApprovalDecisionMetadata(message.metadata)?.status
        )
      ).toEqual(["approved", "reverted"]);

      expect(
        await store.getApprovalRequest({ clientInstanceId, requestId: request.id })
      ).toMatchObject({
        status: "reverted",
        checks,
        applyResult: { value: "applied" },
        decision: { decidedByLabel: "Reviewer" }
      });
      expect(await store.countPendingApprovalRequests({ clientInstanceId, kinds: ["fake"] })).toBe(
        0
      );
      expect(
        await store.listApprovalRequests({ clientInstanceId, kinds: ["fake"], status: "pending" })
      ).toEqual([]);
      const queued = await Promise.all(
        Array.from({ length: 205 }, () =>
          store.createApprovalRequest({
            clientInstanceId,
            kind: "fake",
            summary: "Queued",
            payload: {},
            requestedBy: { id: "requester", displayLabel: "Requester" }
          })
        )
      );
      await store.createApprovalRequest({
        clientInstanceId,
        kind: "other",
        summary: "Unrelated",
        payload: {},
        requestedBy: { id: "requester", displayLabel: "Requester" }
      });
      const newest = queued
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
        )
        .slice(0, 200);
      expect(
        await store.listApprovalRequests({ clientInstanceId, kinds: ["fake"], status: "pending" })
      ).toEqual(newest);
      expect(await store.countPendingApprovalRequests({ clientInstanceId, kinds: ["fake"] })).toBe(
        205
      );
    } finally {
      await sql`delete from approval_requests where client_instance_id = ${clientInstanceId}`;
      await sql`delete from conversations where client_instance_id = ${clientInstanceId}`;
      await sql`delete from collaboration_workspaces where client_instance_id = ${clientInstanceId}`;
      await sql`delete from product_users where client_instance_id = ${clientInstanceId}`;
      await sql.end();
      await store.close();
    }
  });
});
