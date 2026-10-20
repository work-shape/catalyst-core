import { describe, expect, it } from "vitest";
import { operationRunSchema } from "@work-shape/catalyst-api-contract";
import type { CentralPolicySetting, PlatformEventEmitter } from "@work-shape/catalyst-core";
import { agent, clientInstanceId, errorSchema, skill } from "./support/access-instance";
import { setupWorkspaceHolder, type WorkspaceHolderInstance } from "./support/asset-operations";
import { getTestJobs } from "./support/test-instance";

// What the policy is asked about for an asset call, and that it is asked only once the caller's
// right on every asset the call names is decided.

/**
 * An instance with these admin settings, and the names of the events its calls emitted. Lena
 * holds the rights of an author in her workspace.
 */
async function setup(settings: CentralPolicySetting[]) {
  const emitted: string[] = [];
  const events: PlatformEventEmitter = {
    emit: (name) => {
      emitted.push(name);
      return Promise.resolve({ outcome: "allow", guardrails: [] });
    }
  };
  const approvalRequests: string[] = [];
  const t = await setupWorkspaceHolder({
    operations: {
      centralPolicySettings: () => settings,
      events,
      approvals: {
        request: ({ run }) => {
          approvalRequests.push(run.id);
          return Promise.resolve({ approvalRequestId: `apr_${approvalRequests.length}` });
        }
      }
    }
  });
  for (const action of ["agent.read", "agent.write", "skill.read", "skill.write"]) {
    await t.grant(t.lena.id, action, { workspaceId: t.lenaTeam });
  }
  return { t, emitted, approvalRequests };
}

const putItem = (kind: "agent" | "skill", name: string) => ({
  type: "put",
  kind,
  config: kind === "agent" ? agent(name) : skill(name)
});

async function sync(
  t: WorkspaceHolderInstance,
  userId: string,
  workspaceId: string,
  items: unknown[]
) {
  const response = await t.call(userId, "assets.sync", { payload: { workspaceId, items } });
  return {
    status: response.statusCode,
    ...(response.statusCode === 200 ? {} : { code: errorSchema.parse(response.json()).error.code })
  };
}

const policyDenied = { status: 403, code: "POLICY_DENIED" };

describe("the policy of assets.sync", () => {
  it("is not asked for a batch with an item its caller may not make", async () => {
    const { t, emitted } = await setup([{ operation: "assets.sync", value: "deny" }]);

    // The batch is Kai's to make, so the policy is what refuses it.
    expect(await sync(t, t.kai.id, t.kaiTeam, [putItem("agent", "kai-intake")])).toEqual(
      policyDenied
    );
    // Lena holds nothing in Kai's workspace: she is told so, item by item, and never what the
    // policy says.
    emitted.length = 0;
    const refused = await t.call(t.lena.id, "assets.sync", {
      payload: {
        workspaceId: t.kaiTeam,
        items: [putItem("agent", "kai-intake"), putItem("skill", "kai-guide")]
      }
    });
    expect(refused.statusCode).toBe(403);
    const { error } = errorSchema.parse(refused.json());
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toMatchObject({
      reason: "sync_refused",
      items: [
        { index: 0, status: "refused", error: { code: "FORBIDDEN", action: "agent.write" } },
        { index: 1, status: "refused", error: { code: "FORBIDDEN", action: "skill.write" } }
      ]
    });
    // No guardrail was asked about the batch either.
    expect(emitted).not.toContain("operation.before_call");
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
  });

  it("applies a setting narrowed to a kind when one item of the batch is of that kind", async () => {
    const { t } = await setup([{ operation: "assets.sync", value: "deny", assetKind: "skill" }]);

    expect(
      await sync(t, t.kai.id, t.kaiTeam, [
        putItem("agent", "kai-intake"),
        putItem("skill", "kai-guide")
      ])
    ).toEqual(policyDenied);
    // Nothing of the batch was written.
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    expect(await sync(t, t.kai.id, t.kaiTeam, [putItem("agent", "kai-intake")])).toEqual({
      status: 200
    });
    // A delete is a target of its kind as a put is.
    await t.put(t.admin.id, "skill", "kai-old", t.kaiTeam);
    expect(
      await sync(t, t.admin.id, t.kaiTeam, [
        { type: "delete", kind: "skill", name: "kai-old", expectedRevision: 1 }
      ])
    ).toEqual(policyDenied);
    expect(await t.stored("skill", "kai-old")).toMatchObject({ status: "active" });
  });

  it("applies a setting narrowed to a workspace to the batches of that workspace alone", async () => {
    const settings: CentralPolicySetting[] = [];
    const { t } = await setup(settings);
    settings.push({ operation: "assets.*", value: "deny", workspaceId: t.kaiTeam });

    expect(await sync(t, t.kai.id, t.kaiTeam, [putItem("agent", "kai-intake")])).toEqual(
      policyDenied
    );
    expect(await sync(t, t.lena.id, t.lenaTeam, [putItem("agent", "lena-intake")])).toEqual({
      status: 200
    });
  });
});

describe("the further rights of assets.sync", () => {
  it("refuses a change of a model setting without its right before the policy is asked", async () => {
    const settings: CentralPolicySetting[] = [];
    const { t, emitted, approvalRequests } = await setup(settings);
    await t.put(t.admin.id, "agent", "kai-intake", t.kaiTeam);
    // From here on every batch waits for an approval.
    settings.push({ operation: "assets.sync", value: "approval" });
    const batch = (overrides: Record<string, unknown>) =>
      t.call(t.kai.id, "assets.sync", {
        payload: {
          workspaceId: t.kaiTeam,
          items: [
            {
              type: "put",
              kind: "agent",
              config: agent("kai-intake", overrides),
              expectedRevision: 1
            }
          ]
        }
      });

    // Kai may write the agent, so a change of its instructions reaches the policy and waits.
    expect((await batch({ instructions: "Help well." })).statusCode).toBe(202);
    expect(approvalRequests).toHaveLength(1);
    // Its model is not his to choose: he is told so, and nothing was asked about the batch.
    emitted.length = 0;
    const refused = await batch({ modelProviderId: undefined, modelBindingId: "plain" });
    expect(refused.statusCode).toBe(403);
    const { error } = errorSchema.parse(refused.json());
    expect(error.code).toBe("FORBIDDEN");
    expect(error.details).toMatchObject({
      reason: "sync_refused",
      items: [
        { index: 0, status: "refused", error: { code: "FORBIDDEN", action: "agent_models.manage" } }
      ]
    });
    expect(emitted).not.toContain("operation.before_call");
    expect(approvalRequests).toHaveLength(1);
    expect(await t.stored("agent", "kai-intake")).toMatchObject({ revision: 1 });
  });
});

describe("the policy of a call on one asset", () => {
  it("applies a setting narrowed to the workspace that owns the asset the call names", async () => {
    const settings: CentralPolicySetting[] = [];
    const { t } = await setup(settings);
    settings.push({ operation: "assets.*", value: "deny", workspaceId: t.kaiTeam });
    const inKai = { workspaceId: t.kaiTeam };
    const address = (name: string) => ({ params: { kind: "agent", name } });
    const read = (name: string, workspaceId: string) => ({
      ...address(name),
      query: { workspaceId }
    });
    const put = (userId: string, name: string, workspaceId?: string) =>
      t.call(userId, "assets.put", {
        ...address(name),
        payload: { config: agent(name), ...(workspaceId === undefined ? {} : { workspaceId }) }
      });
    const denied = { status: 403, code: "POLICY_DENIED" };

    expect((await put(t.lena.id, "lena-intake", t.lenaTeam)).statusCode).toBe(200);
    expect((await put(t.admin.id, "plain")).statusCode).toBe(200);
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      { ...address("kai-intake"), payload: { config: agent("kai-intake"), ...inKai } },
      denied
    );
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    // Every operation that names one asset hands its owner over, the reading ones too.
    await t.expectRefused(t.kai.id, "assets.get", read("kai-intake", t.kaiTeam), denied);
    await t.expectRefused(t.kai.id, "assets.revisions.list", read("kai-intake", t.kaiTeam), denied);
    await t.expectRefused(
      t.kai.id,
      "assets.validate",
      { params: { kind: "agent" }, payload: { config: agent("kai-intake"), ...inKai } },
      denied
    );
    await t.expectRefused(
      t.kai.id,
      "assets.delete",
      { ...address("kai-intake"), payload: { expectedRevision: 1, ...inKai } },
      denied
    );
    await t.expectRefused(
      t.kai.id,
      "assets.revert",
      { ...address("kai-intake"), payload: { revision: 1, expectedRevision: 1, ...inKai } },
      denied
    );
    await t.expectOk(t.lena.id, "assets.get", read("lena-intake", t.lenaTeam));
    // The right is still asked first: a caller without it is not told what the policy says.
    await t.expectRefused(
      t.lena.id,
      "assets.get",
      read("kai-intake", t.kaiTeam),
      t.forbidden("agent.read", "no_grant")
    );
  });
});

describe("an asset write that waits for another person", () => {
  // The approval path is the same for every operation: an asset operation declares nothing
  // for it. Fails without the approval path: the write was refused with 403 POLICY_DENIED and
  // nothing could run it later.
  it("is held with 202, written once when it is approved, and not a second time", async () => {
    const t = await setupWorkspaceHolder({
      operations: { centralPolicySettings: () => [{ operation: "assets.put", value: "approval" }] }
    });
    const held = await t.call(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "kai-intake" },
      payload: { config: agent("kai-intake"), workspaceId: t.kaiTeam }
    });
    expect(held.statusCode).toBe(202);
    const { approvalRequestId: requestId = "" } = operationRunSchema.parse(held.json());
    expect(requestId).not.toBe("");
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();

    const decide = () =>
      t.call(t.admin.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      });
    expect((await decide()).statusCode).toBe(200);
    // The approval is recorded; the job that executes the call writes the asset.
    expect(await t.stored("agent", "kai-intake")).toBeUndefined();
    await getTestJobs(t.instance).runDue();
    // Written as Kai asked, by the call that waited.
    expect(await t.stored("agent", "kai-intake")).toMatchObject({ revision: 1, status: "active" });
    expect((await decide()).statusCode).toBe(409);
    await getTestJobs(t.instance).runDue();
    expect(await t.stored("agent", "kai-intake")).toMatchObject({ revision: 1 });
  });

  // An asset write names the revision it was made against. A write whose target changed while
  // it waited is not superseded: it is approved, runs, and fails by the operation's own rule.
  // The request says so. Fails without the outcome on the request: it read `approved` alone.
  it("ends as approved and failed, and overwrites nothing, when the asset changed while it waited", async () => {
    let settings: CentralPolicySetting[] = [];
    const t = await setupWorkspaceHolder({
      operations: { centralPolicySettings: () => settings }
    });
    await t.put(t.kai.id, "agent", "kai-intake", t.kaiTeam);
    settings = [{ operation: "assets.put", value: "approval" }];
    const held = await t.call(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "kai-intake" },
      payload: {
        config: agent("kai-intake", { instructions: "Held." }),
        expectedRevision: 1,
        workspaceId: t.kaiTeam
      }
    });
    expect(held.statusCode).toBe(202);
    const { approvalRequestId: requestId = "" } = operationRunSchema.parse(held.json());
    // Somebody else changes the asset while the write waits.
    settings = [];
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "kai-intake" },
      payload: {
        config: agent("kai-intake", { instructions: "Newer." }),
        expectedRevision: 1,
        workspaceId: t.kaiTeam
      }
    });

    const approved = await t.call(t.admin.id, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    expect(approved.statusCode).toBe(200);
    await getTestJobs(t.instance).runDue();

    const request = await t.stores.approvals.getApprovalRequest({
      clientInstanceId,
      requestId
    });
    expect(request).toMatchObject({
      status: "approved",
      applyResult: { execution: "failed", error: { code: "REVISION_CONFLICT" } }
    });
    expect(await t.stored("agent", "kai-intake")).toMatchObject({ revision: 1 });
    const pending = (
      await t.expectOk(t.admin.id, "agents.draft.get", {
        params: { name: "kai-intake" },
        query: { workspaceId: t.kaiTeam }
      })
    ).json();
    expect(pending).toMatchObject({ draft: { revision: 1, config: { instructions: "Newer." } } });
  });
});
