import { describe, expect, it, vi } from "vitest";
import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  type ApprovalRequest,
  type ApprovalRequestHandler,
  type AuthenticatedUser,
  type JsonObject
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { ApprovalRequestWorkflow } from "@vivd-catalyst/chat-server";

const clientInstanceId = asClientInstanceId("approval_test");
const context = { correlationId: "approval_correlation" };
const requester: AuthenticatedUser = {
  id: "requester",
  externalUserId: "requester",
  displayLabel: "Requester",
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};
const reviewer: AuthenticatedUser = {
  ...requester,
  id: "reviewer",
  displayLabel: "Reviewer",
  permissions: ["agent_skills.approve"]
};

function fixture() {
  const store = new InMemoryPlatformStore();
  const apply = vi.fn(
    async (_payload: JsonObject, actor: AuthenticatedUser): Promise<JsonObject> => ({
      actorId: actor.id
    })
  );
  const validate = vi.fn((payload: JsonObject) => {
    if (typeof payload.value !== "string") throw new AppError("VALIDATION_FAILED", "Missing value");
    return payload;
  });
  const handler: ApprovalRequestHandler = {
    kind: "fake",
    requiredPermission: "agent_skills.approve",
    validate,
    preview: async (payload) => ({ proposed: payload.value ?? null }),
    isStale: vi.fn(async () => false),
    apply
  };
  const handlers = new Map([
    [handler.kind, handler],
    [
      "other",
      {
        ...handler,
        kind: "other",
        requiredPermission: "config_assets.write" as const
      }
    ]
  ]);
  const onDecided = vi.fn(async (_request: ApprovalRequest) => {});
  const workflow = new ApprovalRequestWorkflow({
    clientInstanceId,
    store,
    handlers,
    onDecided,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store })
  });
  const create = (kind = "fake") =>
    workflow.createRequest(requester, context, {
      kind,
      summary: "Proposed change",
      payload: { value: "new" }
    });
  return { store, handler, handlers, apply, validate, onDecided, workflow, create };
}

describe("approval request workflow", () => {
  it("validates creation and stores empty checks without payload in the audit", async () => {
    const f = fixture();
    await expect(
      f.workflow.createRequest(requester, context, {
        kind: "fake",
        summary: "Invalid",
        payload: {}
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const request = await f.create();
    expect(request).toMatchObject({
      status: "pending",
      checks: [],
      requestedBy: { id: requester.id }
    });
    const events = await f.store.listAuditEvents({ clientInstanceId });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({ requestId: request.id, kind: "fake", status: "pending" });
  });

  it("denies decisions without the effective permission, including role revocations", async () => {
    const f = fixture();
    const request = await f.create();
    for (const user of [
      requester,
      { ...requester, roles: ["admin"], permissions: ["!agent_skills.approve"] }
    ]) {
      await expect(
        f.workflow.decideRequest(user, context, {
          requestId: request.id,
          decision: "approve"
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("approves as the deciding user and persists the apply result before the hook", async () => {
    const f = fixture();
    const request = await f.create();
    f.onDecided.mockImplementation(async (updated) => {
      expect(await f.store.getApprovalRequest({ clientInstanceId, requestId: updated.id })).toEqual(
        updated
      );
    });
    const updated = await f.workflow.decideRequest(reviewer, context, {
      requestId: request.id,
      decision: "approve",
      comment: "Looks good"
    });
    expect(updated).toMatchObject({
      status: "approved",
      applyResult: { actorId: reviewer.id },
      decision: {
        approved: true,
        decidedBy: reviewer.id,
        decidedByLabel: reviewer.displayLabel,
        comment: "Looks good"
      }
    });
    expect(f.apply).toHaveBeenCalledWith(
      request.payload,
      reviewer,
      expect.objectContaining({ requestId: request.id })
    );
    expect(f.validate).toHaveBeenCalledTimes(2);
    expect(f.onDecided).toHaveBeenCalledWith(updated);
    expect(
      (await f.store.listAuditEvents({ clientInstanceId })).find(
        (e) => e.type === "approval_request.decided"
      )?.metadata
    ).toEqual({ requestId: request.id, kind: "fake", status: "approved" });
  });

  it("grants admins and superadmins approval by default", async () => {
    const f = fixture();
    for (const role of ["admin", "superadmin"]) {
      const request = await f.create();
      await expect(
        f.workflow.decideRequest({ ...requester, roles: [role] }, context, {
          requestId: request.id,
          decision: "approve"
        })
      ).resolves.toMatchObject({ status: "approved" });
    }
  });

  it("supersedes stale requests without applying", async () => {
    const f = fixture();
    f.handler.isStale = async () => true;
    const request = await f.create();
    await expect(
      f.workflow.decideRequest(reviewer, context, {
        requestId: request.id,
        decision: "approve"
      })
    ).resolves.toMatchObject({ status: "superseded" });
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.onDecided).toHaveBeenCalledTimes(1);
  });

  it("rejects without validation or apply and retains the optional comment", async () => {
    const f = fixture();
    const request = await f.create();
    await expect(
      f.workflow.decideRequest(reviewer, context, {
        requestId: request.id,
        decision: "reject",
        comment: "No"
      })
    ).resolves.toMatchObject({
      status: "rejected",
      decision: { approved: false, decidedByLabel: reviewer.displayLabel, comment: "No" }
    });
    expect(f.validate).toHaveBeenCalledTimes(1);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.onDecided).toHaveBeenCalledTimes(1);
  });

  it("requires a nonblank comment for request_changes", async () => {
    const f = fixture();
    const request = await f.create();
    for (const comment of [undefined, "", "   "]) {
      await expect(
        f.workflow.decideRequest(reviewer, context, {
          requestId: request.id,
          decision: "request_changes",
          comment
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await expect(
      f.workflow.decideRequest(reviewer, context, {
        requestId: request.id,
        decision: "request_changes",
        comment: " Please revise "
      })
    ).resolves.toMatchObject({
      status: "changes_requested",
      decision: { approved: false, decidedByLabel: reviewer.displayLabel, comment: "Please revise" }
    });
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.onDecided).toHaveBeenCalledTimes(1);
  });

  it("allows withdrawal only by the requester while pending", async () => {
    const f = fixture();
    const request = await f.create();
    await expect(f.workflow.withdrawRequest(reviewer, context, request.id)).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
    const withdrawn = await f.workflow.withdrawRequest(requester, context, request.id);
    expect(withdrawn.status).toBe("withdrawn");
    expect(f.onDecided).toHaveBeenCalledWith(withdrawn);
    await expect(f.workflow.withdrawRequest(requester, context, request.id)).rejects.toMatchObject({
      code: "CONFLICT"
    });
    await expect(
      f.workflow.decideRequest(reviewer, context, {
        requestId: request.id,
        decision: "approve"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.apply).not.toHaveBeenCalled();
    const decided = await f.create();
    await f.workflow.decideRequest(reviewer, context, {
      requestId: decided.id,
      decision: "reject"
    });
    await expect(f.workflow.withdrawRequest(requester, context, decided.id)).rejects.toMatchObject({
      code: "CONFLICT"
    });
  });

  it("lets only one concurrent decision apply", async () => {
    const f = fixture();
    const request = await f.create();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.apply.mockImplementation(async () => {
      await gate;
      return { applied: true };
    });
    const first = f.workflow.decideRequest(reviewer, context, {
      requestId: request.id,
      decision: "approve"
    });
    await vi.waitFor(() => expect(f.apply).toHaveBeenCalledTimes(1));
    await expect(
      f.workflow.decideRequest(reviewer, context, {
        requestId: request.id,
        decision: "reject"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.workflow.withdrawRequest(requester, context, request.id)).rejects.toMatchObject({
      code: "CONFLICT"
    });
    release?.();
    await expect(first).resolves.toMatchObject({ status: "approved" });
    expect(f.onDecided).toHaveBeenCalledTimes(1);
  });

  it("leaves failed apply pending and releases the transition lock", async () => {
    const f = fixture();
    const request = await f.create();
    f.apply.mockRejectedValueOnce(new Error("Failed"));
    await expect(
      f.workflow.decideRequest(reviewer, context, {
        requestId: request.id,
        decision: "approve"
      })
    ).rejects.toThrow("Failed");
    expect(f.onDecided).not.toHaveBeenCalled();
    await expect(f.workflow.getRequest(requester, context, request.id)).resolves.toMatchObject({
      status: "pending"
    });
    await expect(
      f.workflow.decideRequest(reviewer, context, {
        requestId: request.id,
        decision: "reject"
      })
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("limits the queue and count to permitted kinds, including status filtering", async () => {
    const f = fixture();
    const visible = await f.create();
    await f.create("other");
    const rejected = await f.create();
    await f.workflow.decideRequest(reviewer, context, {
      requestId: rejected.id,
      decision: "reject"
    });
    expect((await f.workflow.listRequests(reviewer, context)).map((r) => r.id).sort()).toEqual(
      [visible.id, rejected.id].sort()
    );
    expect(
      (await f.workflow.listRequests(reviewer, context, { status: "pending" })).map((r) => r.id)
    ).toEqual([visible.id]);
    await expect(f.workflow.pendingCount(reviewer)).resolves.toEqual({ count: 1, canReview: true });
    await expect(f.workflow.listRequests(requester, context)).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
    await expect(f.workflow.pendingCount(requester)).resolves.toEqual({
      count: 0,
      canReview: false
    });
  });

  it("returns the newest 200 requests while counting all pending requests", async () => {
    const f = fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const requests: ApprovalRequest[] = [];
      for (let index = 0; index < 205; index += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 9, 5, 12, 0, index)));
        requests.push(await f.create());
      }
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 5, 13)));
      await f.create("other");
      expect(
        (await f.workflow.listRequests(reviewer, context, { status: "pending" })).map((r) => r.id)
      ).toEqual(
        requests
          .slice(-200)
          .reverse()
          .map((r) => r.id)
      );
      await expect(f.workflow.pendingCount(reviewer)).resolves.toEqual({
        count: 205,
        canReview: true
      });
      await expect(
        f.workflow.pendingCount({ ...reviewer, permissions: ["!agent_skills.approve"] })
      ).resolves.toEqual({ count: 0, canReview: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows previews and caller capabilities while hiding unrelated requests", async () => {
    const f = fixture();
    const request = await f.create();
    await expect(f.workflow.getRequest(requester, context, request.id)).resolves.toMatchObject({
      preview: { proposed: "new" },
      canDecide: false,
      canWithdraw: true
    });
    await expect(f.workflow.getRequest(reviewer, context, request.id)).resolves.toMatchObject({
      canDecide: true,
      canWithdraw: false
    });
    for (const id of [request.id, "missing"]) {
      await expect(
        f.workflow.getRequest({ ...requester, id: "stranger" }, context, id)
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      f.workflow.getRequest(
        { ...reviewer, clientInstanceId: asClientInstanceId("another") },
        context,
        request.id
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const selfApprover = { ...requester, permissions: ["agent_skills.approve"] };
    await expect(f.workflow.getRequest(selfApprover, context, request.id)).resolves.toMatchObject({
      canDecide: true,
      canWithdraw: true
    });
    await f.workflow.decideRequest(selfApprover, context, {
      requestId: request.id,
      decision: "approve"
    });
    await expect(f.workflow.getRequest(selfApprover, context, request.id)).resolves.toMatchObject({
      canDecide: false,
      canWithdraw: false
    });
  });

  it("handles an empty registry without granting queue access", async () => {
    const f = fixture();
    f.handlers.clear();
    await expect(f.workflow.pendingCount(reviewer)).resolves.toEqual({
      count: 0,
      canReview: false
    });
    await expect(f.workflow.listRequests(reviewer, context)).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
    await expect(f.create()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
