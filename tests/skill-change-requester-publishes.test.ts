import { describe, expect, it } from "vitest";
import {
  StoreBackedAuditRecorder,
  asUserId,
  type AuthenticatedUser,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { ApprovalRequestWorkflow } from "@work-shape/catalyst-server";
import { accessOf } from "./support/access";
import { clientInstanceId, context, fixture, requester } from "./support/skill-change-fixture";

// SKILL-ACCEPT-1 (2026-11-16): a person who may make a skill live (`skill.publish`)
// accepts the change their agent proposed for it themselves, and it is live at once. Nobody
// else decides a request through `skill.publish`: without `skill.approve` another person's
// request stays theirs to wait on.

const publisher: AuthenticatedUser = { ...requester, id: "publisher", displayLabel: "Publisher" };
const other: AuthenticatedUser = { ...requester, id: "other", displayLabel: "Other" };

function publishGrant(
  user: AuthenticatedUser,
  scope: Pick<PermissionGrant, "scopeKind" | "scopeId">
) {
  return accessOf(user, {
    grants: [
      {
        id: `grant_${user.id}`,
        clientInstanceId,
        holderKind: "user",
        holderId: user.id,
        action: "skill.publish",
        effect: "allow",
        ...scope,
        grantedBy: asUserId("admin"),
        createdAt: "2026-11-16T00:00:00.000Z"
      }
    ]
  });
}

describe("a skill change its requester may publish", () => {
  it("is accepted by the requester and is live at once, and nobody else decides it with skill.publish", async () => {
    const f = await fixture(undefined, "shared");
    const stored = await f.store.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name: "review"
    });
    if (!stored) throw new Error("Skill review missing");
    const scope =
      stored.scope.kind === "workspace"
        ? ({ scopeKind: "workspace", scopeId: stored.scope.workspaceId } as const)
        : ({ scopeKind: "instance" } as const);
    const publisherAccess = publishGrant(publisher, scope);
    const otherAccess = publishGrant(other, scope);
    expect(publisherAccess.authorize("skill.approve").allowed).toBe(false);
    const workflow = new ApprovalRequestWorkflow({
      clientInstanceId,
      store: f.store.approvals,
      handlers: new Map([[f.handler.kind, f.handler]]),
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: f.store.audit }),
      authorizer: {
        forActor: (actor) =>
          Promise.resolve(
            actor.id === publisher.id
              ? publisherAccess
              : actor.id === other.id
                ? otherAccess
                : accessOf(actor)
          )
      }
    });
    const own = await workflow.createRequest(publisher, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: (await f.propose()).payload
    });
    expect(own.requesterDecides).toBe(true);

    // Another holder of skill.publish neither finds nor decides it.
    await expect(
      workflow.decideRequest(other, otherAccess, context, {
        requestId: own.id,
        decision: "approve"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const view = await workflow.getRequest(publisher, publisherAccess, context, own.id);
    expect(view.canDecide).toBe(true);
    expect(
      await workflow.decideRequest(publisher, publisherAccess, context, {
        requestId: own.id,
        decision: "approve"
      })
    ).toMatchObject({ status: "approved", decision: { decidedBy: publisher.id } });
    const live = await f.store.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name: "review"
    });
    expect(JSON.stringify(live?.config)).toContain("Verify facts.");
  });

  it("waits for an approver where the requester holds no skill.publish", async () => {
    const f = await fixture(undefined, "shared");
    const workflow = new ApprovalRequestWorkflow({
      clientInstanceId,
      store: f.store.approvals,
      handlers: new Map([[f.handler.kind, f.handler]]),
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: f.store.audit }),
      authorizer: { forActor: (actor) => Promise.resolve(accessOf(actor)) }
    });
    const request = await workflow.createRequest(requester, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: (await f.propose()).payload
    });
    expect(request.requesterDecides).toBeUndefined();
    const view = await workflow.getRequest(requester, accessOf(requester), context, request.id);
    expect(view.canDecide).toBe(false);
  });
});
