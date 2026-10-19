import { describe, expect, it } from "vitest";
import {
  asUserId,
  authorizeHeldRights,
  createActorAccess,
  type AccessHolder,
  type PermissionGrant
} from "@work-shape/catalyst-core";
import { agent, clientInstanceId, setupAccessInstance } from "./support/access-instance";

// The second review of RIGHTS-1b: a right given over a Namespace, a workspace or the instance
// (a role) asked the giver's right on that one place alone, so it reached past a deny of the
// giver on something narrower inside it. The giver handed on what they are refused. Each test
// fails without `denyInside` in `held-rights.ts`: the grant, the role and the account change
// pass.

async function setup(inWorkspace = false) {
  const t = await setupAccessInstance();
  await t.createNamespace("kai-");
  const workspaceId = inWorkspace ? await t.sharedWorkspace("Wide") : undefined;
  for (const name of ["kai-secret", "kai-open"]) {
    expect(
      (
        await t.call(t.admin.id, "assets.put", {
          params: { kind: "agent", name },
          payload: { config: agent(name), ...(workspaceId ? { workspaceId } : {}) }
        })
      ).statusCode
    ).toBe(200);
  }
  const secret = await t.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "agent",
    name: "kai-secret"
  });
  if (!secret) throw new Error("Missing secret agent");
  const open = await t.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "agent",
    name: "kai-open"
  });
  if (!open) throw new Error("Missing open agent");
  return { ...t, secret: secret.id, open: open.id, workspaceId };
}

const inWorkspace = (holderId: string, action: string, scopeId: string | undefined) => ({
  payload: {
    holderKind: "user",
    holderId,
    action,
    effect: "allow",
    scopeKind: "workspace",
    scopeId
  }
});

describe("a right given over a workspace", () => {
  it("is refused to a giver denied it on an asset inside, named only where the giver reads it", async () => {
    const t = await setup(true);
    await t.grant(t.admin.id, "agent.read", { assetId: t.secret }, "deny");

    const refused = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      inWorkspace(t.kai.id, "agent.read", t.workspaceId),
      t.forbidden("agent.read", "denied")
    );
    // The admin may not read `kai-secret`, so the refusal does not name it.
    expect(refused.message).toBe(
      `'agent.read' on an asset this call may not read is denied to this call, and the right in the workspace '${t.workspaceId}' reaches it: 'Kai' would hold it. Only a holder of a right gives or lends it`
    );
    expect(await t.stores.access.listGrants({ clientInstanceId, holderId: t.kai.id })).toEqual([]);
    const kaiReads = await t.call(t.kai.id, "assets.get", {
      params: { kind: "agent", name: "kai-secret" },
      query: { workspaceId: t.workspaceId }
    });
    expect(kaiReads.statusCode).toBe(403);

    // Unnamed as long as the admin may not read the asset. One asset outside the denies is
    // given as before.
    await t.grant(t.admin.id, "agent.write", { assetId: t.secret }, "deny");
    const named = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      inWorkspace(t.kai.id, "agent.write", t.workspaceId),
      t.forbidden("agent.write", "denied")
    );
    expect(named.message).toContain("'agent.write' on an asset this call may not read");
    await t.grant(t.kai.id, "agent.read", { assetId: t.open });
    // The superadmin holds no deny and gives the workspace.
    await t.expectOk(
      t.root.id,
      "permissions.grant",
      inWorkspace(t.kai.id, "agent.read", t.workspaceId)
    );
  });

  it("names a deny on an asset the giver still reads", async () => {
    const t = await setup(true);
    await t.grant(t.admin.id, "agent.write", { assetId: t.secret }, "deny");
    const refused = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      inWorkspace(t.kai.id, "agent.write", t.workspaceId),
      t.forbidden("agent.write", "denied")
    );
    expect(refused.message).toContain("'agent.write' on the agent 'kai-secret' is denied");
  });
});

describe("a role or a key given by a giver denied in a Namespace", () => {
  it("refuses the admin role and a principal's key, and passes a workspace the deny lies outside", async () => {
    const t = await setup();
    await t.seedHistoricalGrant(t.admin.id, "agent.read", { namespace: "kai-" }, "deny");
    const role = await t.call(t.admin.id, "users.update", {
      params: { userId: t.kai.id },
      payload: { roles: ["user", "admin"] }
    });
    expect(role.statusCode).toBe(403);
    expect(role.json()).toMatchObject({
      error: { details: { action: "agent.read", reason: "denied" } }
    });
    // A service principal's key is the instance-wide right as well (RIGHTS-1a).
    const principal = await t.call(t.admin.id, "service_principals.create", {
      payload: { displayLabel: "Writer", permissions: ["config_assets.read"] }
    });
    expect(principal.statusCode).toBe(403);
    expect(principal.json()).toMatchObject({
      error: { details: { action: "config_assets.read", reason: "denied" } }
    });
    // A Namespace lies in no workspace: the workspace is given.
    const workspaceId = await t.sharedWorkspace("Wide");
    await t.grant(t.lena.id, "agent.read", { workspaceId });
  });
});

describe("the rule over a workspace", () => {
  const holder: AccessHolder = {
    kind: "user",
    id: "usr_giver",
    clientInstanceId,
    roles: ["admin"],
    permissionRefs: []
  };
  const denyOn = (scope: Pick<PermissionGrant, "scopeKind" | "scopeId">): PermissionGrant => ({
    id: "grant_deny",
    clientInstanceId,
    holderKind: "user",
    holderId: holder.id,
    action: "app.write",
    effect: "deny",
    ...scope,
    grantedBy: asUserId("usr_root"),
    createdAt: "2026-10-15T00:00:00.000Z"
  });
  const giving = (
    grants: PermissionGrant[],
    assets: Map<string, { kind: string; name: string; workspaceId?: string }>
  ) =>
    authorizeHeldRights(
      createActorAccess(holder, { holderActive: true, grants }),
      [{ action: "app.write", resource: { workspaceId: "ws_a" } }],
      { gives: { label: "Kai" } },
      assets
    );

  it("refuses a deny on an asset the workspace owns, and passes one of another workspace", () => {
    const deny = denyOn({ scopeKind: "asset", scopeId: "asset_offers" });
    expect(
      giving(
        [deny],
        new Map([["asset_offers", { kind: "app", name: "offers", workspaceId: "ws_a" }]])
      )
    ).toMatchObject({ allowed: false, action: "app.write", reason: "denied" });
    expect(
      giving(
        [deny],
        new Map([["asset_offers", { kind: "app", name: "offers", workspaceId: "ws_b" }]])
      )
    ).toEqual({ allowed: true });
    // A deny whose asset the call does not place counts as inside: the strict reading.
    expect(giving([deny], new Map())).toMatchObject({ allowed: false, reason: "denied" });
    // A deny in a Namespace lies in no workspace.
    expect(
      giving([{ ...denyOn({ scopeKind: "namespace" }), namespace: "kai-" }], new Map())
    ).toEqual({ allowed: true });
  });
});

// The review of WS-BUILD-1: Builder in a workspace was asked as the bundle alone, so a giver
// denied `agent.write` on an agent the workspace owns gave Builder there, and its holder wrote
// the agent. Each case fails without the bundle's actions in `denials` (`permissions.ts`).
describe("a bundle given in a workspace", () => {
  const inside = (t: Awaited<ReturnType<typeof setup>>) => {
    if (t.workspaceId === undefined) throw new Error("Missing workspace");
    return t.workspaceId;
  };
  const editAgent = (t: Awaited<ReturnType<typeof setup>>, userId: string) =>
    t.call(userId, "assets.put", {
      params: { kind: "agent", name: "kai-secret" },
      payload: {
        config: agent("kai-secret", { instructions: "Edited" }),
        workspaceId: t.workspaceId
      }
    });

  it("is refused to a giver denied an action it carries on an asset inside, and nothing is written", async () => {
    const t = await setup(true);
    await t.grant(t.admin.id, "agent.write", { assetId: t.secret }, "deny");
    expect((await editAgent(t, t.admin.id)).statusCode).toBe(403);
    // The direct right is refused as before, and the bundle that carries it now as well.
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      inWorkspace(t.kai.id, "agent.write", t.workspaceId),
      t.forbidden("agent.write", "denied")
    );
    const refused = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      inWorkspace(t.kai.id, "builder", t.workspaceId),
      t.forbidden("builder", "denied")
    );
    expect(refused.message).toBe(
      `'agent.write' on the agent 'kai-secret' is denied to this call, and the right in the workspace '${t.workspaceId}' reaches it: 'Kai' would hold it. Only a holder of a right gives or lends it`
    );
    expect(await t.stores.access.listGrants({ clientInstanceId, holderId: t.kai.id })).toEqual([]);
    expect((await editAgent(t, t.kai.id)).statusCode).toBe(403);
    // Both refusals are audited as refused calls, as the direct grant's is; no row is granted.
    const events = await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 });
    expect(
      events.filter(
        (event) =>
          event.type === "operation.denied" && event.metadata?.operation === "permissions.grant"
      )
    ).toHaveLength(2);
    expect(
      events.filter(
        (event) => event.type === "permission.granted" && event.metadata?.holderId === t.kai.id
      )
    ).toEqual([]);

    // Publisher carries `agent.publish`, which the giver is not denied: it is given.
    await t.grant(t.kai.id, "publisher", { workspaceId: inside(t) });
    // The superadmin holds no deny and gives Builder; its holder then writes the agent.
    await t.expectOk(
      t.root.id,
      "permissions.grant",
      inWorkspace(t.kai.id, "builder", t.workspaceId)
    );
    expect((await editAgent(t, t.kai.id)).statusCode).toBe(200);
  });

  it("refuses Publisher to a giver denied a publish inside, and gives a bundle where the deny lies outside", async () => {
    const t = await setup(true);
    await t.grant(t.admin.id, "agent.publish", { assetId: t.secret }, "deny");
    await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      inWorkspace(t.kai.id, "publisher", t.workspaceId),
      t.forbidden("publisher", "denied")
    );
    // Builder carries no publish, and another workspace owns nothing the deny names.
    await t.grant(t.kai.id, "builder", { workspaceId: inside(t) });
    const elsewhere = await t.sharedWorkspace("Elsewhere");
    await t.grant(t.lena.id, "publisher", { workspaceId: elsewhere });
  });
});
