import { describe, expect, it } from "vitest";
import { asUserId, type CollaborationWorkspaceId } from "@work-shape/catalyst-core";
import { resolveDefaultAgentName } from "@work-shape/catalyst-server";
import { clientInstanceId, setupAccessInstance as setup } from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// A Shared Workspace may name its own default agent. New chats there start with it, and the
// instance default no longer has to be offered there; every workspace that names none keeps
// the instance default.

describe("which agent a new chat in a workspace starts with", () => {
  const agents: Parameters<typeof resolveDefaultAgentName>[0] = [
    { name: "fiona" },
    { name: "kai" },
    { name: "shipped", shipped: { packageName: "@example/agents", version: "1.0.0" } }
  ];

  it("is the workspace's own default where the caller is offered it", () => {
    expect(resolveDefaultAgentName(agents, { workspace: "kai", instance: "fiona" })).toBe("kai");
  });

  it("is the instance default where the workspace names none, or one the caller is not offered", () => {
    expect(resolveDefaultAgentName(agents, { instance: "fiona" })).toBe("fiona");
    expect(resolveDefaultAgentName(agents, { workspace: "gone", instance: "fiona" })).toBe("fiona");
  });

  it("falls back to the shipped agent only where the instance names no default", () => {
    expect(resolveDefaultAgentName(agents, {})).toBe("shipped");
    expect(resolveDefaultAgentName(agents, { instance: "gone" })).toBe("fiona");
    expect(resolveDefaultAgentName([], { workspace: "kai", instance: "fiona" })).toBeUndefined();
  });
});

describe("a Shared Workspace's own default agent", () => {
  it("is set by the workspace's admin, starts its new chats, and lets the instance default go", async () => {
    const t = await setup({ storedAssetSource: true });
    const team = await t.sharedWorkspace("Team");
    const outside = await t.sharedWorkspace("Outside");
    const join = (
      workspaceId: CollaborationWorkspaceId,
      userId: string,
      role: "admin" | "member"
    ) =>
      t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspaceId,
        userId: asUserId(userId),
        role
      });
    await join(outside, t.kai.id, "admin");
    await join(outside, t.lena.id, "member");
    await t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: "assistant",
      availability: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
    });
    expect(
      (await t.putAgent(t.admin.id, "outside-agent", {}, { workspaceId: outside })).statusCode
    ).toBe(200);
    const agentsIn = async (userId: string, workspaceId: CollaborationWorkspaceId) => {
      const body = (
        await t.expectOk(userId, "workspaces.agents.list", {
          params: { collaborationWorkspaceId: workspaceId }
        })
      ).json<{ defaultAgentName?: string; items: { name: string }[] }>();
      return { defaultAgentName: body.defaultAgentName, names: body.items.map(({ name }) => name) };
    };
    const setDefault = (workspaceId: string, name: string | null) => ({
      params: { kind: "agent" },
      payload: { name, workspaceId }
    });
    expect(await agentsIn(t.lena.id, outside)).toEqual({
      defaultAgentName: "assistant",
      names: ["assistant", "outside-agent"]
    });

    // A plain member may not set it; nor may the workspace's admin set another workspace's.
    await t.expectRefused(
      t.lena.id,
      "assets.set_default",
      setDefault(outside, "outside-agent"),
      t.forbidden("agent.write", "no_grant")
    );
    await t.expectRefused(
      t.kai.id,
      "assets.set_default",
      setDefault(team, "assistant"),
      t.forbidden("agent.write", "no_grant")
    );
    // Only an agent available in the workspace.
    const unavailable = await t.expectRefused(
      t.admin.id,
      "assets.set_default",
      setDefault(team, "outside-agent"),
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(unavailable.message).toContain("'Team'");

    await t.expectOk(t.kai.id, "assets.set_default", setDefault(outside, "outside-agent"));
    const outsideAgentId = await t.assetId("agent", "outside-agent");
    const events = await t.stores.audit.listAuditEvents({ clientInstanceId });
    const recorded = events.find(
      (event) => event.type === "config_asset.workspace_default_agent_set"
    );
    expect(recorded?.metadata).toEqual({
      workspaceId: outside,
      agentId: outsideAgentId,
      version: expect.any(Number),
      operationRunId: expect.any(String)
    });
    expect(await agentsIn(t.lena.id, outside)).toMatchObject({ defaultAgentName: "outside-agent" });
    expect(
      (
        await t.expectOk(t.lena.id, "workspaces.get", {
          params: { collaborationWorkspaceId: outside }
        })
      ).json()
    ).toMatchObject({ defaultAgentName: "outside-agent" });

    // The instance default can now leave the workspace that names its own, and only that one.
    const keepOnly = (collaborationWorkspaceIds: string[], personalWorkspaces = true) => ({
      params: { kind: "agent", name: "assistant" },
      payload: { mode: "selected", personalWorkspaces, collaborationWorkspaceIds }
    });
    const stillNeeded = await t.expectRefused(t.admin.id, "assets.set_availability", keepOnly([]), {
      status: 422,
      code: "VALIDATION_FAILED"
    });
    expect(stillNeeded.message).toContain("'Team'");
    expect(stillNeeded.message).not.toContain("'Outside'");
    const personal = await t.expectRefused(
      t.admin.id,
      "assets.set_availability",
      keepOnly([team], false),
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(personal.message).toContain("Personal Workspaces");
    await t.expectOk(t.admin.id, "assets.set_availability", keepOnly([team]));
    expect(await agentsIn(t.lena.id, outside)).toEqual({
      defaultAgentName: "outside-agent",
      names: ["outside-agent"]
    });
    expect(await agentsIn(t.admin.id, team)).toMatchObject({ defaultAgentName: "assistant" });

    // The workspace's default stays where it is the default: neither taken away nor deleted.
    const taken = await t.expectRefused(
      t.admin.id,
      "assets.set_availability",
      {
        params: { kind: "agent", name: "outside-agent" },
        payload: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [team] }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(taken.message).toContain("'Outside'");
    await expect(
      applyAtCurrentRevisions(t.stores.configAssets, {
        clientInstanceId,
        mutations: [{ type: "delete", kind: "agent", name: "outside-agent" }]
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // Following the instance default again needs it there first.
    await t.expectRefused(t.kai.id, "assets.set_default", setDefault(outside, null), {
      status: 422,
      code: "VALIDATION_FAILED"
    });

    // A workspace made later names no default, so the instance default is offered there.
    const later = await t.sharedWorkspace("Later");
    expect(
      (await t.stores.configAssets.listAgentAvailability({ clientInstanceId })).get("assistant")
        ?.collaborationWorkspaceIds
    ).toEqual([team, later].sort());

    // Once the instance default is offered there again, the workspace may follow it.
    await t.expectOk(t.admin.id, "assets.set_availability", keepOnly([team, later, outside]));
    await t.expectOk(t.kai.id, "assets.set_default", setDefault(outside, null));
    expect(await agentsIn(t.lena.id, outside)).toMatchObject({ defaultAgentName: "assistant" });
  });
});
