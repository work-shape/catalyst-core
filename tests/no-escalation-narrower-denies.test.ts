import { describe, expect, it } from "vitest";
import {
  asUserId,
  authorizeHeldRights,
  createActorAccess,
  type AccessHolder,
  type PermissionGrant
} from "@vivd-catalyst/core";
import { clientInstanceId, setupAccessInstance } from "./support/access-instance";

// The second review of RIGHTS-1b: a right given over a Namespace, a workspace or the instance
// (a role) asked the giver's right on that one place alone, so it reached past a deny of the
// giver on something narrower inside it. The giver handed on what they are refused. Each test
// fails without `denyInside` in `held-rights.ts`: the grant, the role and the account change
// pass.

async function setup() {
  const t = await setupAccessInstance();
  await t.createNamespace("kai-");
  for (const name of ["kai-secret", "kai-open"]) {
    expect((await t.putAgent(t.admin.id, name)).statusCode).toBe(200);
  }
  const secret = await t.assetId("agent", "kai-secret");
  return { ...t, secret };
}

const inNamespace = (holderId: string, action: string, namespace = "kai-") => ({
  payload: {
    holderKind: "user",
    holderId,
    action,
    effect: "allow",
    scopeKind: "namespace",
    namespace
  }
});

describe("a right given over a Namespace", () => {
  it("is refused to a giver denied it on an asset inside, named only where the giver reads it", async () => {
    const t = await setup();
    await t.grant(t.admin.id, "agent.read", { assetId: t.secret }, "deny");

    const refused = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      inNamespace(t.kai.id, "agent.read"),
      t.forbidden("agent.read", "denied")
    );
    // The admin may not read `kai-secret`, so the refusal does not name it.
    expect(refused.message).toBe(
      "'agent.read' on an asset this call may not read is denied to this call, and the right in the Namespace 'kai-' reaches it: 'Kai' would hold it. Only a holder of a right gives or lends it"
    );
    expect(await t.stores.access.listGrants({ clientInstanceId, holderId: t.kai.id })).toEqual([]);
    const kaiReads = await t.call(t.kai.id, "assets.get", {
      params: { kind: "agent", name: "kai-secret" }
    });
    expect(kaiReads.statusCode).toBe(403);

    // Unnamed as long as the admin may not read the asset. One asset outside the denies is
    // given as before.
    await t.grant(t.admin.id, "agent.write", { assetId: t.secret }, "deny");
    const named = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      inNamespace(t.kai.id, "agent.write"),
      t.forbidden("agent.write", "denied")
    );
    expect(named.message).toContain("'agent.write' on an asset this call may not read");
    await t.grant(t.kai.id, "agent.read", { assetId: await t.assetId("agent", "kai-open") });
    // The superadmin holds no deny and gives the Namespace.
    await t.expectOk(t.root.id, "permissions.grant", inNamespace(t.kai.id, "agent.read"));
  });

  it("names a deny on an asset the giver still reads", async () => {
    const t = await setup();
    await t.grant(t.admin.id, "agent.write", { assetId: t.secret }, "deny");
    const refused = await t.expectRefused(
      t.admin.id,
      "permissions.grant",
      inNamespace(t.kai.id, "agent.write"),
      t.forbidden("agent.write", "denied")
    );
    expect(refused.message).toContain("'agent.write' on the agent 'kai-secret' is denied");
  });
});

describe("a role or a key given by a giver denied in a Namespace", () => {
  it("refuses the admin role and a principal's key, and passes a workspace the deny lies outside", async () => {
    const t = await setup();
    await t.grant(t.admin.id, "agent.read", { namespace: "kai-" }, "deny");
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
