import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { collaborationWorkspaceAgentsSchema } from "@work-shape/catalyst-api-contract";
import { asUserId, type AgentAvailability } from "@work-shape/catalyst-core";
import {
  SCOPES_HEADER,
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";

// The Agents row of the sidebar (NAV-VIS-1): the workspace's list of agents names it for whoever
// has two agents or more available in that workspace, or may write an agent. With one agent
// New chat starts it, and the row is not named; the picker reads the same list either way.

const ALL_WORKSPACES: AgentAvailability = {
  mode: "all",
  personalWorkspaces: true,
  collaborationWorkspaceIds: []
};

describe("the Agents row the workspace's list of agents names", () => {
  let open: AccessInstance | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  async function ready(): Promise<AccessInstance> {
    open = await setupAccessInstance({ storedAssetSource: true });
    // The instance's one agent, `assistant`, is offered in every workspace.
    await open.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: "assistant",
      availability: ALL_WORKSPACES
    });
    return open;
  }

  /** The caller's Personal Workspace. */
  async function personalOf(t: AccessInstance, userId: string): Promise<string> {
    const response = await t.expectOk(userId, "workspaces.ensure_personal");
    return z.object({ id: z.string() }).parse(response.json()).id;
  }

  async function listOf(t: AccessInstance, userId: string, query: Record<string, string> = {}) {
    const response = await t.expectOk(userId, "workspaces.agents.list", {
      params: { collaborationWorkspaceId: await personalOf(t, userId) },
      query
    });
    return collaborationWorkspaceAgentsSchema.parse(response.json());
  }

  it("names no row to a member with one agent, and the row once a second is available", async () => {
    const t = await ready();
    const one = await listOf(t, t.kai.id);
    expect(one.items.map((agent) => agent.name)).toEqual(["assistant"]);
    // New chat starts the one agent: it is the workspace's default.
    expect(one.defaultAgentName).toBe("assistant");
    expect(one.visibleSections).toEqual([]);

    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "researcher" },
      payload: {
        config: {
          name: "researcher",
          displayName: "researcher",
          instructions: "Help.",
          modelProviderId: "local",
          toolNames: [],
          skillNames: [],
          initialPrompts: []
        },
        expectedRevision: null
      }
    });
    await t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: "researcher",
      availability: ALL_WORKSPACES
    });

    const two = await listOf(t, t.kai.id);
    expect(two.items.map((agent) => agent.name).sort()).toEqual(["assistant", "researcher"]);
    expect(two.visibleSections).toEqual(["agents"]);
    // The row counts every agent of the workspace, not the page that was asked for.
    expect(await listOf(t, t.kai.id, { limit: "1" })).toMatchObject({
      items: [expect.anything()],
      visibleSections: ["agents"]
    });
  });

  it("names the row with one agent to whoever may write an agent, on the instance or in the workspace", async () => {
    const t = await ready();
    const team = await t.sharedWorkspace("Team");
    for (const user of [t.kai, t.lena]) {
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: asUserId(user.id),
        role: "member"
      });
    }
    await t.grant(t.kai.id, "agent.write", { workspaceId: team });
    const sectionsInTeam = async (userId: string) =>
      collaborationWorkspaceAgentsSchema.parse(
        (
          await t.expectOk(userId, "workspaces.agents.list", {
            params: { collaborationWorkspaceId: team }
          })
        ).json()
      ).visibleSections;

    expect((await listOf(t, t.admin.id)).visibleSections).toEqual(["agents"]);
    expect(await sectionsInTeam(t.kai.id)).toEqual(["agents"]);
    expect(await sectionsInTeam(t.lena.id)).toEqual([]);
    // The right in Team is none in Kai's own workspace.
    expect((await listOf(t, t.kai.id)).visibleSections).toEqual([]);
    expect((await listOf(t, t.lena.id)).visibleSections).toEqual([]);
  });

  it("names the row to the holder of agent.write on one agent", async () => {
    const t = await ready();
    await t.grant(t.lena.id, "agent.write", { assetId: await t.assetId("agent", "assistant") });

    expect((await listOf(t, t.lena.id)).visibleSections).toEqual(["agents"]);
  });

  it("names no row with one agent where the credential cannot write, whatever the role holds", async () => {
    const t = await ready();
    const response = await t.expectOk(t.admin.id, "workspaces.agents.list", {
      params: { collaborationWorkspaceId: await personalOf(t, t.admin.id) },
      headers: { [SCOPES_HEADER]: "config:read collaboration_workspace:read" }
    });
    expect(collaborationWorkspaceAgentsSchema.parse(response.json()).visibleSections).toEqual([]);
  });
});
