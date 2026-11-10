import { describe, expect, it } from "vitest";
import {
  ROLE_DEFAULT_ACTIONS,
  asClientInstanceId,
  asUserId,
  createActorAccess,
  evaluateAccess,
  type AccessHolder,
  type AccessResource,
  type PermissionGrant
} from "@work-shape/catalyst-core";

// The evaluator's half of a person's own MCP server (PMCP-2, connections acceptance check 77):
// `read`, `use`, `write` and `delete` on a Connection with `ownerOnly` are its owner's. Anyone
// else uses it never, and reads, writes or deletes it only through what they hold on the whole
// instance: no grant on the asset, no workspace, no availability and no key scope reaches it.

const clientInstanceId = asClientInstanceId("own-server-test");
const own: AccessResource = {
  kind: "connection",
  name: "carol-notes",
  assetId: "asset-carol-notes",
  ownerOnly: { ownerId: "carol" }
};
const VERBS = ["read", "use", "write", "delete"] as const;

function person(id: string, roles: string[] = ["user"]): AccessHolder {
  return { kind: "user", id, clientInstanceId, roles, permissionRefs: [] };
}

let next = 0;
function row(input: Partial<PermissionGrant>): PermissionGrant {
  next += 1;
  return {
    id: `grant-${next}`,
    clientInstanceId,
    holderKind: "user",
    holderId: "dave",
    action: "connection.use",
    effect: "allow",
    scopeKind: "instance",
    grantedBy: asUserId("admin"),
    createdAt: "2026-11-10T00:00:00.000Z",
    ...input
  };
}

function decide(holder: AccessHolder, action: string, grants: PermissionGrant[] = []) {
  return evaluateAccess({
    holder,
    persisted: { holderActive: true, grants },
    action,
    resource: own
  });
}

describe("rights on a person's own server", () => {
  it("are the owner's without any grant, and a deny still reaches the owner", () => {
    expect(ROLE_DEFAULT_ACTIONS.user).toContain("connection.add_own");
    for (const verb of VERBS) {
      expect(decide(person("carol"), `connection.${verb}`)).toEqual({
        allowed: true,
        source: "owner"
      });
    }
    expect(
      decide(person("carol"), "connection.use", [
        row({ holderId: "carol", effect: "deny", action: "connection.use" })
      ])
    ).toEqual({ allowed: false, reason: "denied" });
  });

  it("reach another person through no grant on the asset, workspace or instance use", () => {
    const grants = VERBS.flatMap((verb) => [
      row({ action: `connection.${verb}`, scopeKind: "asset", scopeId: own.assetId }),
      row({ action: `connection.${verb}`, scopeKind: "workspace", scopeId: "ws-team" })
    ]);
    for (const verb of VERBS) {
      expect(decide(person("dave"), `connection.${verb}`, grants)).toEqual({
        allowed: false,
        reason: "not_owner"
      });
    }
    expect(decide(person("dave"), "connection.use", [row({ action: "connection.use" })])).toEqual({
      allowed: false,
      reason: "not_owner"
    });
  });

  it("leave an admin reading, writing and deleting through the instance, and never using", () => {
    const admin = person("alice", ["user", "admin"]);
    for (const verb of ["read", "write", "delete"]) {
      expect(decide(admin, `connection.${verb}`)).toMatchObject({ allowed: true });
    }
    expect(decide(admin, "connection.use")).toEqual({ allowed: false, reason: "not_owner" });
    expect(decide(person("root", ["superadmin"]), "connection.use")).toEqual({
      allowed: false,
      reason: "not_owner"
    });
  });

  it("are not widened by a key of every scope, and reach no Service Principal", () => {
    const keyed = createActorAccess(person("dave"), { holderActive: true, grants: [] }, ["*"]);
    for (const verb of VERBS) {
      expect(keyed.authorize(`connection.${verb}`, own)).toEqual({
        allowed: false,
        reason: "not_owner"
      });
    }
    const principal: AccessHolder = {
      kind: "service_principal",
      id: "sp-notes",
      clientInstanceId,
      roles: [],
      permissionRefs: []
    };
    const granted = [
      row({
        holderKind: "service_principal",
        holderId: "sp-notes",
        scopeKind: "asset",
        scopeId: own.assetId
      })
    ];
    for (const verb of VERBS) {
      expect(decide(principal, `connection.${verb}`, granted)).toEqual({
        allowed: false,
        reason: "not_owner"
      });
    }
  });

  it("leave every other Connection as it was", () => {
    const { ownerOnly: _owner, ...shared } = own;
    const decision = evaluateAccess({
      holder: person("dave"),
      persisted: {
        holderActive: true,
        grants: [row({ scopeKind: "asset", scopeId: own.assetId })]
      },
      action: "connection.use",
      resource: shared
    });
    expect(decision).toEqual({ allowed: true, source: "grant" });
  });
});
