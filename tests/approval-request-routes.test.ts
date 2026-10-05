import { describe, expect, it } from "vitest";
import { createApiClient } from "@vivd-catalyst/api-client";
import { approvalRequestSchema } from "@vivd-catalyst/api-contract";
import { asClientInstanceId, type ApprovalRequestHandler } from "@vivd-catalyst/core";
import { createClientInstanceApp, createTestConfig } from "./chat-server-harness";

const fakeHandler: ApprovalRequestHandler = {
  kind: "fake",
  requiredPermission: "agent_skills.approve",
  validate: (payload) => payload,
  preview: async (payload) => ({ proposed: payload.value ?? null }),
  isStale: async () => false,
  apply: async (_payload, actor) => ({ actorId: actor.id }),
  revert: async (_request, actor) => ({ actorId: actor.id })
};

async function fixture(empty = false) {
  const app = await createClientInstanceApp({
    config: createTestConfig({
      developmentAuth: {
        enabled: true,
        users: [
          {
            id: "requester",
            externalUserId: "requester",
            displayLabel: "Requester",
            roles: ["user"],
            permissionRefs: []
          },
          {
            id: "reviewer",
            externalUserId: "reviewer",
            displayLabel: "Reviewer",
            roles: ["admin"],
            permissionRefs: []
          },
          {
            id: "stranger",
            externalUserId: "stranger",
            displayLabel: "Stranger",
            roles: ["user"],
            permissionRefs: []
          }
        ],
        defaultUserId: "requester"
      }
    }),
    env: {},
    storeMode: "memory",
    tools: [],
    ...(empty ? {} : { approvalRequestHandlers: new Map([[fakeHandler.kind, fakeHandler]]) })
  });
  function client(user: string) {
    return createApiClient({
      baseUrl: "https://approval.example",
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const response = await app.server.inject({
          method: request.method as "GET" | "POST",
          url: new URL(request.url).pathname + new URL(request.url).search,
          headers: { ...Object.fromEntries(request.headers), "x-dev-user-id": user },
          ...(request.method === "POST" && request.body ? { payload: await request.text() } : {})
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: { "content-type": "application/json" }
        });
      }
    });
  }
  const requester = client("requester");
  const reviewer = client("reviewer");
  const stranger = client("stranger");
  const requesterUser = await requester.account.get();
  const create = () =>
    app.store.createApprovalRequest({
      clientInstanceId: asClientInstanceId(app.config.clientInstance.id),
      kind: "fake",
      summary: "Proposed",
      payload: { value: "new" },
      requestedBy: { id: requesterUser.id, displayLabel: requesterUser.displayLabel }
    });
  return { app, requester, reviewer, stranger, create };
}

describe("approval routes and generated instance client", () => {
  it("reads the queue and badge, validates decisions and applies as the reviewer", async () => {
    const f = await fixture();
    try {
      const request = await f.create();
      await expect(f.requester.approvalRequests.get(request.id)).resolves.toMatchObject({
        preview: { proposed: "new" },
        canDecide: false,
        canWithdraw: true
      });
      await expect(f.requester.approvalRequests.pendingCount()).resolves.toEqual({
        count: 0,
        canReview: false
      });
      await expect(f.requester.approvalRequests.list()).rejects.toMatchObject({ status: 403 });
      await expect(f.stranger.approvalRequests.get(request.id)).rejects.toMatchObject({
        status: 404
      });
      await expect(f.stranger.approvalRequests.get("missing")).rejects.toMatchObject({
        status: 404
      });
      await expect(f.reviewer.approvalRequests.pendingCount()).resolves.toEqual({
        count: 1,
        canReview: true
      });
      expect(await f.reviewer.approvalRequests.list("pending")).toMatchObject([
        { id: request.id, canDecide: true }
      ]);
      const invalid = await f.app.server.inject({
        method: "POST",
        url: `/api/approval-requests/${request.id}/decide`,
        headers: { "x-dev-user-id": "reviewer" },
        payload: { decision: "request_changes", comment: " " }
      });
      expect(invalid.statusCode).toBe(422);
      const invalidFilter = await f.app.server.inject({
        method: "GET",
        url: "/api/approval-requests?status=invalid",
        headers: { "x-dev-user-id": "reviewer" }
      });
      expect(invalidFilter.statusCode).toBe(422);
      await expect(
        f.requester.approvalRequests.decide(request.id, { decision: "approve" })
      ).rejects.toMatchObject({ status: 403 });
      const reviewerUser = await f.reviewer.account.get();
      const approved = await f.reviewer.approvalRequests.decide(request.id, {
        decision: "approve"
      });
      expect(approvalRequestSchema.parse(approved)).toMatchObject({
        status: "approved",
        decision: { decidedBy: reviewerUser.id, decidedByLabel: reviewerUser.displayLabel },
        applyResult: { actorId: reviewerUser.id }
      });
      await expect(f.reviewer.approvalRequests.pendingCount()).resolves.toEqual({
        count: 0,
        canReview: true
      });
      await expect(f.reviewer.approvalRequests.list("pending")).resolves.toEqual([]);
      await expect(
        f.reviewer.approvalRequests.decide(request.id, { decision: "reject" })
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await f.app.close();
    }
  });

  it("reverts through the generated client only for permitted reviewers", async () => {
    const f = await fixture();
    try {
      const request = await f.create();
      await expect(f.reviewer.approvalRequests.revert(request.id)).rejects.toMatchObject({
        status: 409
      });
      await f.reviewer.approvalRequests.decide(request.id, { decision: "approve" });
      expect(await f.reviewer.approvalRequests.get(request.id)).toMatchObject({ canRevert: true });
      await expect(f.requester.approvalRequests.revert(request.id)).rejects.toMatchObject({
        status: 403
      });
      expect(await f.reviewer.approvalRequests.revert(request.id)).toMatchObject({
        status: "reverted",
        reversion: { revertedByLabel: "Reviewer" }
      });
      expect(await f.reviewer.approvalRequests.get(request.id)).toMatchObject({ canRevert: false });
      await expect(f.reviewer.approvalRequests.revert(request.id)).rejects.toMatchObject({
        status: 409
      });
    } finally {
      await f.app.close();
    }
  });

  it("withdraws through the client only for the requester", async () => {
    const f = await fixture();
    try {
      const request = await f.create();
      await expect(f.reviewer.approvalRequests.withdraw(request.id)).rejects.toMatchObject({
        status: 403
      });
      await expect(f.requester.approvalRequests.withdraw(request.id)).resolves.toMatchObject({
        status: "withdrawn"
      });
      await expect(f.requester.approvalRequests.withdraw(request.id)).rejects.toMatchObject({
        status: 409
      });
    } finally {
      await f.app.close();
    }
  });

  it("assembles and registers the routes with no handlers", async () => {
    const f = await fixture(true);
    try {
      await expect(f.reviewer.approvalRequests.pendingCount()).resolves.toEqual({
        count: 0,
        canReview: false
      });
      await expect(f.reviewer.approvalRequests.list()).rejects.toMatchObject({ status: 403 });
      await expect(f.reviewer.approvalRequests.get("missing")).rejects.toMatchObject({
        status: 404
      });
    } finally {
      await f.app.close();
    }
  });
});
