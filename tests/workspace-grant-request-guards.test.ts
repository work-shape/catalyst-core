import { describe, expect, it } from "vitest";
import { asUserId, type CollaborationWorkspaceId } from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { z } from "zod";

// The review of AP-3: approving a `grant_request` runs the same no-escalation rule as the
// direct grant, decides on the approver's rights as they are under the rights locks, and a
// member who leaves or is removed takes neither Builder nor Publisher along.

const requestSchema = z.object({ requestId: z.string() }).loose();

async function withMember(t: AccessInstance, workspace: CollaborationWorkspaceId, userId: string) {
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: workspace,
    userId: asUserId(userId),
    role: "member"
  });
}

const builderRows = (t: AccessInstance, userId: string, workspace: string) =>
  t.stores.access.listGrants({
    clientInstanceId,
    holderId: userId,
    action: "builder",
    scopeKind: "workspace",
    scopeId: workspace
  });

describe("approving a grant request", () => {
  it("is refused to an approver denied a right on an asset inside the workspace, as the direct grant is", async () => {
    const t = await setupAccessInstance();
    // The administrator owns the workspace and holds Builder by role.
    const team = await t.sharedWorkspace("Wide");
    await withMember(t, team, t.lena.id);
    expect(
      (
        await t.call(t.admin.id, "assets.put", {
          params: { kind: "agent", name: "secret" },
          payload: { config: agent("secret"), workspaceId: team }
        })
      ).statusCode
    ).toBe(200);
    await t.grant(
      t.admin.id,
      "agent.write",
      { assetId: await t.assetId("agent", "secret") },
      "deny"
    );
    const params = { collaborationWorkspaceId: team, userId: t.lena.id, bundle: "builder" };

    const direct = await t.call(t.admin.id, "workspaces.member_bundles.grant", { params });
    expect(direct.statusCode).toBe(403);

    const asked = await t.call(t.admin.id, "workspaces.member_bundles.request", {
      params,
      payload: {}
    });
    expect(asked.statusCode).toBe(200);
    const { requestId } = requestSchema.parse(asked.json());
    const approved = await t.call(t.admin.id, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    expect(approved.statusCode).toBe(403);
    expect(errorSchema.parse(approved.json()).error.details).toMatchObject({ reason: "denied" });
    expect(await builderRows(t, t.lena.id, team)).toEqual([]);
    // Nothing was decided: the request still waits.
    const request = await t.stores.approvals.getApprovalRequest({ clientInstanceId, requestId });
    expect(request?.status).toBe("pending");
  });

  it("reads the approver's rights anew under the locks, not as the call was admitted", async () => {
    const t = await setupAccessInstance();
    const team = await t.sharedWorkspace("Sales");
    await withMember(t, team, t.lena.id);
    const ina = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Ina",
      roles: ["admin"]
    });
    const asked = await t.call(t.admin.id, "workspaces.member_bundles.request", {
      params: { collaborationWorkspaceId: team, userId: t.lena.id, bundle: "builder" },
      payload: {}
    });
    const { requestId } = requestSchema.parse(asked.json());
    // Ina is admitted as an administrator. Her role is taken after the call checked it and
    // before the decision's transaction, as a change that commits meanwhile would.
    const approvals = t.stores.approvals;
    const transition = approvals.transitionPendingApprovalRequest.bind(approvals);
    let demote = true;
    approvals.transitionPendingApprovalRequest = async (input) => {
      if (demote)
        await t.stores.users.updateUser({ clientInstanceId, userId: ina.id, roles: ["user"] });
      return transition(input);
    };
    const decide = () =>
      t.call(ina.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      });

    const refused = await decide();
    expect(refused.statusCode).toBe(403);
    expect(await builderRows(t, t.lena.id, team)).toEqual([]);
    const request = await t.stores.approvals.getApprovalRequest({ clientInstanceId, requestId });
    expect(request?.status).toBe("pending");

    // With the role she holds, the same approver gives it.
    demote = false;
    await t.stores.users.updateUser({ clientInstanceId, userId: ina.id, roles: ["admin"] });
    expect((await decide()).json()).toMatchObject({ status: "approved" });
    expect(await builderRows(t, t.lena.id, team)).toHaveLength(1);
  });
});

describe("the end of a membership", () => {
  it("takes the member's Builder and Publisher along, when removed and when they leave", async () => {
    const t = await setupAccessInstance();
    const team = await t.sharedWorkspace("Sales");
    for (const ending of ["removed", "left"] as const) {
      await withMember(t, team, t.lena.id);
      await t.grant(t.lena.id, "builder", { workspaceId: team });
      await t.grant(t.lena.id, "publisher", { workspaceId: team });
      expect(await builderRows(t, t.lena.id, team)).toHaveLength(1);

      if (ending === "removed")
        await t.expectOk(t.admin.id, "workspaces.members.remove", {
          params: { collaborationWorkspaceId: team, userId: t.lena.id }
        });
      else
        await t.expectOk(t.lena.id, "workspaces.members.leave", {
          params: { collaborationWorkspaceId: team }
        });

      const rows = await t.stores.access.listGrants({
        clientInstanceId,
        holderId: t.lena.id,
        scopeKind: "workspace",
        scopeId: team
      });
      expect(rows, ending).toEqual([]);
    }
    const revoked = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "permission.revoked",
      limit: 50
    });
    expect(
      revoked
        .map((event) => event.metadata ?? {})
        .filter((metadata) => metadata.reason === "membership_ended")
        .map((metadata) => metadata.action)
        .sort()
    ).toEqual(["builder", "builder", "publisher", "publisher"]);
  });
});
