import { describe, expect, it } from "vitest";
import {
  StoreBackedAuditRecorder,
  asUserId,
  type AuthenticatedUser,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { ApprovalRequestWorkflow } from "@work-shape/catalyst-server";
import { accessOf } from "./support/access";
import {
  clientInstanceId,
  context,
  creation,
  fixture,
  requester,
  reviewer
} from "./support/skill-change-fixture";

// `skill.approve` on the skill a `skill_change` request changes decides it: on that skill, on
// what its workspace owns, or on the instance. `operations.approve` is not asked for it. A new
// skill is decided where it will be owned. Holders of `agent_skills.approve` decide every
// request as before (skill-change-workflow.test.ts).

const editor: AuthenticatedUser = { ...requester, id: "editor", displayLabel: "Editor" };

/** Editor's access with one allow of `skill.approve` at the scope. */
function editorWith(scope: Pick<PermissionGrant, "scopeKind" | "scopeId">) {
  return accessOf(editor, {
    grants: [
      {
        id: "grant_editor",
        clientInstanceId,
        holderKind: "user",
        holderId: editor.id,
        action: "skill.approve",
        effect: "allow",
        ...scope,
        grantedBy: asUserId("admin"),
        createdAt: "2026-11-01T00:00:00.000Z"
      }
    ]
  });
}

async function skillAssetId(f: Awaited<ReturnType<typeof fixture>>, name = "review") {
  const stored = await f.store.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "skill",
    name
  });
  if (!stored) throw new Error(`Skill ${name} missing`);
  return stored.id;
}

function workspaceOf(f: Awaited<ReturnType<typeof fixture>>): string {
  if (f.owner.kind !== "workspace") throw new Error("Expected a workspace owner");
  return f.owner.workspaceId;
}

describe("skill.approve on the skill a request changes", () => {
  it("files the request naming the skill, and lets its holder list and decide it", async () => {
    const f = await fixture();
    const assetId = await skillAssetId(f);
    const request = await f.propose();
    expect(request.payload.subject).toEqual({
      skillAssetId: assetId,
      workspaceId: workspaceOf(f)
    });
    const access = editorWith({ scopeKind: "asset", scopeId: assetId });
    expect(
      (await f.workflow.listRequests(editor, access, context)).map((item) => [
        item.id,
        item.canDecide
      ])
    ).toEqual([[request.id, true]]);
    const decided = await f.workflow.decideRequest(editor, access, context, {
      requestId: request.id,
      decision: "approve"
    });
    expect(decided).toMatchObject({ status: "approved", decision: { decidedBy: editor.id } });
  });

  it.each(["workspace", "instance"] as const)(
    "is decided by a holder of the right on the %s, without operations.approve",
    async (scopeKind) => {
      const f = await fixture();
      const request = await f.propose();
      const access = editorWith(
        scopeKind === "workspace" ? { scopeKind, scopeId: workspaceOf(f) } : { scopeKind }
      );
      expect(access.authorize("operations.approve").allowed).toBe(false);
      expect(
        await f.workflow.decideRequest(editor, access, context, {
          requestId: request.id,
          decision: "approve"
        })
      ).toMatchObject({ status: "approved" });
    }
  );

  it("is neither listed to nor decided by a holder on another skill", async () => {
    const f = await fixture();
    const request = await f.propose();
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "skill:other": null },
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: "other",
          scope: f.owner,
          config: { name: "other", title: "Other", description: "Other", content: "Other." }
        }
      ]
    });
    const access = editorWith({ scopeKind: "asset", scopeId: await skillAssetId(f, "other") });
    expect(await f.workflow.listRequests(editor, access, context)).toEqual([]);
    await expect(
      f.workflow.decideRequest(editor, access, context, {
        requestId: request.id,
        decision: "approve"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the subject it read itself, whatever the filer said", async () => {
    const f = await fixture();
    const assetId = await skillAssetId(f);
    const request = await f.workflow.createRequest(requester, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: {
        ...(await f.propose()).payload,
        subject: { skillAssetId: "forged", workspaceId: null }
      }
    });
    expect(request.payload.subject).toEqual({
      skillAssetId: assetId,
      workspaceId: workspaceOf(f)
    });
  });
});

describe("skill.approve on a request that creates a skill", () => {
  it("is decided where the new skill will be owned, never by a holder on another skill", async () => {
    const f = await fixture();
    const request = await f.propose(creation, "new_skill");
    expect(request.payload.subject).toEqual({ skillAssetId: null, workspaceId: workspaceOf(f) });
    const onSkill = editorWith({ scopeKind: "asset", scopeId: await skillAssetId(f) });
    expect(await f.workflow.listRequests(editor, onSkill, context)).toEqual([]);
    await expect(
      f.workflow.decideRequest(editor, onSkill, context, {
        requestId: request.id,
        decision: "approve"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const inWorkspace = editorWith({ scopeKind: "workspace", scopeId: workspaceOf(f) });
    expect(
      (await f.workflow.listRequests(editor, inWorkspace, context)).map((item) => item.id)
    ).toEqual([request.id]);
    expect(
      await f.workflow.decideRequest(editor, inWorkspace, context, {
        requestId: request.id,
        decision: "approve"
      })
    ).toMatchObject({ status: "approved" });
  });
});

describe("a skill change its requester may approve", () => {
  it("is in To decide for the requester alone, and another approver finds and decides it", async () => {
    const f = await fixture();
    const editorAccess = editorWith({ scopeKind: "asset", scopeId: await skillAssetId(f) });
    // The workflow reads each requester's rights as they are when they file.
    const workflow = new ApprovalRequestWorkflow({
      clientInstanceId,
      store: f.store.approvals,
      handlers: new Map([[f.handler.kind, f.handler]]),
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: f.store.audit }),
      authorizer: {
        forActor: (actor) =>
          Promise.resolve(actor.id === editor.id ? editorAccess : accessOf(actor))
      }
    });
    const theirs = await workflow.createRequest(requester, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: (await f.propose()).payload
    });
    const own = await workflow.createRequest(editor, context, {
      kind: "skill_change",
      summary: "Verify facts carefully.",
      payload: theirs.payload
    });
    expect(own.requesterDecides).toBe(true);
    expect(theirs.requesterDecides).toBeUndefined();

    const pending = async (user: AuthenticatedUser, access = accessOf(user)) =>
      (await workflow.listRequests(user, access, context, { status: "pending" })).map(
        (item) => item.id
      );
    expect(await pending(editor, editorAccess)).toContain(own.id);
    expect(await pending(reviewer)).not.toContain(own.id);
    expect(await pending(reviewer)).toContain(theirs.id);
    expect(await workflow.pendingCount(reviewer, accessOf(reviewer))).toMatchObject({
      othersOwn: 1
    });
    const others = await workflow.listRequests(reviewer, accessOf(reviewer), context, {
      scope: "others_own"
    });
    expect(others.map((item) => [item.id, item.canDecide])).toEqual([[own.id, true]]);
    expect(
      await workflow.decideRequest(reviewer, accessOf(reviewer), context, {
        requestId: own.id,
        decision: "reject"
      })
    ).toMatchObject({ status: "rejected" });
  });
});
