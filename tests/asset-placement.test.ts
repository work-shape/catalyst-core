import { describe, expect, it } from "vitest";
import { clientInstanceId, setupAccessInstance as setup } from "./support/access-instance";

// The default of a kind and the workspaces an asset is offered in: `assets.set_default` and
// `assets.set_availability`. That the next run reads a changed availability is held in
// tests/chat-server-agent-runs.test.ts.
describe("the default and the availability of an asset", () => {
  it("refuses a Namespace builder without the right on the whole instance, and a deny on the asset", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    for (const action of ["agent.read", "agent.write", "agent.delete", "skill.read"]) {
      await t.grant(t.kai.id, action, { namespace: "kai-" });
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
    expect((await t.putAgent(t.admin.id, "second")).statusCode).toBe(200);
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
});
