import { describe, expect, it } from "vitest";
import { resolveEffectivePermissions } from "./support/ap4-verify/pre-ap4-permissions";
import {
  type PlatformAction,
  type Permission,
  ACTIONS,
  GRANTABLE_ACTION_SCOPES,
  operationScopesOfPersonalApiKey,
  LEGACY_PERMISSION_ACTIONS,
  PERMISSIONS,
  ROLE_DEFAULT_ACTIONS,
  legacyPermissionFor
} from "@work-shape/catalyst-core";

describe("permissions", () => {
  it("grants agent publishing at workspace or asset scope and carries it in a personal key (Access 45)", () => {
    expect(GRANTABLE_ACTION_SCOPES["agent.publish"]).toEqual(["workspace", "asset"]);
    expect(operationScopesOfPersonalApiKey(["agent.publish"])).toContain("config_assets:publish");
    expect(operationScopesOfPersonalApiKey(["agent.write"])).not.toContain("config_assets:publish");
  });
  it("maps each action a legacy key names to exactly one of the nine legacy keys", () => {
    expect(ACTIONS).toEqual([
      "agent.read",
      "agent.write",
      "agent.publish",
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
      "data_store.records",
      "knowledge_base.read",
      "knowledge_base.write",
      "knowledge_base.publish",
      "knowledge_base.delete",
      "knowledge_base.use",
      "mail_sender.use",
      "guardrail.read",
      "guardrail.write",
      "guardrail.publish",
      "guardrail.delete",
      "operations.approve",
      "feedback.review",
      "users.manage",
      "usage.view",
      "audit.view",
      "api_access.manage",
      "service_principals.manage",
      "agent_models.manage",
      "assets.release",
      "builder",
      "publisher"
    ]);
    // The rights of a Connection, an App, a Workflow, a Data Store, a Knowledge Base, a Guardrail
    // and a mail sender came after the legacy keys, as did the right over service principals and
    // the two bundles: no key names one, so nobody holds one through the legacy column.
    const unkeyed = (action: string) =>
      /^(?:connection|app|workflow|data_store|knowledge_base|guardrail|mail_sender)\./u.test(
        action
      ) ||
      action === "service_principals.manage" ||
      action === "feedback.review" ||
      action === "agent.publish" ||
      action === "builder" ||
      action === "publisher";
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
      "agent.publish",
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
      "data_store.records",
      "knowledge_base.read",
      "knowledge_base.write",
      "knowledge_base.publish",
      "knowledge_base.delete",
      "knowledge_base.use",
      "mail_sender.use",
      "guardrail.read",
      "guardrail.write",
      "guardrail.publish",
      "guardrail.delete",
      "operations.approve",
      "feedback.review",
      "users.manage",
      "usage.view",
      "audit.view",
      "service_principals.manage",
      // Instance admins hold Builder and Publisher in every workspace by default [P36].
      "builder",
      "publisher"
    ]);
    expect(ROLE_DEFAULT_ACTIONS.superadmin).toEqual(
      ACTIONS.filter((action) => action !== "assets.release")
    );
    for (const role of ["user", "admin", "superadmin"] as const) {
      expect(
        PERMISSIONS.filter((permission) =>
          LEGACY_PERMISSION_ACTIONS[permission].every((action) =>
            ROLE_DEFAULT_ACTIONS[role].includes(action)
          )
        )
      ).toEqual([...resolveEffectivePermissions({ roles: [role], permissions: [] })]);
    }
  });
});
