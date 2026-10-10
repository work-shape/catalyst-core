import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { fileTestDatabaseUrl } from "./support/test-database";
import {} from "vitest";
import { createTestInstance } from "./support/test-instance";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  asClientInstanceId,
  asAgentRunId,
  asToolCallId,
  type ApprovalCheckResult,
  readApprovalDecisionMetadata
} from "@vivd-catalyst/core";

describe("Postgres approval request store", () => {
  it("scopes and bounds reads and atomically allows only one pending transition", async () => {
    const store = (
      await createTestInstance({
        postgres: {}
      })
    ).stores;
    const sql = postgres(databaseUrl, { max: 1 });
    const clientInstanceId = asClientInstanceId(`approval_${globalThis.crypto.randomUUID()}`);
    const owner = await store.users.createUser({ clientInstanceId, displayLabel: "Owner" });
    const workspace = await store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: owner.id
    });
    const conversation = await store.conversations.createConversation({
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
      const request = await store.approvals.createApprovalRequest({
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
        await store.approvals.getApprovalRequest({
          clientInstanceId: asClientInstanceId("other"),
          requestId: request.id
        })
      ).toBeUndefined();
      expect(
        await store.approvals.listApprovalRequests({
          clientInstanceId,
          kinds: ["fake"],
          conversationId: conversation.id
        })
      ).toEqual([request]);
      expect(await store.approvals.listApprovalRequests({ clientInstanceId, kinds: [] })).toEqual(
        []
      );
      expect(
        await store.approvals.countPendingApprovalRequests({ clientInstanceId, kinds: ["fake"] })
      ).toBe(1);
      await expectOwnRequestsFromTheIndex(store, sql, clientInstanceId, request.id);
      let applied = 0;
      const transition = () =>
        store.approvals.transitionPendingApprovalRequest({
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
      const approved = await store.approvals.getApprovalRequest({
        clientInstanceId,
        requestId: request.id
      });
      if (!approved) {
        throw new Error("Expected approved request");
      }
      await Promise.all([
        store.approvals.appendApprovalDecision(approved),
        store.approvals.appendApprovalDecision(approved)
      ]);
      const history = await store.conversations.listMessages({
        clientInstanceId,
        conversationId: conversation.id
      });
      expect(history).toHaveLength(1);
      expect(readApprovalDecisionMetadata(history[0]?.metadata)).toMatchObject({
        requestId: request.id,
        status: "approved",
        decidedByLabel: "Reviewer"
      });
      const reverted = await store.approvals.transitionApprovedApprovalRequest({
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
      await store.approvals.appendApprovalDecision(reverted);
      expect(
        (
          await store.conversations.listMessages({
            clientInstanceId,
            conversationId: conversation.id
          })
        ).map((message) => readApprovalDecisionMetadata(message.metadata)?.status)
      ).toEqual(["approved", "reverted"]);

      expect(
        await store.approvals.getApprovalRequest({ clientInstanceId, requestId: request.id })
      ).toMatchObject({
        status: "reverted",
        checks,
        applyResult: { value: "applied" },
        decision: { decidedByLabel: "Reviewer" }
      });
      expect(
        await store.approvals.countPendingApprovalRequests({ clientInstanceId, kinds: ["fake"] })
      ).toBe(0);
      expect(
        await store.approvals.listApprovalRequests({
          clientInstanceId,
          kinds: ["fake"],
          status: "pending"
        })
      ).toEqual([]);
      const queued = await Promise.all(
        Array.from({ length: 205 }, () =>
          store.approvals.createApprovalRequest({
            clientInstanceId,
            kind: "fake",
            summary: "Queued",
            payload: {},
            requestedBy: { id: "requester", displayLabel: "Requester" }
          })
        )
      );
      await store.approvals.createApprovalRequest({
        clientInstanceId,
        kind: "other",
        summary: "Unrelated",
        payload: {},
        requestedBy: { id: "requester", displayLabel: "Requester" }
      });
      const newestFirst = queued.sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      );
      const list = (page: { limit: number; after?: [string, string] }) =>
        store.approvals.listApprovalRequests({
          clientInstanceId,
          kinds: ["fake"],
          status: "pending",
          page
        });
      // The store returns the page it is asked for and resumes below the last row of it.
      const firstPage = await list({ limit: 200 });
      expect(firstPage).toEqual(newestFirst.slice(0, 200));
      const anchor = firstPage[199];
      expect(anchor).toBeDefined();
      if (!anchor) return;
      expect(await list({ limit: 200, after: [anchor.createdAt, anchor.id] })).toEqual(
        newestFirst.slice(200)
      );
      expect(
        await store.approvals.countPendingApprovalRequests({ clientInstanceId, kinds: ["fake"] })
      ).toBe(205);
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

/**
 * A person's own requests are read by the requester index, not by a walk over the instance's
 * requests. The plan is asked without sequential scans, because on a table this small the
 * planner would otherwise prefer one whatever indexes exist.
 */
async function expectOwnRequestsFromTheIndex(
  store: Awaited<ReturnType<typeof createTestInstance>>["stores"],
  sql: postgres.Sql,
  clientInstanceId: ReturnType<typeof asClientInstanceId>,
  ownRequestId: string
): Promise<void> {
  const foreign = await store.approvals.createApprovalRequest({
    clientInstanceId,
    kind: "fake",
    summary: "Someone else's",
    payload: { value: "theirs" },
    requestedBy: { id: "someone_else", displayLabel: "Someone else" }
  });
  const own = { clientInstanceId, kinds: ["fake"], requestedById: "requester" };
  expect((await store.approvals.listApprovalRequests(own)).map((row) => row.id)).toEqual([
    ownRequestId
  ]);
  expect(await store.approvals.countOwnApprovalRequests(own)).toEqual({ pending: 1, total: 1 });
  expect(
    await store.approvals.countOwnApprovalRequests({ ...own, requestedById: "nobody" })
  ).toEqual({ pending: 0, total: 0 });
  expect(await store.approvals.countOwnApprovalRequests({ ...own, kinds: [] })).toEqual({
    pending: 0,
    total: 0
  });
  expect(
    (
      await store.approvals.listApprovalRequests({
        clientInstanceId,
        kinds: ["fake"],
        excludeStatus: "pending"
      })
    ).length
  ).toBe(0);
  expect(
    await store.approvals.listApprovalRequests({
      clientInstanceId,
      kinds: ["fake"],
      updatedSince: new Date(Date.now() + 60_000)
    })
  ).toEqual([]);

  const plan = await sql.begin(async (tx) => {
    await tx`set local enable_seqscan = off`;
    return tx<{ "QUERY PLAN": string }[]>`
      explain select * from approval_requests
      where client_instance_id = ${clientInstanceId}
        and (requested_by->>'id') = ${"requester"}
      order by created_at desc, id desc`;
  });
  expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
    "approval_requests_client_requester_idx"
  );
  await sql`delete from approval_requests where id = ${foreign.id}`;
}

let databaseUrl: string;
beforeAll(async () => {
  databaseUrl = await fileTestDatabaseUrl();
});
