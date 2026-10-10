import { accessOf, callerOf } from "./support/access";
import { createTestInstance } from "./support/test-instance";
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

async function fixture() {
  const store = (await createTestInstance()).stores;
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
    store: store.approvals,
    handlers,
    onDecided,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit })
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
    const f = await fixture();
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
    const events = await f.store.audit.listAuditEvents({ clientInstanceId });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({ requestId: request.id, kind: "fake", status: "pending" });
  });

  it("denies decisions without the effective permission, including role revocations", async () => {
    const f = await fixture();
    const request = await f.create();
    for (const user of [
      requester,
      { ...requester, roles: ["admin"], permissions: ["!agent_skills.approve"] }
    ]) {
      await expect(
        f.workflow.decideRequest(user, accessOf(user), context, {
          requestId: request.id,
          decision: "approve"
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(f.apply).not.toHaveBeenCalled();
  });

  it("approves as the deciding user and persists the apply result before the hook", async () => {
    const f = await fixture();
    const request = await f.create();
    f.onDecided.mockImplementation(async (updated) => {
      expect(
        await f.store.approvals.getApprovalRequest({ clientInstanceId, requestId: updated.id })
      ).toEqual(updated);
    });
    const updated = await f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
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
      (await f.store.audit.listAuditEvents({ clientInstanceId })).find(
        (e) => e.type === "approval_request.decided"
      )?.metadata
    ).toEqual({ requestId: request.id, kind: "fake", status: "approved" });
  });

  it("grants admins and superadmins approval by default", async () => {
    const f = await fixture();
    for (const role of ["admin", "superadmin"]) {
      const request = await f.create();
      await expect(
        f.workflow.decideRequest(...callerOf({ ...requester, roles: [role] }), context, {
          requestId: request.id,
          decision: "approve"
        })
      ).resolves.toMatchObject({ status: "approved" });
    }
  });

  it("supersedes stale requests without applying", async () => {
    const f = await fixture();
    f.handler.isStale = async () => true;
    const request = await f.create();
    await expect(
      f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: request.id,
        decision: "approve"
      })
    ).resolves.toMatchObject({ status: "superseded" });
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.onDecided).toHaveBeenCalledTimes(1);
  });

  it("rejects without validation or apply and retains the optional comment", async () => {
    const f = await fixture();
    const request = await f.create();
    await expect(
      f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
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
    const f = await fixture();
    const request = await f.create();
    for (const comment of [undefined, "", "   "]) {
      await expect(
        f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
          requestId: request.id,
          decision: "request_changes",
          comment
        })
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await expect(
      f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
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
    const f = await fixture();
    const request = await f.create();
    await expect(
      f.workflow.withdrawRequest(reviewer, accessOf(reviewer), context, request.id)
    ).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
    const withdrawn = await f.workflow.withdrawRequest(
      requester,
      accessOf(requester),
      context,
      request.id
    );
    expect(withdrawn.status).toBe("withdrawn");
    expect(f.onDecided).toHaveBeenCalledWith(withdrawn);
    await expect(
      f.workflow.withdrawRequest(requester, accessOf(requester), context, request.id)
    ).rejects.toMatchObject({
      code: "CONFLICT"
    });
    await expect(
      f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: request.id,
        decision: "approve"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.apply).not.toHaveBeenCalled();
    const decided = await f.create();
    await f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
      requestId: decided.id,
      decision: "reject"
    });
    await expect(
      f.workflow.withdrawRequest(requester, accessOf(requester), context, decided.id)
    ).rejects.toMatchObject({
      code: "CONFLICT"
    });
  });

  it("lets only one concurrent decision apply", async () => {
    const f = await fixture();
    const request = await f.create();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.apply.mockImplementation(async () => {
      await gate;
      return { applied: true };
    });
    const first = f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
      requestId: request.id,
      decision: "approve"
    });
    await vi.waitFor(() => expect(f.apply).toHaveBeenCalledTimes(1));
    // The approval holds the row lock until its handler returns, so the other two wait on it.
    const rejection = f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
      requestId: request.id,
      decision: "reject"
    });
    const withdrawal = f.workflow.withdrawRequest(
      requester,
      accessOf(requester),
      context,
      request.id
    );
    release?.();
    const [approved, rejected, withdrawn] = await Promise.allSettled([
      first,
      rejection,
      withdrawal
    ]);
    expect(approved).toMatchObject({ status: "fulfilled", value: { status: "approved" } });
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    expect(withdrawn).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } });
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(f.onDecided).toHaveBeenCalledTimes(1);
  });

  it("leaves failed apply pending and releases the transition lock", async () => {
    const f = await fixture();
    const request = await f.create();
    f.apply.mockRejectedValueOnce(new Error("Failed"));
    await expect(
      f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: request.id,
        decision: "approve"
      })
    ).rejects.toThrow("Failed");
    expect(f.onDecided).not.toHaveBeenCalled();
    await expect(
      f.workflow.getRequest(requester, accessOf(requester), context, request.id)
    ).resolves.toMatchObject({
      status: "pending"
    });
    await expect(
      f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: request.id,
        decision: "reject"
      })
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("refuses to reject or withdraw a request whose change is already applied", async () => {
    const f = await fixture();
    const request = await f.create();
    f.handler.isApplied = async () => true;
    await expect(
      f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: request.id,
        decision: "reject"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.workflow.withdrawRequest(requester, accessOf(requester), context, request.id)
    ).rejects.toMatchObject({
      code: "CONFLICT"
    });
    expect(f.onDecided).not.toHaveBeenCalled();
    await expect(
      f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: request.id,
        decision: "approve"
      })
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("limits the queue and count to permitted kinds, including status filtering", async () => {
    const f = await fixture();
    const visible = await f.create();
    await f.create("other");
    const rejected = await f.create();
    await f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
      requestId: rejected.id,
      decision: "reject"
    });
    expect(
      (await f.workflow.listRequests(reviewer, accessOf(reviewer), context)).map((r) => r.id).sort()
    ).toEqual([visible.id, rejected.id].sort());
    expect(
      (
        await f.workflow.listRequests(reviewer, accessOf(reviewer), context, { status: "pending" })
      ).map((r) => r.id)
    ).toEqual([visible.id]);
    await expect(f.workflow.pendingCount(reviewer, accessOf(reviewer))).resolves.toEqual({
      count: 1,
      canReview: true,
      mine: { pending: 0, total: 0 }
    });
    await expect(
      f.workflow.listRequests(requester, accessOf(requester), context)
    ).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
    // The requester may decide nothing and still counts what they asked for, of every kind.
    await expect(f.workflow.pendingCount(requester, accessOf(requester))).resolves.toEqual({
      count: 0,
      canReview: false,
      mine: { pending: 2, total: 3 }
    });
  });

  it("lists a person's own requests of every kind and status without a review permission", async () => {
    const f = await fixture();
    const pending = await f.create();
    const otherKind = await f.create("other");
    const rejected = await f.create();
    await f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
      requestId: rejected.id,
      decision: "reject"
    });
    const colleague: AuthenticatedUser = {
      ...requester,
      id: "colleague",
      displayLabel: "Colleague"
    };
    const foreign = await f.workflow.createRequest(colleague, context, {
      kind: "fake",
      summary: "A colleague's change",
      payload: { value: "theirs" }
    });

    const own = await f.workflow.listOwnRequests(requester, accessOf(requester), context);
    expect(own.map((request) => request.id).sort()).toEqual(
      [pending.id, otherKind.id, rejected.id].sort()
    );
    expect(own.every((request) => !request.canDecide)).toBe(true);
    expect(own.find((request) => request.id === pending.id)).toMatchObject({ canWithdraw: true });
    expect(
      (await f.workflow.listOwnRequests(colleague, accessOf(colleague), context)).map(
        (request) => request.id
      )
    ).toEqual([foreign.id]);
    // A reviewer's own list holds what they asked for, not what they may decide.
    await expect(
      f.workflow.listOwnRequests(reviewer, accessOf(reviewer), context)
    ).resolves.toEqual([]);
    await expect(
      f.workflow.listOwnRequests(
        { ...requester, clientInstanceId: asClientInstanceId("another_instance") },
        accessOf(requester),
        context
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lists as decided what is no longer pending and changed in the last 30 days", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const decide = async (at: Date) => {
        vi.setSystemTime(at);
        const request = await f.create();
        await f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
          requestId: request.id,
          decision: "reject"
        });
        return request;
      };
      await decide(new Date("2026-08-01T10:00:00.000Z"));
      const inside = await decide(new Date("2026-09-10T10:00:00.000Z"));
      const newest = await decide(new Date("2026-10-01T10:00:00.000Z"));
      vi.setSystemTime(new Date("2026-10-05T10:00:00.000Z"));
      await f.create();
      await f.create("other");

      expect(
        (
          await f.workflow.listRequests(reviewer, accessOf(reviewer), context, { scope: "decided" })
        ).map((request) => request.id)
      ).toEqual([newest.id, inside.id]);
      await expect(
        f.workflow.listRequests(requester, accessOf(requester), context, { scope: "decided" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the newest 200 requests while counting all pending requests", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const requests: ApprovalRequest[] = [];
      for (let index = 0; index < 205; index += 1) {
        vi.setSystemTime(new Date(Date.UTC(2026, 9, 5, 12, 0, index)));
        requests.push(await f.create());
      }
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 5, 13)));
      await f.create("other");
      // The store returns the page it is asked for; the route always asks for one.
      expect(
        (
          await f.workflow.listRequests(reviewer, accessOf(reviewer), context, {
            status: "pending",
            page: { limit: 200 }
          })
        ).map((r) => r.id)
      ).toEqual(
        requests
          .slice(-200)
          .reverse()
          .map((r) => r.id)
      );
      await expect(f.workflow.pendingCount(reviewer, accessOf(reviewer))).resolves.toEqual({
        count: 205,
        canReview: true,
        mine: { pending: 0, total: 0 }
      });
      await expect(
        f.workflow.pendingCount(
          ...callerOf({ ...reviewer, permissions: ["!agent_skills.approve"] })
        )
      ).resolves.toEqual({ count: 0, canReview: false, mine: { pending: 0, total: 0 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows previews and caller capabilities while hiding unrelated requests", async () => {
    const f = await fixture();
    const request = await f.create();
    await expect(
      f.workflow.getRequest(requester, accessOf(requester), context, request.id)
    ).resolves.toMatchObject({
      preview: { proposed: "new" },
      canDecide: false,
      canWithdraw: true
    });
    await expect(
      f.workflow.getRequest(reviewer, accessOf(reviewer), context, request.id)
    ).resolves.toMatchObject({
      canDecide: true,
      canWithdraw: false
    });
    for (const id of [request.id, "missing"]) {
      await expect(
        f.workflow.getRequest(...callerOf({ ...requester, id: "stranger" }), context, id)
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      f.workflow.getRequest(
        ...callerOf({ ...reviewer, clientInstanceId: asClientInstanceId("another") }),
        context,
        request.id
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const selfApprover = { ...requester, permissions: ["agent_skills.approve"] };
    await expect(
      f.workflow.getRequest(selfApprover, accessOf(selfApprover), context, request.id)
    ).resolves.toMatchObject({
      canDecide: true,
      canWithdraw: true
    });
    await f.workflow.decideRequest(selfApprover, accessOf(selfApprover), context, {
      requestId: request.id,
      decision: "approve"
    });
    await expect(
      f.workflow.getRequest(selfApprover, accessOf(selfApprover), context, request.id)
    ).resolves.toMatchObject({
      canDecide: false,
      canWithdraw: false
    });
  });

  it("offers no action the caller's token scopes would be refused", async () => {
    const f = await fixture();
    f.handler.revert = async () => ({});
    const pending = await f.create();
    const chatScoped = (user: AuthenticatedUser, scopes: string[]) => ({ ...user, scopes });
    await expect(
      f.workflow.getRequest(
        ...callerOf(chatScoped(reviewer, ["conversation:read"])),
        context,
        pending.id
      )
    ).resolves.toMatchObject({ canDecide: false });
    await expect(
      f.workflow.getRequest(
        ...callerOf(chatScoped(requester, ["conversation:read"])),
        context,
        pending.id
      )
    ).resolves.toMatchObject({ canWithdraw: false });
    await expect(
      f.workflow.getRequest(
        ...callerOf(chatScoped(requester, ["conversation:write"])),
        context,
        pending.id
      )
    ).resolves.toMatchObject({ canWithdraw: true });
    await expect(
      f.workflow.getRequest(
        ...callerOf(chatScoped(reviewer, ["governance:write"])),
        context,
        pending.id
      )
    ).resolves.toMatchObject({ canDecide: true });
    await f.workflow.decideRequest(reviewer, accessOf(reviewer), context, {
      requestId: pending.id,
      decision: "approve"
    });
    await expect(
      f.workflow.getRequest(
        ...callerOf(chatScoped(reviewer, ["conversation:read"])),
        context,
        pending.id
      )
    ).resolves.toMatchObject({ canRevert: false });
    await expect(
      f.workflow.getRequest(reviewer, accessOf(reviewer), context, pending.id)
    ).resolves.toMatchObject({
      canRevert: true
    });
  });

  it("handles an empty registry without granting queue access", async () => {
    const f = await fixture();
    f.handlers.clear();
    await expect(f.workflow.pendingCount(reviewer, accessOf(reviewer))).resolves.toEqual({
      count: 0,
      canReview: false,
      mine: { pending: 0, total: 0 }
    });
    await expect(
      f.workflow.listRequests(reviewer, accessOf(reviewer), context)
    ).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
    await expect(
      f.workflow.listOwnRequests(reviewer, accessOf(reviewer), context)
    ).resolves.toEqual([]);
    await expect(f.create()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
