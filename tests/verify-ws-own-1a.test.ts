import { describe, expect, it } from "vitest";
import {
  asUserId,
  type CollaborationWorkspaceId,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  agent,
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  skill,
  storeTestServicePrincipal,
  type AccessInstance
} from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { releaseAsService } from "./support/asset-release";

// Verifier probes for WS-OWN-1a (PR 71). Each `it` is one probe; a failing one is a finding.

const AGENT_RIGHTS = ["agent.read", "agent.write", "agent.delete"];
const SKILL_RIGHTS = ["skill.read", "skill.write", "skill.delete"];

async function join(t: AccessInstance, user: UserRecord, workspaceId: CollaborationWorkspaceId) {
  await t.stores.workspaces.addMembership({
    clientInstanceId,
    collaborationWorkspaceId: workspaceId,
    userId: asUserId(user.id),
    role: "member"
  });
}

/** Kai builds in Team, Lena builds in Other; each holds every agent and skill right there. */
async function setup(storedAssetSource?: true) {
  const t = await setupAccessInstance({
    furtherToolNames: ["read_skill"],
    ...(storedAssetSource ? { storedAssetSource } : {})
  });
  const team = await t.sharedWorkspace("Team");
  const other = await t.sharedWorkspace("Other team");
  await join(t, t.kai, team);
  await join(t, t.lena, other);
  for (const action of [...AGENT_RIGHTS, ...SKILL_RIGHTS]) {
    await t.grant(t.kai.id, action, { workspaceId: team });
    await t.grant(t.lena.id, action, { workspaceId: other });
  }
  return { t, team, other };
}

const reader = (name: string, skillNames: string[]) =>
  agent(name, { toolNames: ["read_skill"], skillNames });

async function putIn(
  t: AccessInstance,
  userId: string,
  kind: "agent" | "skill",
  config: { name: string },
  workspaceId: string | undefined,
  expectedRevision: number | null = null
) {
  return t.call(userId, "assets.put", {
    params: { kind, name: config.name },
    payload: { config, expectedRevision, ...(workspaceId === undefined ? {} : { workspaceId }) }
  });
}

/** A refusal with the asset's name replaced, so two refusals for two names compare. */
function shape(response: { statusCode: number; body: string }, name: string) {
  const parsed = errorSchema.safeParse(JSON.parse(response.body));
  const text = JSON.stringify(parsed.success ? parsed.data : JSON.parse(response.body));
  return { status: response.statusCode, body: text.split(name).join("<NAME>") };
}

const defaultAgentName = async (t: AccessInstance) =>
  (await t.stores.configAssets.getConfigAssetState({ clientInstanceId })).defaultAgentName;

describe("WS-OWN-1a verifier: decision 4, a workspace agent is never the instance default", () => {
  it("refuses assets.set_default on an agent a workspace owns, also for an administrator", async () => {
    const { t, team } = await setup();
    expect((await putIn(t, t.kai.id, "agent", agent("team-helper"), team)).statusCode).toBe(200);

    // The administrator offers it everywhere, as a default must be, then names it the default.
    await t.expectOk(t.admin.id, "assets.set_availability", {
      params: { kind: "agent", name: "team-helper" },
      payload: { mode: "all" }
    });
    const response = await t.call(t.admin.id, "assets.set_default", {
      params: { kind: "agent" },
      payload: { name: "team-helper" }
    });
    expect(response.statusCode, response.body).not.toBe(200);
    expect(await defaultAgentName(t)).toBe("assistant");
  });

  it("does not make a workspace's first agent the default of an empty instance", async () => {
    const { t, team } = await setup();
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        { type: "setDefaultAgent", agentName: undefined },
        { type: "delete", kind: "agent", name: "assistant" }
      ]
    });
    const response = await putIn(t, t.admin.id, "agent", agent("team-first"), team);
    // Either refused, or written without becoming the instance default.
    if (response.statusCode === 200) {
      expect(await defaultAgentName(t)).not.toBe("team-first");
    }
  });
});

describe("WS-OWN-1a verifier: decision 4 through a release", () => {
  it("refuses a release that names a workspace's agent the default", async () => {
    const { t, team } = await setup();
    await storeTestServicePrincipal("sp_test");
    expect((await putIn(t, t.kai.id, "agent", agent("team-helper"), team)).statusCode).toBe(200);
    await t.expectOk(t.admin.id, "assets.set_availability", {
      params: { kind: "agent", name: "team-helper" },
      payload: { mode: "all" }
    });
    const released = await releaseAsService(t, {
      items: [],
      defaultAgentName: "team-helper",
      expectedDefaultAgentName: "assistant"
    });
    expect(released.statusCode, released.body).not.toBe(200);
    expect(await defaultAgentName(t)).toBe("assistant");
  });

  it("leaves no default naming a deleted workspace's agent", async () => {
    const { t, team } = await setup();
    expect((await putIn(t, t.kai.id, "agent", agent("team-helper"), team)).statusCode).toBe(200);
    await t.expectOk(t.admin.id, "assets.set_availability", {
      params: { kind: "agent", name: "team-helper" },
      payload: { mode: "all" }
    });
    const set = await t.call(t.admin.id, "assets.set_default", {
      params: { kind: "agent" },
      payload: { name: "team-helper" }
    });
    if (set.statusCode !== 200) return;
    await t.stores.workspaces.deleteWorkspace({ clientInstanceId, collaborationWorkspaceId: team });
    const after = await defaultAgentName(t);
    const row = after
      ? await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "agent", name: after })
      : undefined;
    expect({ after, active: row?.status }).toEqual({ after: "assistant", active: "active" });
  });
});

describe("WS-OWN-1a verifier: workspace boundary and existence oracle", () => {
  it("answers a read of another workspace's agent through one's own workspace as not found", async () => {
    const { t, team, other } = await setup();
    expect((await putIn(t, t.lena.id, "agent", agent("other-agent"), other)).statusCode).toBe(200);

    const get = (name: string, workspaceId?: string) =>
      t.call(t.kai.id, "assets.get", {
        params: { kind: "agent", name },
        ...(workspaceId === undefined ? {} : { query: { workspaceId } })
      });
    // Through his own workspace: the same answer as for a name nobody holds.
    expect(shape(await get("other-agent", team), "other-agent")).toEqual(
      shape(await get("nobody-agent", team), "nobody-agent")
    );
    // Through the other workspace: refused, the same for both.
    expect(shape(await get("other-agent", other), "other-agent")).toEqual(
      shape(await get("nobody-agent", other), "nobody-agent")
    );
    // Through the instance.
    expect(shape(await get("other-agent"), "other-agent")).toEqual(
      shape(await get("nobody-agent"), "nobody-agent")
    );
    const history = (name: string, workspaceId: string) =>
      t.call(t.kai.id, "assets.revisions.list", {
        params: { kind: "agent", name },
        query: { workspaceId }
      });
    expect(shape(await history("other-agent", team), "other-agent")).toEqual(
      shape(await history("nobody-agent", team), "nobody-agent")
    );
  });

  it("answers a write or delete against another workspace's name like a stale revision of nothing", async () => {
    const { t, team, other } = await setup();
    expect((await putIn(t, t.lena.id, "agent", agent("other-agent"), other)).statusCode).toBe(200);

    const update = (name: string) => putIn(t, t.kai.id, "agent", agent(name), team, 1);
    const updated = await update("other-agent");
    expect(updated.statusCode).not.toBe(200);
    expect(updated.body).not.toContain(other);

    const del = (name: string) =>
      t.call(t.kai.id, "assets.delete", {
        params: { kind: "agent", name },
        payload: { expectedRevision: 1, workspaceId: team }
      });
    const deleted = await del("other-agent");
    expect(deleted.statusCode).not.toBe(200);
    expect(shape(deleted, "other-agent")).toEqual(shape(await del("nobody-agent"), "nobody-agent"));
    expect(
      (
        await t.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "agent",
          name: "other-agent"
        })
      )?.status
    ).toBe("active");
  });

  it("refuses a create under a name another workspace holds without naming the owner", async () => {
    const { t, team, other } = await setup();
    expect((await putIn(t, t.lena.id, "skill", skill("other-notes"), other)).statusCode).toBe(200);
    const created = await putIn(t, t.kai.id, "skill", skill("other-notes"), team);
    expect(created.statusCode).not.toBe(200);
    expect(created.body).not.toContain(other);
    expect(created.body).not.toContain("Other team");
    expect(created.body).not.toContain("another scope");
  });

  it("does not let an agent of one workspace name another workspace's skill, also in a validate", async () => {
    const { t, team, other } = await setup();
    expect((await putIn(t, t.lena.id, "skill", skill("other-notes"), other)).statusCode).toBe(200);

    const written = await putIn(t, t.kai.id, "agent", reader("team-helper", ["other-notes"]), team);
    expect(written.statusCode).toBe(422);
    const missing = await putIn(
      t,
      t.kai.id,
      "agent",
      reader("team-helper", ["nobody-notes"]),
      team
    );
    expect(shape(written, "other-notes")).toEqual(shape(missing, "nobody-notes"));

    const validate = (skillName: string) =>
      t.call(t.kai.id, "assets.validate", {
        params: { kind: "agent" },
        payload: { config: reader("team-helper", [skillName]), workspaceId: team }
      });
    expect(shape(await validate("other-notes"), "other-notes")).toEqual(
      shape(await validate("nobody-notes"), "nobody-notes")
    );
  });

  it("lists nothing of another workspace to a member of one", async () => {
    const { t, team, other } = await setup();
    expect((await putIn(t, t.lena.id, "agent", agent("other-agent"), other)).statusCode).toBe(200);
    for (const workspaceId of [team, other, undefined]) {
      const listed = await t.call(t.kai.id, "assets.list", {
        params: { kind: "agent" },
        ...(workspaceId === undefined ? {} : { query: { workspaceId } })
      });
      expect(listed.body, String(workspaceId)).not.toContain("other-agent");
    }
    const context = await t.call(t.kai.id, "platform.context.get");
    expect(context.body).not.toContain(other);
    expect(context.body).not.toContain("Other team");
  });

  it("refuses a batch bound to one workspace that names another workspace's asset", async () => {
    const { t, team, other } = await setup();
    expect((await putIn(t, t.lena.id, "agent", agent("other-agent"), other)).statusCode).toBe(200);
    const batch = (name: string) =>
      t.call(t.kai.id, "assets.sync", {
        payload: {
          workspaceId: team,
          items: [{ type: "put", kind: "agent", config: agent(name), expectedRevision: 1 }]
        }
      });
    const taken = await batch("other-agent");
    expect(taken.statusCode).not.toBe(200);
    expect(taken.body).not.toContain(other);
    const deleted = await t.call(t.kai.id, "assets.sync", {
      payload: {
        workspaceId: team,
        items: [{ type: "delete", kind: "agent", name: "other-agent", expectedRevision: 1 }]
      }
    });
    expect(deleted.statusCode).not.toBe(200);
  });

  it("refuses placement of a workspace agent to its builder", async () => {
    const { t, team, other } = await setup();
    expect((await putIn(t, t.kai.id, "agent", agent("team-helper"), team)).statusCode).toBe(200);
    const widened = await t.call(t.kai.id, "assets.set_availability", {
      params: { kind: "agent", name: "team-helper" },
      payload: { mode: "selected", collaborationWorkspaceIds: [team, other] }
    });
    expect(widened.statusCode).toBe(403);
  });

  it("offers another workspace's agent nowhere in one's own workspace", async () => {
    const { t, team, other } = await setup(true);
    // Lena may approve her workspace's agents, so the one she makes is offered there at once
    // (WS-PUB-1b): the probe below needs an agent that is listed somewhere.
    await t.grant(t.lena.id, "agent.approve", { workspaceId: other });
    expect((await putIn(t, t.lena.id, "agent", agent("other-agent"), other)).statusCode).toBe(200);
    const listed = await t.call(t.kai.id, "workspaces.agents.list", {
      params: { collaborationWorkspaceId: team }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain("other-agent");
    // Lena's own list in her workspace holds it: the probe would see it if it leaked.
    const hers = await t.call(t.lena.id, "workspaces.agents.list", {
      params: { collaborationWorkspaceId: other }
    });
    expect(hers.body).toContain("other-agent");
  });

  it("starts no conversation about another workspace's agent, answered as for nothing", async () => {
    const { t, team, other } = await setup();
    expect((await putIn(t, t.lena.id, "agent", agent("other-agent"), other)).statusCode).toBe(200);
    const start = (name: string) =>
      t.call(t.kai.id, "conversations.create", {
        payload: { collaborationWorkspaceId: team, subject: { kind: "agent", name } }
      });
    const refused = await start("other-agent");
    expect(refused.statusCode).not.toBe(200);
    expect(shape(refused, "other-agent").body.replace(/corr_[0-9a-f-]+/u, "")).toEqual(
      shape(await start("nobody-agent"), "nobody-agent").body.replace(/corr_[0-9a-f-]+/u, "")
    );
  });

  it("lets a workspace's builder start a Build conversation about the workspace's own agent", async () => {
    const { t, team } = await setup();
    expect((await putIn(t, t.kai.id, "agent", agent("team-helper"), team)).statusCode).toBe(200);
    const started = await t.call(t.kai.id, "conversations.create", {
      payload: { collaborationWorkspaceId: team, subject: { kind: "agent", name: "team-helper" } }
    });
    expect(started.statusCode, started.body).toBe(200);
  });

  it("does not let a workspace's builder offer its agent in another workspace he is a member of", async () => {
    const { t, team, other } = await setup();
    // Kai is a member of Other too, but holds no right there.
    await join(t, t.kai, other);
    const response = await t.call(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "team-helper" },
      payload: {
        config: agent("team-helper"),
        expectedRevision: null,
        workspaceId: team,
        availableIn: { workspaceId: other }
      }
    });
    const availability = (
      await t.stores.configAssets.listAgentAvailability({ clientInstanceId })
    ).get("team-helper");
    // Either the put is refused, or the agent is offered in its own workspace only.
    if (response.statusCode === 200) {
      expect(availability?.collaborationWorkspaceIds ?? []).not.toContain(other);
    }
  });
});
