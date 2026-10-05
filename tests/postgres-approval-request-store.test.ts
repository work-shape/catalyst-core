import { describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  asClientInstanceId,
  asConversationId,
  asAgentRunId,
  asToolCallId
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
    try {
      const request = await store.createApprovalRequest({
        clientInstanceId,
        kind: "fake",
        summary: "Proposed",
        payload: { value: "new" },
        requestedBy: { id: "requester", displayLabel: "Requester" },
        origin: {
          conversationId: asConversationId("conversation"),
          agentRunId: asAgentRunId("run"),
          toolCallId: asToolCallId("call"),
          agentName: "agent"
        }
      });
      expect(request).toMatchObject({ status: "pending", checks: [] });
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
          conversationId: asConversationId("conversation")
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
      expect(
        await store.getApprovalRequest({ clientInstanceId, requestId: request.id })
      ).toMatchObject({
        status: "approved",
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
      await sql.end();
      await store.close();
    }
  });
});
