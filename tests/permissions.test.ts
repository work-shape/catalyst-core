import { describe, expect, it } from "vitest";
import {
  AppError,
  PERMISSIONS,
  hasPermission,
  requirePermission,
  resolveEffectivePermissions
} from "@vivd-catalyst/core";

describe("permissions", () => {
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
    expect(effective.size).toBe(PERMISSIONS.length - 4);
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
