import { describe, expect, it } from "vitest";
import {
  constrainCredentialScopes,
  copyStateFor,
  DEFAULT_SERVICE_PRINCIPAL_PERMISSIONS,
  expiryInputToIso,
  isCredentialActive,
  optionalTrimmedValue,
  scopesAllowedByPermissions
} from "../packages/chat-ui/src/control-plane/api-access-model";
import {
  createApiAccessAuthorityKey,
  createApiAccessRevealController
} from "../packages/chat-ui/src/control-plane/api-access-reveal-controller";
import {
  canManageApiAccess,
  canViewAdministrationPanel
} from "../packages/chat-ui/src/control-plane/governance";
import { resolveAdministrationRoute } from "../packages/chat-ui/src/control-plane/superadmin-panel";
import {
  workspaceRouteFromPath,
  workspaceRouteNavigation
} from "../packages/chat-ui/src/standalone-chat-app";

describe("API access model", () => {
  it("maps only current service-principal grants to credential scopes", () => {
    expect(DEFAULT_SERVICE_PRINCIPAL_PERMISSIONS).toEqual(["config_assets.read"]);
    expect(scopesAllowedByPermissions(["config_assets.read"])).toEqual(["config_assets:read"]);
    expect(
      constrainCredentialScopes(
        ["config_assets:read", "config_assets:release"],
        ["config_assets.read"]
      )
    ).toEqual(["config_assets:read"]);
  });

  it("normalizes optional form values and local expiry input", () => {
    expect(optionalTrimmedValue("  Catalyst CLI  ")).toBe("Catalyst CLI");
    expect(optionalTrimmedValue("  ")).toBeUndefined();
    expect(expiryInputToIso("2030-01-02T12:00")).toBe(new Date("2030-01-02T12:00").toISOString());
    expect(expiryInputToIso("")).toBeUndefined();
  });

  it("treats revoked and expired credentials as inactive", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    expect(isCredentialActive({}, now)).toBe(true);
    expect(isCredentialActive({ expiresAt: "2029-12-31T23:59:59Z" }, now)).toBe(false);
    expect(isCredentialActive({ revokedAt: "2029-01-01T00:00:00Z" }, now)).toBe(false);
  });

  it("makes API access visible only through its dedicated permission", () => {
    const apiAccessManager = {
      id: "user-1",
      clientInstanceId: "client-1",
      authSource: "standalone",
      externalUserId: "manager",
      displayLabel: "Manager",
      roles: ["superadmin"],
      permissionRefs: [],
      permissions: ["api_access.manage"]
    } as Parameters<typeof canManageApiAccess>[0];

    expect(canManageApiAccess(apiAccessManager)).toBe(true);
    expect(canViewAdministrationPanel(apiAccessManager)).toBe(true);
    expect(canManageApiAccess({ ...apiAccessManager!, permissions: ["users.manage"] })).toBe(false);
  });

  it("round-trips the dedicated API access administration route", () => {
    expect(workspaceRouteFromPath("/admin/api-access")).toEqual({
      kind: "superadmin",
      tab: "api-access"
    });
    expect(workspaceRouteNavigation({ kind: "superadmin", tab: "api-access" })).toEqual({
      to: "/admin/api-access"
    });
  });

  it("resolves administration availability and tabs inside the optional module", () => {
    const manager = {
      id: "user-1",
      clientInstanceId: "client-1",
      authSource: "standalone",
      externalUserId: "manager",
      displayLabel: "Manager",
      roles: ["admin"],
      permissionRefs: [],
      permissions: ["users.manage"]
    } as Parameters<typeof canManageApiAccess>[0];

    expect(
      resolveAdministrationRoute({
        user: manager,
        configAssetManagement: undefined,
        requestedTab: "audit"
      })
    ).toEqual({ canView: true, pending: false, selectedTab: "users" });
    expect(
      resolveAdministrationRoute({
        user: { ...manager!, permissions: ["config_assets.read"] },
        configAssetManagement: undefined,
        requestedTab: "config"
      })
    ).toEqual({ canView: false, pending: true, selectedTab: "config" });
    expect(
      resolveAdministrationRoute({
        user: { ...manager!, permissions: ["config_assets.read"] },
        configAssetManagement: {
          enabled: true,
          editableAgentFields: [],
          allowAgentCreation: false,
          allowAgentDeletion: false,
          allowDefaultAgentChange: false,
          allowSkillEditing: false
        },
        requestedTab: "config"
      })
    ).toEqual({ canView: true, pending: false, selectedTab: "config" });
    expect(
      resolveAdministrationRoute({
        user: { ...manager!, permissions: ["config_assets.read"] },
        configAssetManagement: {
          enabled: false,
          editableAgentFields: [],
          allowAgentCreation: false,
          allowAgentDeletion: false,
          allowDefaultAgentChange: false,
          allowSkillEditing: false
        },
        requestedTab: "config"
      })
    ).toEqual({ canView: false, pending: false, selectedTab: undefined });
  });

  it.each(["changed", "lost"] as const)(
    "discards a deferred credential reveal when authority is %s",
    async (transition) => {
      const authorityA = createApiAccessAuthorityKey({
        apiBaseUrl: "https://a.example.com",
        principalId: "user-a",
        canManageSuperadminAccess: true
      });
      const authorityB = createApiAccessAuthorityKey({
        apiBaseUrl: "https://b.example.com",
        principalId: "user-b",
        canManageSuperadminAccess: true
      });
      const controller = createApiAccessRevealController(authorityA);
      const originAuthority = controller.captureAuthority();
      let resolveResponse!: () => void;
      const responsePending = new Promise<void>((resolve) => {
        resolveResponse = resolve;
      });
      const completion = (async () => {
        await responsePending;
        return controller.accept(originAuthority, {
          secret: "cat_live_late",
          credentialName: "Late key",
          serverUrl: "https://a.example.com"
        });
      })();

      controller.updateAuthority(transition === "changed" ? authorityB : undefined);
      resolveResponse();

      await expect(completion).resolves.toBeUndefined();
    }
  );

  it("binds an accepted reveal to its origin authority and server", () => {
    const authority = createApiAccessAuthorityKey({
      apiBaseUrl: "https://a.example.com",
      principalId: "user-a",
      canManageSuperadminAccess: true
    });
    const controller = createApiAccessRevealController(authority);
    const originAuthority = controller.captureAuthority();

    expect(
      controller.accept(originAuthority, {
        secret: "cat_live_once",
        credentialName: "Laptop",
        serverUrl: "https://a.example.com"
      })
    ).toEqual({
      secret: "cat_live_once",
      credentialName: "Laptop",
      serverUrl: "https://a.example.com",
      authorityKey: authority
    });
  });

  it("rejects an old completion even if the same authority later returns", () => {
    const controller = createApiAccessRevealController("authority-a");
    const originAuthority = controller.captureAuthority();

    controller.updateAuthority("authority-b");
    controller.updateAuthority("authority-a");

    expect(
      controller.accept(originAuthority, {
        secret: "cat_live_old_session",
        credentialName: "Old session",
        serverUrl: "https://a.example.com"
      })
    ).toBeUndefined();
  });
});

describe("API key copy result", () => {
  it("is dropped when the dialog opens for another credential", () => {
    for (const state of [{ failed: true }, { copied: "key" as const }]) {
      const recorded = { secret: "cat_live_first", state };
      expect(copyStateFor(recorded, "cat_live_first")).toEqual(state);
      expect(copyStateFor(recorded, "cat_live_next")).toEqual({});
    }
    expect(copyStateFor(undefined, "cat_live_first")).toEqual({});
  });
});
