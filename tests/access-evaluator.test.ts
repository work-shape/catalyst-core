import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  AppError,
  PERMISSIONS,
  allowedLegacyPermissions,
  asClientInstanceId,
  asUserId,
  createActorAccess,
  evaluateAccess,
  listAccessEntries,
  type AccessHolder,
  type AccessResource,
  type PermissionGrant,
  type PersistedAccess
} from "@vivd-catalyst/core";

const clientInstanceId = asClientInstanceId("evaluator-test");
const otherClientInstanceId = asClientInstanceId("evaluator-other");

function holder(input: Partial<AccessHolder> = {}): AccessHolder {
  return {
    kind: "user",
    id: "kai",
    clientInstanceId,
    roles: ["user"],
    permissions: [],
    permissionRefs: [],
    ...input
  };
}

let nextGrant = 0;
function grant(input: Partial<PermissionGrant> = {}): PermissionGrant {
  nextGrant += 1;
  return {
    id: `grant-${nextGrant}`,
    clientInstanceId,
    holderKind: "user",
    holderId: "kai",
    action: "agent.write",
    effect: "allow",
    scopeKind: "instance",
    grantedBy: asUserId("admin"),
    createdAt: "2026-10-10T00:00:00.000Z",
    ...input
  };
}

function persisted(grants: PermissionGrant[] = [], holderActive = true): PersistedAccess {
  return { holderActive, grants };
}

function decide(
  input: {
    holder?: AccessHolder;
    grants?: PermissionGrant[];
    action?: string;
    resource?: AccessResource;
    holderActive?: boolean;
  } = {}
) {
  return evaluateAccess({
    holder: input.holder ?? holder(),
    persisted: persisted(input.grants, input.holderActive),
    action: input.action ?? "agent.write",
    ...(input.resource === undefined ? {} : { resource: input.resource })
  });
}

const allowedByGrant = { allowed: true, source: "grant" };
const noGrant = { allowed: false, reason: "no_grant" };
const denied = { allowed: false, reason: "denied" };

/** One resource every scope below covers, so that a pair of rows always meets on it. */
const sharedResource: AccessResource = {
  kind: "agent",
  name: "kai-helper",
  assetId: "asset-1",
  workspaceId: "workspace-1"
};
const scopes = {
  instance: { scopeKind: "instance" },
  namespace: { scopeKind: "namespace", namespace: "kai-" },
  asset: { scopeKind: "asset", scopeId: "asset-1" },
  workspace: { scopeKind: "workspace", scopeId: "workspace-1" }
} as const satisfies Record<PermissionGrant["scopeKind"], Partial<PermissionGrant>>;
const scopeKinds = ["instance", "namespace", "asset", "workspace"] as const;

describe("access evaluator: what a row covers", () => {
  it("lets an instance row cover every resource and no resource at all", () => {
    const grants = [grant()];
    expect(decide({ grants })).toEqual(allowedByGrant);
    expect(decide({ grants, resource: { kind: "agent", name: "other-helper" } })).toEqual(
      allowedByGrant
    );
  });

  it("lets a Namespace row cover a name that starts with the prefix and refuses every other name", () => {
    const grants = [grant(scopes.namespace)];
    expect(decide({ grants, resource: { name: "kai-helper" } })).toEqual(allowedByGrant);
    expect(decide({ grants, resource: { name: "kai-" } })).toEqual(allowedByGrant);

    expect(decide({ grants, resource: { name: "other-helper" } })).toEqual(noGrant);
    expect(decide({ grants, resource: { name: "kai" } })).toEqual(noGrant);
    expect(decide({ grants, resource: { name: "kaiser-helper" } })).toEqual(noGrant);
    expect(decide({ grants, resource: { name: "team-kai-helper" } })).toEqual(noGrant);
    expect(decide({ grants, resource: { name: "Kai-helper" } })).toEqual(noGrant);
    expect(decide({ grants, resource: { assetId: "asset-1" } })).toEqual(noGrant);
    expect(decide({ grants })).toEqual(noGrant);
  });

  it("never lets a Namespace row without a prefix cover anything", () => {
    for (const namespace of [undefined, ""]) {
      const grants = [grant({ scopeKind: "namespace", namespace })];
      expect(decide({ grants, resource: { name: "kai-helper" } })).toEqual(noGrant);
    }
  });

  it("lets an asset row cover that asset and refuses another asset", () => {
    const grants = [grant(scopes.asset)];
    expect(decide({ grants, resource: { assetId: "asset-1" } })).toEqual(allowedByGrant);
    expect(decide({ grants, resource: { assetId: "asset-2" } })).toEqual(noGrant);
    expect(decide({ grants, resource: { workspaceId: "asset-1" } })).toEqual(noGrant);
    expect(decide({ grants, resource: { name: "asset-1" } })).toEqual(noGrant);
    expect(decide({ grants })).toEqual(noGrant);
  });

  it("lets a workspace row cover that workspace and refuses another workspace", () => {
    const grants = [grant(scopes.workspace)];
    expect(decide({ grants, resource: { workspaceId: "workspace-1" } })).toEqual(allowedByGrant);
    expect(decide({ grants, resource: { workspaceId: "workspace-2" } })).toEqual(noGrant);
    expect(decide({ grants, resource: { assetId: "workspace-1" } })).toEqual(noGrant);
    expect(decide({ grants })).toEqual(noGrant);
  });

  it("never lets an asset or workspace row without an id cover anything", () => {
    for (const scopeKind of ["asset", "workspace"] as const) {
      const grants = [grant({ scopeKind })];
      expect(decide({ grants, resource: sharedResource })).toEqual(noGrant);
      expect(decide({ grants, resource: {} })).toEqual(noGrant);
    }
  });

  it("applies a row only to the action it names", () => {
    const grants = [grant({ action: "agent.write" })];
    expect(decide({ grants, action: "agent.write" })).toEqual(allowedByGrant);
    expect(decide({ grants, action: "agent.delete" })).toEqual(noGrant);
    expect(decide({ grants, action: "skill.write" })).toEqual(noGrant);
  });
});

describe("access evaluator: whose rows apply", () => {
  it("ignores a row of another client instance", () => {
    const foreign = grant({ clientInstanceId: otherClientInstanceId });
    expect(decide({ grants: [foreign] })).toEqual(noGrant);
    expect(decide({ grants: [grant()] })).toEqual(allowedByGrant);
  });

  it("ignores a deny row of another client instance", () => {
    const foreignDeny = grant({ clientInstanceId: otherClientInstanceId, effect: "deny" });
    expect(decide({ grants: [grant(), foreignDeny] })).toEqual(allowedByGrant);
  });

  it("ignores a row of another holder and a row of the same id under another holder kind", () => {
    expect(decide({ grants: [grant({ holderId: "lena" })] })).toEqual(noGrant);
    expect(decide({ grants: [grant({ holderKind: "service_principal" })] })).toEqual(noGrant);

    const principal = holder({ kind: "service_principal", roles: [] });
    expect(decide({ holder: principal, grants: [grant()] })).toEqual(noGrant);
    expect(
      decide({ holder: principal, grants: [grant({ holderKind: "service_principal" })] })
    ).toEqual(allowedByGrant);
  });

  it("ignores a row whose action is not registered", () => {
    const grants = [grant({ action: "agent.publish" }), grant({ action: "ref:demo-tools" })];
    expect(listAccessEntries(holder(), persisted(grants))).toEqual([]);
    expect(decide({ grants, action: "agent.publish" })).toEqual({
      allowed: false,
      reason: "unknown_action"
    });
  });
});

describe("access evaluator: deny wins", () => {
  for (const denyScope of scopeKinds) {
    for (const allowScope of scopeKinds) {
      it(`refuses when a ${denyScope} deny meets a ${allowScope} allow`, () => {
        const allow = grant(scopes[allowScope]);
        const deny = grant({ ...scopes[denyScope], effect: "deny" });

        expect(decide({ grants: [allow], resource: sharedResource })).toEqual(allowedByGrant);
        expect(decide({ grants: [allow, deny], resource: sharedResource })).toEqual(denied);
        expect(decide({ grants: [deny, allow], resource: sharedResource })).toEqual(denied);
      });
    }
  }

  it("leaves the allow standing where the deny does not cover the resource", () => {
    const grants = [
      grant(scopes.namespace),
      grant({ scopeKind: "asset", scopeId: "asset-1", effect: "deny" })
    ];
    expect(decide({ grants, resource: { name: "kai-helper", assetId: "asset-1" } })).toEqual(
      denied
    );
    expect(decide({ grants, resource: { name: "kai-other", assetId: "asset-2" } })).toEqual(
      allowedByGrant
    );
  });

  it("leaves another action standing beside a deny", () => {
    const grants = [
      grant({ action: "agent.write", effect: "deny" }),
      grant({ action: "agent.read" })
    ];
    expect(decide({ grants, action: "agent.write" })).toEqual(denied);
    expect(decide({ grants, action: "agent.read" })).toEqual(allowedByGrant);
  });

  it("refuses a role default when a row denies it, also for a superadmin", () => {
    const superadmin = holder({ roles: ["user", "admin", "superadmin"] });
    expect(decide({ holder: superadmin })).toEqual({ allowed: true, source: "role" });
    expect(decide({ holder: superadmin, grants: [grant({ effect: "deny" })] })).toEqual(denied);
  });

  it("reads a legacy revocation as a deny on every target, over a row and over a role", () => {
    const revoked = holder({ roles: ["user", "admin"], permissions: ["!config_assets.write"] });
    for (const action of ["agent.write", "agent.delete", "skill.write", "skill.delete"]) {
      expect(decide({ holder: revoked, grants: [grant({ action })], action })).toEqual(denied);
      expect(
        decide({
          holder: revoked,
          grants: [grant({ action, ...scopes.namespace })],
          action,
          resource: sharedResource
        })
      ).toEqual(denied);
    }
    expect(decide({ holder: revoked, action: "agent.read" })).toEqual({
      allowed: true,
      source: "role"
    });
  });
});

describe("access evaluator: the classes of action", () => {
  it("answers a legacy key from the role, the column and instance rows, never from a narrower row", () => {
    expect(decide({ action: "config_assets.write" })).toEqual(noGrant);
    expect(
      decide({ holder: holder({ roles: ["user", "admin"] }), action: "config_assets.write" })
    ).toEqual({ allowed: true, source: "role" });
    expect(
      decide({
        holder: holder({ permissions: ["config_assets.write"] }),
        action: "config_assets.write"
      })
    ).toEqual({ allowed: true, source: "legacy" });

    const narrow = ["agent.write", "agent.delete", "skill.write", "skill.delete"].map((action) =>
      grant({ action, ...scopes.namespace })
    );
    expect(decide({ grants: narrow, action: "config_assets.write" })).toEqual(noGrant);
  });

  it("answers a legacy key only when every action behind it is allowed", () => {
    const some = [grant({ action: "agent.write" }), grant({ action: "agent.delete" })];
    expect(decide({ grants: some, action: "config_assets.write" })).toEqual(noGrant);
    const all = [...some, grant({ action: "skill.write" }), grant({ action: "skill.delete" })];
    expect(decide({ grants: all, action: "config_assets.write" })).toEqual(allowedByGrant);
    expect(
      decide({
        grants: [...all, grant({ action: "skill.delete", effect: "deny" })],
        action: "config_assets.write"
      })
    ).toEqual(denied);
  });

  it("answers a reference from the holder's own list alone", () => {
    const withRef = holder({ permissionRefs: ["demo-tools"] });
    expect(decide({ holder: withRef, action: "ref:demo-tools" })).toEqual({
      allowed: true,
      source: "legacy_ref"
    });
    expect(decide({ holder: withRef, action: "ref:other-tools" })).toEqual(noGrant);
    expect(decide({ holder: withRef, action: "ref:" })).toEqual(noGrant);
    expect(decide({ holder: withRef, action: "demo-tools" })).toEqual({
      allowed: false,
      reason: "unknown_action"
    });

    const superadmin = holder({ roles: ["user", "admin", "superadmin"] });
    expect(decide({ holder: superadmin, action: "ref:demo-tools" })).toEqual(noGrant);
    expect(
      decide({ grants: [grant({ action: "ref:demo-tools" })], action: "ref:demo-tools" })
    ).toEqual(noGrant);
  });

  it("does not let a reference named like an action grant that action", () => {
    const tricky = holder({ permissionRefs: ["agent.write", "users.manage"] });
    expect(decide({ holder: tricky, action: "agent.write" })).toEqual(noGrant);
    expect(decide({ holder: tricky, action: "users.manage" })).toEqual(noGrant);
    expect(decide({ holder: tricky, action: "ref:agent.write" })).toEqual({
      allowed: true,
      source: "legacy_ref"
    });
  });

  it("refuses an action nobody registered, also for a superadmin", () => {
    const superadmin = holder({ roles: ["user", "admin", "superadmin"] });
    for (const action of ["agent.publish", "", "*", "agent.*", "AGENT.WRITE"]) {
      expect(decide({ holder: superadmin, action })).toEqual({
        allowed: false,
        reason: "unknown_action"
      });
    }
  });

  it("skips an entry of the legacy column that names no key", () => {
    const odd = holder({ permissions: ["agent.write", "!agent.write", "nonsense", "!"] });
    expect(listAccessEntries(odd, persisted())).toEqual([]);
    expect(decide({ holder: odd })).toEqual(noGrant);
  });
});

describe("access evaluator: an inactive holder", () => {
  it("holds nothing from any source", () => {
    const superadmin = holder({
      roles: ["user", "admin", "superadmin"],
      permissions: ["config_assets.release"],
      permissionRefs: ["demo-tools"]
    });
    const grants = [grant()];
    for (const action of [...ACTIONS, ...PERMISSIONS, "ref:demo-tools", "agent.publish"]) {
      expect(decide({ holder: superadmin, grants, action, holderActive: false })).toEqual({
        allowed: false,
        reason: "holder_inactive"
      });
    }
    expect(decide({ holder: superadmin, grants, holderActive: true })).toEqual({
      allowed: true,
      source: "role"
    });
  });
});

describe("access evaluator: role defaults", () => {
  it("gives a plain user nothing, an admin no release and no API access, a superadmin all but release", () => {
    const allowedFor = (roles: string[]) =>
      ACTIONS.filter((action) => decide({ holder: holder({ roles }), action }).allowed);

    expect(allowedFor(["user"])).toEqual([]);
    expect(allowedFor(["user", "admin"])).toEqual(
      ACTIONS.filter(
        (action) =>
          action !== "assets.release" &&
          action !== "api_access.manage" &&
          action !== "agent_models.manage"
      )
    );
    expect(allowedFor(["user", "admin", "superadmin"])).toEqual(
      ACTIONS.filter((action) => action !== "assets.release")
    );
    expect(allowedFor(["owner"])).toEqual([]);
  });
});

describe("actor access", () => {
  it("throws the action and the reason, and nothing else, when a right is missing", () => {
    const access = createActorAccess(
      holder(),
      persisted([grant(scopes.namespace), grant({ action: "skill.write", effect: "deny" })])
    );

    expect(() => access.require("agent.write", { name: "kai-helper" })).not.toThrow();
    for (const [action, reason] of [
      ["agent.write", "no_grant"],
      ["skill.write", "denied"],
      ["agent.publish", "unknown_action"]
    ] as const) {
      let thrown: unknown;
      try {
        access.require(action, { name: "other-helper" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect(thrown).toMatchObject({
        code: "FORBIDDEN",
        statusCode: 403,
        message: `Missing the right '${action}'`,
        details: { action, reason }
      });
    }
  });

  it("lists the legacy keys a holder holds in full", () => {
    const access = createActorAccess(
      holder({ roles: ["user", "admin"], permissions: ["!usage.view", "config_assets.release"] }),
      persisted([grant({ action: "audit.view", effect: "deny" })])
    );
    expect(allowedLegacyPermissions(access)).toEqual([
      "agent_skills.approve",
      "config_assets.read",
      "config_assets.write",
      "config_assets.release",
      "users.manage"
    ]);
  });
});
