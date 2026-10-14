import { describe, expect, it } from "vitest";
import {
  AppError,
  asClientInstanceId,
  asUserId,
  authorizeHeldRights,
  createActorAccess,
  requireHeldRights,
  type AccessHolder,
  type HeldRight,
  type PermissionGrant
} from "@vivd-catalyst/core";

// The rule of no escalation (RIGHTS-1a, check 38): a person gives or lends a right only where
// the call holds it. "Holds" is the call's own `authorize`: role, rows, denies and the scopes of
// a personal key. A refusal names the asset only to a caller who may read it (escalation path 6).

const clientInstanceId = asClientInstanceId("held-rights-test");
const crm = { kind: "connection", name: "crm", assetId: "asset-crm" };
const lends = { lends: { label: "Monthly check" } };

function holder(roles: string[]): AccessHolder {
  return { kind: "user", id: "kai", clientInstanceId, roles, permissionRefs: [] };
}

let nextGrant = 0;
function row(input: Partial<PermissionGrant>): PermissionGrant {
  nextGrant += 1;
  return {
    id: `grant-${nextGrant}`,
    clientInstanceId,
    holderKind: "user",
    holderId: "kai",
    action: "connection.use",
    effect: "allow",
    scopeKind: "asset",
    scopeId: crm.assetId,
    grantedBy: asUserId("admin"),
    createdAt: "2026-10-14T00:00:00.000Z",
    ...input
  };
}

const accessWith = (roles: string[], grants: PermissionGrant[], keyScopes?: string[]) =>
  createActorAccess(holder(roles), { holderActive: true, grants }, keyScopes);

describe("the rule of no escalation", () => {
  const rights: HeldRight[] = [{ action: "connection.use", resource: crm }];

  it("allows a caller who holds every right, by role or by a row on the asset", () => {
    expect(authorizeHeldRights(accessWith(["user", "admin"], []), rights, lends)).toEqual({
      allowed: true
    });
    expect(authorizeHeldRights(accessWith(["user"], [row({})]), rights, lends)).toEqual({
      allowed: true
    });
    expect(authorizeHeldRights(accessWith(["user"], []), [], lends)).toEqual({ allowed: true });
  });

  it("names the asset to a caller who may read it, and only that there is one to who may not", () => {
    const reads = accessWith(["user"], [row({ action: "connection.read" })]);
    expect(authorizeHeldRights(reads, rights, lends)).toEqual({
      allowed: false,
      action: "connection.use",
      reason: "no_grant",
      message:
        "This call does not hold 'connection.use' on the connection 'crm', and 'Monthly check' would act with it. Only a holder of a right gives or lends it"
    });
    const blind = authorizeHeldRights(accessWith(["user"], []), rights, lends);
    expect(blind).toMatchObject({ allowed: false, action: "connection.use", reason: "no_grant" });
    expect(blind.allowed ? "" : blind.message).toContain("on an asset this call may not read");
    expect(blind.allowed ? "" : blind.message).not.toContain("crm");
  });

  it("refuses a deny, even to an administrator whose role holds the right", () => {
    const denied = accessWith(["user", "admin"], [row({ effect: "deny" })]);
    expect(authorizeHeldRights(denied, rights, lends)).toMatchObject({
      allowed: false,
      action: "connection.use",
      reason: "denied"
    });
  });

  it("lends through a personal key only what its scopes cover", () => {
    const admin = ["user", "admin"];
    const reading: HeldRight[] = [{ action: "connection.read", resource: crm }];
    expect(authorizeHeldRights(accessWith(admin, [], ["connection.read"]), reading, lends)).toEqual(
      { allowed: true }
    );
    expect(
      authorizeHeldRights(accessWith(admin, [], ["workflow.publish"]), reading, lends)
    ).toEqual({
      allowed: false,
      action: "connection.read",
      reason: "outside_key_scope",
      message:
        "The API key of this call does not cover 'connection.read' on an asset this call may not read, and 'Monthly check' would act with it. Only a holder of a right gives or lends it: use a key whose scopes name it"
    });
    // No scope of a personal key names `connection.use`: a call with a key lends it to nobody.
    expect(
      authorizeHeldRights(accessWith(admin, [], ["workflow.publish"]), rights, lends)
    ).toMatchObject({ allowed: false, action: "connection.use", reason: "outside_key_scope" });
  });

  it("asks a legacy key on the whole instance, and throws FORBIDDEN with the first unheld right", () => {
    const keys: HeldRight[] = [{ action: "users.manage" }, ...rights];
    let thrown: unknown;
    try {
      requireHeldRights(accessWith(["user"], [row({})]), keys, lends);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      code: "FORBIDDEN",
      details: { action: "users.manage", reason: "no_grant" }
    });
    expect(thrown).toMatchObject({
      message:
        "This call does not hold 'users.manage' on the whole instance, and 'Monthly check' would act with it. Only a holder of a right gives or lends it"
    });
    expect(() => requireHeldRights(accessWith(["user", "admin"], []), keys, lends)).not.toThrow();
  });
});
