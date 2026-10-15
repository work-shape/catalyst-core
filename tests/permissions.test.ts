import { describe, expect, it } from "vitest";
import {
  type PlatformAction,
  type Permission,
  ACTIONS,
  LEGACY_PERMISSION_ACTIONS,
  PERMISSIONS,
  ROLE_DEFAULT_ACTIONS,
  ROLE_DEFAULT_PERMISSIONS,
  hasPermission,
  legacyPermissionFor,
  resolveEffectivePermissions
} from "@work-shape/catalyst-core";

describe("permissions", () => {
  it("maps each action a legacy key names to exactly one of the nine legacy keys", () => {
    expect(ACTIONS).toEqual([
      "agent.read",
      "agent.write",
      "agent.delete",
      "skill.read",
      "skill.write",
      "skill.delete",
      "skill.approve",
      "connection.read",
      "connection.use",
      "connection.write",
      "connection.delete",
      "connection.approve",
      "app.read",
      "app.write",
      "app.publish",
      "app.approve",
      "app.delete",
      "app.use",
      "workflow.read",
      "workflow.write",
      "workflow.publish",
      "workflow.approve",
      "workflow.delete",
      "workflow.use",
      "workflow.read_run_data",
      "data_store.read",
      "data_store.write",
      "data_store.publish",
      "data_store.delete",
      "data_store.insert",
      "data_store.execute",
      "knowledge_base.read",
      "knowledge_base.write",
      "knowledge_base.publish",
      "knowledge_base.delete",
      "knowledge_base.use",
      "guardrail.read",
      "guardrail.write",
      "guardrail.publish",
      "guardrail.delete",
      "operations.approve",
      "users.manage",
      "usage.view",
      "audit.view",
      "api_access.manage",
      "service_principals.manage",
      "agent_models.manage",
      "assets.release"
    ]);
    // The rights of a Connection, an App, a Workflow, a Data Store, a Knowledge Base and a Guardrail came
    // after the legacy keys, as did the right over service principals: no key names one, so
    // nobody holds one through the legacy column.
    const unkeyed = (action: string) =>
      /^(?:connection|app|workflow|data_store|knowledge_base|guardrail)\./u.test(action) ||
      action === "service_principals.manage";
    const keyed = ACTIONS.filter((action) => !unkeyed(action));
    expect(keyed).toHaveLength(14);
    for (const action of ACTIONS.filter(unkeyed)) {
      expect(() => legacyPermissionFor(action), action).toThrow("No legacy permission");
    }
    expect(Object.keys(LEGACY_PERMISSION_ACTIONS).sort()).toEqual([...PERMISSIONS].sort());
    expect(Object.values(LEGACY_PERMISSION_ACTIONS).flat().sort()).toEqual([...keyed].sort());
    for (const action of keyed) {
      const keys = PERMISSIONS.filter((permission) =>
        LEGACY_PERMISSION_ACTIONS[permission].some((candidate) => candidate === action)
      );
      expect(keys, action).toEqual([legacyPermissionFor(action)]);
    }
    expect(LEGACY_PERMISSION_ACTIONS).toEqual({
      "agent_skills.approve": ["skill.approve", "operations.approve"],
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
      "connection.read",
      "connection.use",
      "connection.write",
      "connection.delete",
      "connection.approve",
      "app.read",
      "app.write",
      "app.publish",
      "app.approve",
      "app.delete",
      "app.use",
      "workflow.read",
      "workflow.write",
      "workflow.publish",
      "workflow.approve",
      "workflow.delete",
      "workflow.use",
      "workflow.read_run_data",
      "data_store.read",
      "data_store.write",
      "data_store.publish",
      "data_store.delete",
      "data_store.insert",
      "data_store.execute",
      "knowledge_base.read",
      "knowledge_base.write",
      "knowledge_base.publish",
      "knowledge_base.delete",
      "knowledge_base.use",
      "guardrail.read",
      "guardrail.write",
      "guardrail.publish",
      "guardrail.delete",
      "operations.approve",
      "users.manage",
      "usage.view",
      "audit.view",
      "service_principals.manage"
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
      // The legacy keys of a role name what they named: a right of a later kind has no key.
      expect(
        new Set(
          ROLE_DEFAULT_ACTIONS[role]
            .filter(
              (action) =>
                !/^(?:connection|app|workflow|data_store|knowledge_base|guardrail)\./u.test(
                  action
                ) && action !== "service_principals.manage"
            )
            .map(legacyPermissionFor)
        )
      ).toEqual(new Set(ROLE_DEFAULT_PERMISSIONS[role]));
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

  it("checks permissions", () => {
    const subject = {
      roles: ["user"],
      permissions: ["usage.view"]
    };

    expect(hasPermission(subject, "usage.view")).toBe(true);
    expect(hasPermission(subject, "audit.view")).toBe(false);
  });
});
