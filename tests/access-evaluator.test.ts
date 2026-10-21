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
  legacyGrantRows,
  listAccessEntries,
  type AccessHolder,
  type AccessResource,
  type PermissionGrant,
  type PersistedAccess
} from "@work-shape/catalyst-core";

const clientInstanceId = asClientInstanceId("evaluator-test");
const otherClientInstanceId = asClientInstanceId("evaluator-other");

function holder(input: Partial<AccessHolder> = {}): AccessHolder {
  return {
    kind: "user",
    id: "kai",
    clientInstanceId,
    roles: ["user"],
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

/** The instance-wide rows a legacy list became (AP-4). */
function legacyRows(entries: string[]): PermissionGrant[] {
  return legacyGrantRows(entries).map((row) => grant(row));
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
/** The same asset as the instance owns it: no workspace row covers it. */
const instanceResource: AccessResource = { kind: "agent", name: "kai-helper", assetId: "asset-1" };
const scopes = {
  instance: { scopeKind: "instance" },
  asset: { scopeKind: "asset", scopeId: "asset-1" },
  workspace: { scopeKind: "workspace", scopeId: "workspace-1" }
} as const satisfies Record<PermissionGrant["scopeKind"], Partial<PermissionGrant>>;
const scopeKinds = ["instance", "asset", "workspace"] as const;

describe("access evaluator: what a row covers", () => {
  it("lets an instance row cover every resource and no resource at all", () => {
    const grants = [grant()];
    expect(decide({ grants })).toEqual(allowedByGrant);
    expect(decide({ grants, resource: { kind: "agent", name: "other-helper" } })).toEqual(
      allowedByGrant
    );
  });

  // NS-RETIRE: a row of a scope kind the evaluator does not know, such as one read from a
  // store that still had the retired kind, covers nothing, a name included.
  it("never lets a row of an unknown scope kind cover anything", () => {
    const row = grant();
    // A kind the types no longer name, as a stored row may still carry it.
    Reflect.set(row, "scopeKind", "prefix");
    const grants = [row];
    expect(decide({ grants, resource: sharedResource })).toEqual(noGrant);
    expect(decide({ grants, resource: { name: "kai-helper" } })).toEqual(noGrant);
    expect(decide({ grants })).toEqual(noGrant);
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
    const grants = [grant({ action: "unregistered.action" }), grant({ action: "ref:demo-tools" })];
    expect(listAccessEntries(holder(), persisted(grants))).toEqual([]);
    expect(decide({ grants, action: "unregistered.action" })).toEqual({
      allowed: false,
      reason: "unknown_action"
    });
  });
});

describe("access evaluator: deny wins", () => {
  for (const denyScope of scopeKinds) {
    for (const allowScope of scopeKinds) {
      it(`lets a ${denyScope} deny win over a ${allowScope} allow where both cover the resource`, () => {
        const allow = grant(scopes[allowScope]);
        const deny = grant({ ...scopes[denyScope], effect: "deny" });
        const resource = sharedResource;
        expect(decide({ grants: [allow], resource })).toEqual(allowedByGrant);
        expect(decide({ grants: [allow, deny], resource })).toEqual(denied);
        expect(decide({ grants: [deny, allow], resource })).toEqual(denied);
      });
    }
  }

  it("leaves the allow standing where the deny does not cover the resource", () => {
    const grants = [
      grant(scopes.workspace),
      grant({ scopeKind: "asset", scopeId: "asset-1", effect: "deny" })
    ];
    expect(
      decide({
        grants,
        resource: { name: "kai-helper", assetId: "asset-1", workspaceId: "workspace-1" }
      })
    ).toEqual(denied);
    expect(
      decide({
        grants,
        resource: { name: "kai-other", assetId: "asset-2", workspaceId: "workspace-1" }
      })
    ).toEqual(allowedByGrant);
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

  it("reads a legacy revocation, now instance deny rows, as a deny on every target, over a row and over a role", () => {
    const admin = holder({ roles: ["user", "admin"] });
    const revocation = legacyRows(["!config_assets.write"]);
    for (const action of ["agent.write", "agent.delete", "skill.write", "skill.delete"]) {
      expect(decide({ holder: admin, grants: [...revocation, grant({ action })], action })).toEqual(
        denied
      );
      expect(
        decide({
          holder: admin,
          grants: [...revocation, grant({ action, ...scopes.workspace })],
          action,
          resource: sharedResource
        })
      ).toEqual(denied);
    }
    expect(decide({ holder: admin, grants: revocation, action: "agent.read" })).toEqual({
      allowed: true,
      source: "role"
    });
  });
});

describe("access evaluator: the classes of action", () => {
  it("answers a legacy key from the role and instance rows, never from a narrower row", () => {
    expect(decide({ action: "config_assets.write" })).toEqual(noGrant);
    expect(
      decide({ holder: holder({ roles: ["user", "admin"] }), action: "config_assets.write" })
    ).toEqual({ allowed: true, source: "role" });
    expect(
      decide({ grants: legacyRows(["config_assets.write"]), action: "config_assets.write" })
    ).toEqual(allowedByGrant);

    const narrow = ["agent.write", "agent.delete", "skill.write", "skill.delete"].map((action) =>
      grant({ action, ...scopes.workspace })
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
    for (const action of ["unregistered.action", "", "*", "agent.*", "AGENT.WRITE"]) {
      expect(decide({ holder: superadmin, action })).toEqual({
        allowed: false,
        reason: "unknown_action"
      });
    }
  });

  it("writes no row for an entry of a legacy list that names no key", () => {
    expect(legacyGrantRows(["agent.write", "!agent.write", "nonsense", "!"])).toEqual([]);
    expect(listAccessEntries(holder(), persisted())).toEqual([]);
  });
});

describe("access evaluator: an inactive holder", () => {
  it("holds nothing from any source", () => {
    const superadmin = holder({
      roles: ["user", "admin", "superadmin"],
      permissionRefs: ["demo-tools"]
    });
    const grants = [grant(), ...legacyRows(["config_assets.release"])];
    for (const action of [...ACTIONS, ...PERMISSIONS, "ref:demo-tools", "unregistered.action"]) {
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
  it("gives a plain user nothing, an admin no release, no API access and no built-in role edits, a superadmin all but release", () => {
    const allowedFor = (roles: string[]) =>
      ACTIONS.filter((action) => decide({ holder: holder({ roles }), action }).allowed);

    expect(allowedFor(["user"])).toEqual([]);
    expect(allowedFor(["user", "admin"])).toEqual(
      ACTIONS.filter(
        (action) =>
          action !== "assets.release" &&
          action !== "api_access.manage" &&
          action !== "agent_models.manage" &&
          action !== "roles.edit_built_in"
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
      persisted([grant(scopes.workspace), grant({ action: "skill.write", effect: "deny" })])
    );

    expect(() => access.require("agent.write", { workspaceId: "workspace-1" })).not.toThrow();
    for (const [action, reason] of [
      ["agent.write", "no_grant"],
      ["skill.write", "denied"],
      ["unregistered.action", "unknown_action"]
    ] as const) {
      let thrown: unknown;
      try {
        access.require(action, { workspaceId: "workspace-2" });
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
      holder({ roles: ["user", "admin"] }),
      persisted([
        ...legacyRows(["!usage.view", "config_assets.release"]),
        grant({ action: "audit.view", effect: "deny" })
      ])
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

describe("resource use through workspace availability (AVAIL-1)", () => {
  it.each(["knowledge_base", "connection"] as const)(
    "inherits only %s.use and retains explicit denies and key bounds",
    (kind) => {
      const resource = { kind, name: "handbook", assetId: "asset-available" };
      const state: PersistedAccess = {
        holderActive: true,
        grants: [],
        memberWorkspaceIds: ["nordlicht"],
        availableAssets: [{ kind, assetId: resource.assetId }]
      };
      const access = createActorAccess(holder(), state);
      expect(access.authorize(`${kind}.use`, resource)).toEqual({
        allowed: true,
        source: "membership"
      });
      for (const verb of ["read", "write", "delete"])
        expect(access.authorize(`${kind}.${verb}`, resource)).toEqual(noGrant);
      expect(access.authorize(`${kind}.use`, { ...resource, assetId: "elsewhere" })).toEqual(
        noGrant
      );
      expect(
        createActorAccess(holder(), { ...state, availableAssets: [] }).authorize(
          `${kind}.use`,
          resource
        )
      ).toEqual(noGrant);
      const deniedAccess = createActorAccess(holder(), {
        ...state,
        grants: [
          grant({
            action: `${kind}.use`,
            effect: "deny",
            scopeKind: "asset",
            scopeId: resource.assetId
          })
        ]
      });
      expect(deniedAccess.authorize(`${kind}.use`, resource)).toEqual(denied);
      expect(
        createActorAccess(holder(), state, ["agent.read"]).authorize(`${kind}.use`, resource)
      ).toEqual({ allowed: false, reason: "outside_key_scope" });
    }
  );
});

describe("workspace bundles (WS-BUILD-1)", () => {
  const inWorkspace: AccessResource = { kind: "agent", assetId: "asset-1", workspaceId: "kai" };
  const builder = grant({ action: "builder", scopeKind: "workspace", scopeId: "kai" });
  const publisher = grant({ action: "publisher", scopeKind: "workspace", scopeId: "kai" });

  it("lets Builder read and write every kind its workspace owns, and nothing elsewhere", () => {
    for (const kind of ["agent", "skill", "app", "data_store", "knowledge_base", "guardrail"]) {
      for (const verb of ["read", "write"]) {
        const action = `${kind}.${verb}`;
        expect(decide({ grants: [builder], action, resource: inWorkspace })).toEqual(
          allowedByGrant
        );
        expect(
          decide({ grants: [builder], action, resource: { ...inWorkspace, workspaceId: "other" } })
        ).toEqual(noGrant);
        expect(decide({ grants: [builder], action, resource: instanceResource })).toEqual(noGrant);
      }
    }
  });

  it("gives Builder no delete, no publish, no approve and no use", () => {
    for (const action of ["agent.delete", "agent.publish", "skill.approve", "app.use"]) {
      expect(decide({ grants: [builder], action, resource: inWorkspace })).toEqual(noGrant);
    }
  });

  it("lets Publisher publish what its workspace owns, never a guardrail or a Workflow", () => {
    for (const action of ["agent.publish", "app.publish", "data_store.publish"]) {
      expect(decide({ grants: [publisher], action, resource: inWorkspace })).toEqual(
        allowedByGrant
      );
    }
    for (const action of ["guardrail.publish", "workflow.publish", "agent.write", "app.delete"]) {
      expect(decide({ grants: [publisher], action, resource: inWorkspace })).toEqual(noGrant);
    }
  });

  it("reaches a kind a later release lets a workspace own without a new row (check 35)", () => {
    // No workspace owns a Workflow yet; once one does, its asset carries the workspace.
    const workflow: AccessResource = { kind: "workflow", assetId: "wf-1", workspaceId: "kai" };
    expect(decide({ grants: [builder], action: "workflow.write", resource: workflow })).toEqual(
      allowedByGrant
    );
  });

  it("carries nothing from a bundle row outside a workspace", () => {
    const outside: Partial<PermissionGrant>[] = [scopes.instance, scopes.asset];
    for (const scope of outside) {
      const row = grant({ action: "builder", ...scope });
      expect(decide({ grants: [row], resource: inWorkspace })).toEqual(noGrant);
    }
  });

  it("lets a deny on one agent refuse a Builder there and nowhere else (check 34)", () => {
    const grants = [
      builder,
      grant({ action: "agent.write", effect: "deny", scopeKind: "asset", scopeId: "asset-1" })
    ];
    expect(decide({ grants, resource: inWorkspace })).toEqual(denied);
    expect(decide({ grants, resource: { ...inWorkspace, assetId: "asset-2" } })).toEqual(
      allowedByGrant
    );
  });

  it("answers held rows and denials through the bundle", () => {
    const access = createActorAccess(holder(), persisted([builder]));
    expect(access.holdsGrantAt("agent.write", ["workspace"])).toBe(true);
    expect(access.holdsGrantAt("agent.delete", ["workspace"])).toBe(false);
    const refused = createActorAccess(holder(), persisted([{ ...builder, effect: "deny" }]));
    expect(refused.denials("skill.write")).toEqual([
      expect.objectContaining({ action: "builder", scopeId: "kai" })
    ]);
    expect(refused.authorize("skill.write", inWorkspace)).toEqual(denied);
  });
});
