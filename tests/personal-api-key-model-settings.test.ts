import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  asUserId,
  createActorAccess,
  type AccessHolder,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import {
  agentConfig,
  grantKaiWorkspace,
  setupPersonalKeyInstance as setup,
  type PersonalKeyInstance
} from "./support/personal-api-keys";

// A personal key covers its owner's right to change an agent's model settings where it covers
// writing that agent: the key names which agents, the right stays the owner's. No scope names
// `agent_models.manage`, and nothing else a key covers widens with it.

const unitInstanceId = asClientInstanceId("key-model-settings-test");
const MODEL_RIGHT = "agent_models.manage";

function holder(kind: AccessHolder["kind"] = "user"): AccessHolder {
  return {
    kind,
    id: "kai",
    clientInstanceId: unitInstanceId,
    roles: ["user"],
    permissionRefs: []
  };
}

function instanceRow(
  action: string,
  holderKind: PermissionGrant["holderKind"] = "user"
): PermissionGrant {
  return {
    id: `grant-${action}`,
    clientInstanceId: unitInstanceId,
    holderKind,
    holderId: "kai",
    action,
    effect: "allow",
    scopeKind: "instance",
    grantedBy: asUserId("admin"),
    createdAt: "2026-11-10T00:00:00.000Z"
  };
}

const agentIn = (workspaceId: string, name = "kai-helper") => ({
  kind: "agent",
  name,
  workspaceId
});

describe("the model settings right under a personal key", () => {
  const owner = (grants: PermissionGrant[], keyScopes?: string[], kind?: AccessHolder["kind"]) =>
    createActorAccess(holder(kind), { holderActive: true, grants }, keyScopes);
  const holds = [instanceRow(MODEL_RIGHT)];

  it("is covered where the key covers writing the agent, with its workspace and asset", () => {
    expect(owner(holds, ["agent.write"]).authorize(MODEL_RIGHT, agentIn("ws-1")).allowed).toBe(
      true
    );
    const inWorkspace = owner(holds, ["agent.write:ws-1"]);
    expect(inWorkspace.authorize(MODEL_RIGHT, agentIn("ws-1")).allowed).toBe(true);
    expect(inWorkspace.authorize(MODEL_RIGHT, agentIn("ws-2"))).toEqual({
      allowed: false,
      reason: "outside_key_scope"
    });
    // Asked without the agent, only a key over every agent covers it.
    expect(inWorkspace.authorize(MODEL_RIGHT)).toEqual({
      allowed: false,
      reason: "outside_key_scope"
    });
    const oneAgent = owner(holds, ["agent.write:ws-1/kai-helper"]);
    expect(oneAgent.authorize(MODEL_RIGHT, agentIn("ws-1")).allowed).toBe(true);
    expect(oneAgent.authorize(MODEL_RIGHT, agentIn("ws-1", "other"))).toEqual({
      allowed: false,
      reason: "outside_key_scope"
    });
  });

  it("is refused to a key without agent.write, and to an owner who does not hold it", () => {
    for (const scopes of [["agent.read"], ["skill.write"], ["agent.delete"], [MODEL_RIGHT]]) {
      expect(owner(holds, scopes).authorize(MODEL_RIGHT, agentIn("ws-1"))).toEqual({
        allowed: false,
        reason: "outside_key_scope"
      });
    }
    expect(owner([], ["agent.write"]).authorize(MODEL_RIGHT, agentIn("ws-1"))).toEqual({
      allowed: false,
      reason: "no_grant"
    });
  });

  it("widens nothing else a key may not name, and leaves calls without a key as they were", () => {
    // A superadmin holds every right; a key that writes every agent still covers no other.
    const superadmin = createActorAccess(
      { ...holder(), roles: ["user", "superadmin"] },
      { holderActive: true, grants: [] },
      ["agent.write"]
    );
    expect(superadmin.authorize(MODEL_RIGHT).allowed).toBe(true);
    for (const action of [
      "users.manage",
      "api_access.manage",
      "agent_skills.approve",
      "skill.approve",
      "operations.approve"
    ]) {
      expect(superadmin.authorize(action)).toEqual({
        allowed: false,
        reason: "outside_key_scope"
      });
    }
    // Signed in, or a service principal, whose credential carries no key scopes.
    for (const kind of ["user", "service_principal"] as const) {
      expect(
        owner([instanceRow(MODEL_RIGHT, kind)], undefined, kind).authorize(MODEL_RIGHT).allowed
      ).toBe(true);
      expect(owner([], undefined, kind).authorize(MODEL_RIGHT)).toEqual({
        allowed: false,
        reason: "no_grant"
      });
    }
  });
});

/**
 * An agent whose model settings need the right: a binding and an effort, which a writer of the
 * workspace picks, and the model fallback turned off, which only the right changes.
 */
function modelAgent(name: string) {
  const { modelProviderId: _provider, ...rest } = agentConfig(name);
  return { ...rest, modelBindingId: "plain", reasoningEffort: "low", useModelFallback: false };
}

/** Kai holds the right in his list, as only a superadmin gives it. */
async function grantModelRight(t: PersonalKeyInstance) {
  await t.stores.users.updateUser({
    clientInstanceId,
    userId: t.kai.id,
    permissions: [MODEL_RIGHT],
    grantedBy: t.root.id
  });
}

function push(
  t: PersonalKeyInstance,
  headers: Record<string, string>,
  workspaceId: string,
  name: string
) {
  return t.call(t.kai.id, "assets.sync", {
    payload: {
      workspaceId,
      items: [{ type: "put", kind: "agent", config: modelAgent(name), expectedRevision: null }]
    },
    headers
  });
}

describe("pushing an agent's model settings with a personal key", () => {
  it("is allowed only where the owner holds the right and the key writes the agent", async () => {
    const t = await setup();
    await grantKaiWorkspace(t);
    const lenaTeam = await t.sharedWorkspace("Lena Spezis");
    await t.grant(t.kai.id, "agent.write", { workspaceId: lenaTeam });
    const headers = await t.tokenFor(
      (await t.issue([`agent.read:${t.kaiTeam}`, `agent.write:${t.kaiTeam}`])).secret
    );
    // The owner does not hold the right: refused, naming it.
    const refused = await push(t, headers, t.kaiTeam, "kai-modelled");
    expect(refused.statusCode).toBe(403);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      items: [{ status: "refused", error: { action: MODEL_RIGHT } }]
    });

    await grantModelRight(t);
    const pushed = await push(t, headers, t.kaiTeam, "kai-modelled");
    expect(pushed.statusCode, pushed.body).toBe(200);
    const put = await t.call(t.kai.id, "assets.put", {
      params: { kind: "agent", name: "kai-put" },
      payload: { config: modelAgent("kai-put"), workspaceId: t.kaiTeam },
      headers
    });
    expect(put.statusCode, put.body).toBe(200);

    // A key that does not write the agent is refused, though the owner holds the right.
    const readOnly = await t.tokenFor((await t.issue([`agent.read:${t.kaiTeam}`])).secret);
    expect((await push(t, readOnly, t.kaiTeam, "kai-other")).statusCode).toBe(403);
    const elsewhere = await t.tokenFor(
      (await t.issue([`agent.read:${t.kaiTeam}`, `agent.write:${lenaTeam}`])).secret
    );
    expect((await push(t, elsewhere, t.kaiTeam, "kai-other")).statusCode).toBe(403);
  });
});
