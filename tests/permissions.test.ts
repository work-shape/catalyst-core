import { describe, expect, it } from "vitest";
import {
  AppError,
  type PlatformAction,
  type Permission,
  ACTIONS,
  LEGACY_PERMISSION_ACTIONS,
  PERMISSIONS,
  ROLE_DEFAULT_ACTIONS,
  ROLE_DEFAULT_PERMISSIONS,
  hasPermission,
  legacyPermissionFor,
  requirePermission,
  resolveEffectivePermissions
} from "@vivd-catalyst/core";

describe("permissions", () => {
  it("maps each of the thirteen actions to exactly one of the nine legacy keys", () => {
    expect(ACTIONS).toEqual([
      "agent.read",
      "agent.write",
      "agent.delete",
      "skill.read",
      "skill.write",
      "skill.delete",
      "skill.approve",
      "users.manage",
      "usage.view",
      "audit.view",
      "api_access.manage",
      "agent_models.manage",
      "assets.release"
    ]);
    expect(Object.keys(LEGACY_PERMISSION_ACTIONS).sort()).toEqual([...PERMISSIONS].sort());
    expect(Object.values(LEGACY_PERMISSION_ACTIONS).flat().sort()).toEqual([...ACTIONS].sort());
    for (const action of ACTIONS) {
      const keys = PERMISSIONS.filter((permission) =>
        LEGACY_PERMISSION_ACTIONS[permission].some((candidate) => candidate === action)
      );
      expect(keys, action).toEqual([legacyPermissionFor(action)]);
    }
    expect(LEGACY_PERMISSION_ACTIONS).toEqual({
      "agent_skills.approve": ["skill.approve"],
      "config_assets.read": ["agent.read", "skill.read"],
      "config_assets.write": ["agent.write", "agent.delete", "skill.write", "skill.delete"],
      "config_assets.release": ["assets.release"],
      "usage.view": ["usage.view"],
      "users.manage": ["users.manage"],
      "api_access.manage": ["api_access.manage"],
      "agent_models.manage": ["agent_models.manage"],
      "audit.view": ["audit.view"]
    });
  });

  it.each([
    ["agent.read", "config_assets.read"],
    ["agent.write", "config_assets.write"],
    ["agent.delete", "config_assets.write"],
    ["skill.read", "config_assets.read"],
    ["skill.write", "config_assets.write"],
    ["skill.delete", "config_assets.write"],
    ["skill.approve", "agent_skills.approve"],
    ["users.manage", "users.manage"],
    ["usage.view", "usage.view"],
    ["audit.view", "audit.view"],
    ["api_access.manage", "api_access.manage"],
    ["agent_models.manage", "agent_models.manage"],
    ["assets.release", "config_assets.release"]
  ] satisfies [PlatformAction, Permission][])("maps %s to %s", (action, permission) => {
    expect(legacyPermissionFor(action)).toBe(permission);
  });

  // An invalid string cannot honestly inhabit the closed PlatformAction union.
  // The unmapped-action branch requires an unsafe cast or an untyped boundary.

  it("derives unchanged legacy role defaults from the canonical actions", () => {
    expect(ROLE_DEFAULT_ACTIONS.user).toEqual([]);
    expect(ROLE_DEFAULT_ACTIONS.admin).toEqual([
      "agent.read",
      "agent.write",
      "agent.delete",
      "skill.read",
      "skill.write",
      "skill.delete",
      "skill.approve",
      "users.manage",
      "usage.view",
      "audit.view"
    ]);
    expect(ROLE_DEFAULT_ACTIONS.superadmin).toEqual(
      ACTIONS.filter((action) => action !== "assets.release")
    );
    expect(ROLE_DEFAULT_PERMISSIONS.user).toEqual([]);
    expect(ROLE_DEFAULT_PERMISSIONS.admin).toEqual([
      "agent_skills.approve",
      "config_assets.read",
      "config_assets.write",
      "usage.view",
      "users.manage",
      "audit.view"
    ]);
    expect(ROLE_DEFAULT_PERMISSIONS.superadmin).toEqual(
      PERMISSIONS.filter((permission) => permission !== "config_assets.release")
    );
    for (const role of ["user", "admin", "superadmin"] as const) {
      expect(new Set(ROLE_DEFAULT_ACTIONS[role].map(legacyPermissionFor))).toEqual(
        new Set(ROLE_DEFAULT_PERMISSIONS[role])
      );
    }
  });

  it("unions defaults across known roles and ignores unknown roles", () => {
    const effective = resolveEffectivePermissions({
      roles: ["user", "custom-role", "admin", "superadmin"],
      permissions: []
    });

    expect(effective).toEqual(
      new Set(PERMISSIONS.filter((permission) => permission !== "config_assets.release"))
    );
  });

  it("applies grants and revocations while ignoring unknown permission entries", () => {
    const effective = resolveEffectivePermissions({
      roles: ["user", "admin"],
      permissions: [
        "usage.view",
        "!audit.view",
        "!usage.view",
        "unknown.permission",
        "!unknown.permission"
      ]
    });

    expect(effective.has("config_assets.read")).toBe(true);
    expect(effective.has("audit.view")).toBe(false);
    expect(effective.has("usage.view")).toBe(false);
    expect(effective.has("config_assets.release")).toBe(false);
    expect(effective.has("api_access.manage")).toBe(false);
    expect(effective.has("agent_models.manage")).toBe(false);
    expect(effective.size).toBe(PERMISSIONS.length - 5);
  });

  it("gives agent model settings to superadmins by default and to others only by grant", () => {
    expect(hasPermission({ roles: ["superadmin"], permissions: [] }, "agent_models.manage")).toBe(
      true
    );
    expect(hasPermission({ roles: ["admin"], permissions: [] }, "agent_models.manage")).toBe(false);
    expect(
      hasPermission(
        { roles: ["admin"], permissions: ["agent_models.manage"] },
        "agent_models.manage"
      )
    ).toBe(true);
  });

  it("allows per-user grants for roles without defaults", () => {
    const effective = resolveEffectivePermissions({
      roles: ["user", "external-reviewer"],
      permissions: ["usage.view"]
    });

    expect([...effective]).toEqual(["usage.view"]);
  });

  it("requires an explicit grant for release synchronization", () => {
    const effective = resolveEffectivePermissions({
      roles: ["superadmin"],
      permissions: ["config_assets.release"]
    });

    expect(effective.has("config_assets.release")).toBe(true);
    expect(effective.has("api_access.manage")).toBe(true);
  });

  it("checks and requires permissions", () => {
    const subject = {
      roles: ["user"],
      permissions: ["usage.view"]
    };

    expect(hasPermission(subject, "usage.view")).toBe(true);
    expect(hasPermission(subject, "audit.view")).toBe(false);
    expect(() => requirePermission(subject, "usage.view")).not.toThrow();
    expect(() => requirePermission(subject, "audit.view")).toThrowError(
      new AppError("FORBIDDEN", "Missing permission 'audit.view'")
    );
  });
});
