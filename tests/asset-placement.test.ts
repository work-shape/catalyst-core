import { describe, expect, it } from "vitest";
import { operationRunSchema } from "@work-shape/catalyst-api-contract";
import {
  asUserId,
  isAgentAvailableInWorkspace,
  type CentralPolicySetting,
  type CollaborationWorkspaceId,
  type UserRecord
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import {
  agent,
  clientInstanceId,
  setupAccessInstance as setup,
  type AccessInstance
} from "./support/access-instance";
import { getTestJobs, getTestOperationCalls } from "./support/test-instance";

// The default of a kind and the workspaces an asset is offered in: `assets.set_default` and
// `assets.set_availability`. That the next run reads a changed availability is held in
// tests/chat-server-agent-runs.test.ts.
describe("the default and the availability of an asset", () => {
  it("refuses a Namespace builder without the right on the whole instance, and a deny on the asset", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    for (const action of ["agent.read", "agent.write", "agent.delete", "skill.read"]) {
      await t.seedHistoricalGrant(t.kai.id, action, { namespace: "kai-" });
    }
    expect((await t.putAgent(t.kai.id, "kai-helper")).statusCode).toBe(200);
    // The write right on the one asset is no more the instance's than the one in the Namespace.
    await t.grant(t.kai.id, "agent.write", { assetId: await t.assetId("agent", "kai-helper") });
    const state = () => t.stores.configAssets.getConfigAssetState({ clientInstanceId });
    const availability = async () =>
      (await t.stores.configAssets.listAgentAvailability({ clientInstanceId })).get("kai-helper");
    const before = { state: await state(), availability: await availability() };
    const setDefault = { params: { kind: "agent" }, payload: { name: "kai-helper" } };
    const setAvailability = {
      params: { kind: "agent", name: "kai-helper" },
      payload: { mode: "selected" }
    };

    // Both are refused for the right on the whole instance, on the builder's own agent, and
    // change nothing. Each fails without the check of the operation: the descriptor names no
    // right, so a registration without one would let the Namespace's write right through.
    await t.expectRefused(
      t.kai.id,
      "assets.set_default",
      setDefault,
      t.forbidden("agent.write", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "assets.set_default",
      { params: { kind: "agent" }, payload: { name: null } },
      t.forbidden("agent.write", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "assets.set_availability",
      setAvailability,
      t.forbidden("agent.write", "no_grant")
    );
    expect({ state: await state(), availability: await availability() }).toEqual(before);
    // The builder's agent started hidden. The default is offered everywhere, so it is made so.
    await t.expectOk(t.admin.id, "assets.set_availability", {
      ...setAvailability,
      payload: { mode: "all" }
    });
    await t.expectOk(t.admin.id, "assets.set_default", setDefault);
    expect((await state()).defaultAgentName).toBe("kai-helper");

    // A deny on the one asset refuses the holder of the instance's right on it.
    expect((await t.putAgent(t.admin.id, "kai-other")).statusCode).toBe(200);
    await t.grant(
      t.admin.id,
      "agent.write",
      { assetId: await t.assetId("agent", "kai-other") },
      "deny"
    );
    await t.expectRefused(
      t.admin.id,
      "assets.set_default",
      { params: { kind: "agent" }, payload: { name: "kai-other" } },
      t.forbidden("agent.write", "denied")
    );
    await t.expectRefused(
      t.admin.id,
      "assets.set_availability",
      { params: { kind: "agent", name: "kai-other" }, payload: { mode: "selected" } },
      t.forbidden("agent.write", "denied")
    );
    expect((await state()).defaultAgentName).toBe("kai-helper");
  });

  it("leaves an Operation Run for a change of the default agent and of an availability", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "assistant")).statusCode).toBe(200);
    expect((await t.putAgent(t.admin.id, "helper")).statusCode).toBe(200);
    const workspaceId = await t.sharedWorkspace("Team");
    const runs = () => t.stores.operationRuns.list({ clientInstanceId });
    const runOf = async (response: Awaited<ReturnType<typeof t.call>>) => {
      const id = response.headers["operation-run-id"];
      const run = (await runs()).find((candidate) => candidate.id === id);
      if (!run) throw new Error("The call left no run");
      return {
        operation: run.operation,
        actor: run.actor.id,
        effect: run.effect,
        status: run.status
      };
    };
    const count = async () => (await runs()).length;

    // Fails without the change: a plain route leaves no run and names none in its answer.
    let before = await count();
    const availability = await t.expectOk(t.admin.id, "assets.set_availability", {
      params: { kind: "agent", name: "helper" },
      payload: {
        mode: "selected",
        personalWorkspaces: true,
        collaborationWorkspaceIds: [workspaceId]
      }
    });
    expect(availability.json()).toEqual({
      mode: "selected",
      personalWorkspaces: true,
      collaborationWorkspaceIds: [workspaceId]
    });
    expect(await count()).toBe(before + 1);
    expect(await runOf(availability)).toEqual({
      operation: "assets.set_availability",
      actor: t.admin.id,
      effect: "changing",
      status: "done"
    });

    before = await count();
    const made = await t.expectOk(t.admin.id, "assets.set_default", {
      params: { kind: "agent" },
      payload: { name: "assistant" }
    });
    expect(await count()).toBe(before + 1);
    expect(await runOf(made)).toEqual({
      operation: "assets.set_default",
      actor: t.admin.id,
      effect: "changing",
      status: "done"
    });
    // The rows of both changes name the run that wrote them.
    const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 100 });
    for (const [type, response] of [
      ["config_asset.availability_set", availability],
      ["config_asset.default_agent_set", made]
    ] as const) {
      expect(events.find((event) => event.type === type)?.metadata?.operationRunId, type).toBe(
        response.headers["operation-run-id"]
      );
    }

    // A refused change is a run too, and the same call twice under one key is one change.
    before = await count();
    const hidden = await t.call(t.admin.id, "assets.set_availability", {
      params: { kind: "agent", name: "assistant" },
      payload: { mode: "selected" }
    });
    expect(hidden.statusCode).toBe(422);
    expect(await count()).toBe(before + 1);
    const keyed = {
      params: { kind: "agent" },
      payload: { name: "second" },
      headers: { "idempotency-key": "second-default-once" }
    };
    expect((await t.putAgent(t.admin.id, "second", {}, "all")).statusCode).toBe(200);
    const moved = await t.expectOk(t.admin.id, "assets.set_default", keyed);
    const repeated = await t.expectOk(t.admin.id, "assets.set_default", keyed);
    expect(repeated.headers["idempotent-replayed"]).toBe("true");
    expect(repeated.json()).toEqual(moved.json());
    const state = () => t.stores.configAssets.getConfigAssetState({ clientInstanceId });
    expect(await state()).toEqual({ ...moved.json(), defaultAgentName: "second" });
    // An instance with agents keeps a default: clearing it is refused by the set's own rule.
    const cleared = await t.call(t.admin.id, "assets.set_default", {
      params: { kind: "agent" },
      payload: { name: null }
    });
    expect(cleared.statusCode).toBe(422);
    expect((await state()).defaultAgentName).toBe("second");

    // Only a kind that keeps a default or is offered per workspace takes either call.
    expect(
      (
        await t.call(t.admin.id, "assets.set_default", {
          params: { kind: "skill" },
          payload: { name: "anything" }
        })
      ).statusCode
    ).toBe(422);
    expect(
      (
        await t.call(t.admin.id, "assets.set_availability", {
          params: { kind: "skill", name: "anything" },
          payload: { mode: "all" }
        })
      ).statusCode
    ).toBe(422);
  });

  // A call names what it was decided against, as `assets.put` names a revision. Each fails
  // without the comparison: the change was written whatever was stored by then.
  it("refuses a change that was made against another availability or another asset", async () => {
    const t = await setup();
    expect((await t.putAgent(t.admin.id, "assistant")).statusCode).toBe(200);
    expect((await t.putAgent(t.admin.id, "helper", {}, "all")).statusCode).toBe(200);
    const assetId = await t.assetId("agent", "helper");
    const everywhere = { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] };
    const personal = { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] };
    const stored = async () =>
      (await t.stores.configAssets.listAgentAvailability({ clientInstanceId })).get("helper");
    const set = (payload: Record<string, unknown>) =>
      t.call(t.admin.id, "assets.set_availability", {
        params: { kind: "agent", name: "helper" },
        payload
      });
    const conflict = (reason: string) => ({
      error: { code: "CONFLICT", details: { kind: "agent", name: "helper", reason } }
    });

    // Made against what is stored: applied.
    const applied = await set({
      ...personal,
      expectedAssetId: assetId,
      expectedAvailability: everywhere
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(await stored()).toEqual(personal);
    // Made against what was stored before, against none, or for another asset: nothing lands.
    for (const [payload, reason] of [
      [{ mode: "all", expectedAvailability: everywhere }, "availability_changed"],
      [{ mode: "all", expectedAvailability: null }, "availability_changed"],
      [{ mode: "all", expectedAssetId: "cfga_another" }, "asset_replaced"]
    ] as const) {
      const refused = await set(payload);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject(conflict(reason));
      expect(await stored()).toEqual(personal);
    }
    // Without the fields the call replaces what is stored, as a script's call does.
    expect((await set({ mode: "all" })).statusCode).toBe(200);
    expect(await stored()).toEqual(everywhere);

    const setDefault = (expectedAssetId: string) =>
      t.call(t.admin.id, "assets.set_default", {
        params: { kind: "agent" },
        payload: { name: "helper", expectedAssetId }
      });
    const state = () => t.stores.configAssets.getConfigAssetState({ clientInstanceId });
    const before = (await state()).defaultAgentName;
    const other = await setDefault("cfga_another");
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject(conflict("asset_replaced"));
    expect((await state()).defaultAgentName).toBe(before);
    expect((await setDefault(assetId)).statusCode).toBe(200);
    expect((await state()).defaultAgentName).toBe("helper");
  });

  it("keeps the newer availability when a held change is approved after it, and applies one nothing overtook", async () => {
    let settings: CentralPolicySetting[] = [];
    const t = await setup({ operations: { centralPolicySettings: () => settings } });
    expect((await t.putAgent(t.admin.id, "assistant")).statusCode).toBe(200);
    expect((await t.putAgent(t.admin.id, "helper", {}, "all")).statusCode).toBe(200);
    const assetId = await t.assetId("agent", "helper");
    const workspaceId = await t.sharedWorkspace("Team");
    const everywhere = { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] };
    const personal = { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] };
    const team = {
      mode: "selected",
      personalWorkspaces: false,
      collaborationWorkspaceIds: [workspaceId]
    };
    const stored = async () =>
      (await t.stores.configAssets.listAgentAvailability({ clientInstanceId })).get("helper");
    /** Files the change as the interface sends it, and answers the id of its request. */
    const hold = async (next: Record<string, unknown>, loaded: Record<string, unknown>) => {
      settings = [{ operation: "assets.set_availability", value: "approval" }];
      const held = await t.call(t.admin.id, "assets.set_availability", {
        params: { kind: "agent", name: "helper" },
        payload: { ...next, expectedAssetId: assetId, expectedAvailability: loaded }
      });
      settings = [];
      expect(held.statusCode, held.body).toBe(202);
      const { approvalRequestId = "" } = operationRunSchema.parse(held.json());
      expect(approvalRequestId).not.toBe("");
      return approvalRequestId;
    };
    const approve = async (requestId: string) => {
      const decided = await t.call(t.root.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      });
      expect(decided.statusCode, decided.body).toBe(200);
      await getTestJobs(t.instance).runDue();
      return t.stores.approvals.getApprovalRequest({ clientInstanceId, requestId });
    };

    // Somebody chooses another availability while the call waits. The held call runs, is
    // refused by the operation's own rule, and the later choice stays.
    const overtaken = await hold(personal, everywhere);
    expect(await stored()).toEqual(everywhere);
    await t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: "helper",
      availability: { ...team, mode: "selected", collaborationWorkspaceIds: [workspaceId] }
    });
    expect(await approve(overtaken)).toMatchObject({
      status: "approved",
      applyResult: { execution: "failed", error: { code: "CONFLICT" } }
    });
    expect(await stored()).toEqual(team);

    // Nothing changes while the next one waits: the approved call applies.
    const untouched = await hold(personal, team);
    expect(await stored()).toEqual(team);
    expect(await approve(untouched)).toMatchObject({
      status: "approved",
      applyResult: { execution: "done" }
    });
    expect(await stored()).toEqual(personal);
  });

  // Fails without the change: every new agent started available in every workspace.
  it("starts a new agent in the shared workspace it is made in, and hidden where it is made in none", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    for (const action of ["agent.read", "agent.write"]) {
      await t.seedHistoricalGrant(t.kai.id, action, { namespace: "kai-" });
    }
    const team = await t.sharedWorkspace("Team");
    const other = await t.sharedWorkspace("Other");
    for (const workspace of [team, other]) await join(t, t.kai, workspace);
    const create = (userId: string, name: string, availableIn?: unknown) =>
      t.call(userId, "assets.put", {
        params: { kind: "agent", name },
        payload: { config: agent(name), ...(availableIn ? { availableIn } : {}) }
      });

    // Made in Team, the agent is listed in Team and in no other workspace.
    const made = await create(t.kai.id, "kai-team", { workspaceId: team });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json()).toMatchObject({ warnings: [] });
    expect(await offeredIn(t, "kai-team", team)).toBe(true);
    expect(await offeredIn(t, "kai-team", other)).toBe(false);
    expect(await availabilityOf(t, "kai-team")).toEqual({
      mode: "selected",
      personalWorkspaces: false,
      collaborationWorkspaceIds: [team]
    });

    // A call made in a workspace without naming it, as an agent's call in a conversation is.
    const calls = await getTestOperationCalls(t.instance);
    const inTeam = await runOperation(
      {
        operation: "assets.put",
        effect: "changing",
        input: {
          kind: "agent",
          name: "kai-chat",
          config: agent("kai-chat"),
          expectedRevision: null
        },
        actor: identityOf(t.kai),
        origin: { kind: "user" },
        workspaceId: team,
        correlationId: "corr_made_in_team"
      },
      calls.deps
    );
    expect(inTeam.result).toMatchObject({ status: "done" });
    expect(await offeredIn(t, "kai-chat", team)).toBe(true);
    expect(await offeredIn(t, "kai-chat", other)).toBe(false);

    // Made in no workspace, it is hidden everywhere and the answer says so.
    const nowhere = await create(t.kai.id, "kai-nowhere");
    expect(nowhere.statusCode, nowhere.body).toBe(200);
    expect(nowhere.json()).toMatchObject({
      warnings: [
        {
          code: "agent_hidden",
          message: "Agent 'kai-nowhere' is hidden until an instance admin makes it available"
        }
      ]
    });
    expect(await availabilityOf(t, "kai-nowhere")).toEqual({
      mode: "selected",
      personalWorkspaces: false,
      collaborationWorkspaceIds: []
    });

    // Every workspace is the instance admin's choice, and a workspace the caller is not in
    // is no place to start.
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-wide" },
        payload: { config: agent("kai-wide"), availableIn: "all" }
      },
      t.forbidden("agent.write", "no_grant")
    );
    const closed = await t.sharedWorkspace("Closed");
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-closed" },
        payload: { config: agent("kai-closed"), availableIn: { workspaceId: closed } }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(await availabilityOf(t, "kai-wide")).toBeUndefined();
    expect(await availabilityOf(t, "kai-closed")).toBeUndefined();
    const wide = await create(t.admin.id, "kai-wide", "all");
    expect(wide.statusCode, wide.body).toBe(200);
    expect(await availabilityOf(t, "kai-wide")).toMatchObject({ mode: "all" });

    // An agent that exists keeps its availability: a write of it names none.
    await t.expectRefused(
      t.admin.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-team" },
        payload: { config: agent("kai-team"), availableIn: "all" }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
  });
});

/** Whether the workspace offers the agent, by the rule every list and run start asks. */
async function offeredIn(t: AccessInstance, name: string, workspaceId: CollaborationWorkspaceId) {
  const workspace = await t.stores.workspaces.getWorkspace(clientInstanceId, workspaceId);
  if (!workspace) throw new Error(`No workspace '${workspaceId}'`);
  return isAgentAvailableInWorkspace(await availabilityOf(t, name), workspace);
}

async function availabilityOf(t: AccessInstance, name: string) {
  return (await t.stores.configAssets.listAgentAvailability({ clientInstanceId })).get(name);
}

async function join(t: AccessInstance, user: UserRecord, workspaceId: CollaborationWorkspaceId) {
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: workspaceId,
    userId: asUserId(user.id),
    role: "member"
  });
}

function identityOf(user: UserRecord) {
  return {
    id: user.id,
    externalUserId: user.id,
    displayLabel: user.displayLabel,
    roles: user.roles,
    permissions: user.permissions,
    permissionRefs: user.permissionRefs,
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  };
}
