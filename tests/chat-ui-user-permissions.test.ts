import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdministeredUser } from "@vivd-catalyst/api-client";
import { resolveEffectivePermissions, type Permission } from "@vivd-catalyst/core";
import { describe, expect, it } from "vitest";
import {
  USER_PERMISSIONS,
  setUserPermission,
  userPermissionCopy,
  userPermissionStates
} from "../packages/chat-ui/src/control-plane/user-administration-model";
import { UserPermissionOverview } from "../packages/chat-ui/src/control-plane/user-permission-overview";
import { UserPermissionsCard } from "../packages/chat-ui/src/control-plane/user-permissions-card";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";

function user(overrides: Partial<AdministeredUser> = {}): AdministeredUser {
  return {
    id: "user-1",
    clientInstanceId: "client-1",
    displayLabel: "Anna Beispiel",
    roles: ["user"],
    permissionRefs: [],
    permissions: [],
    status: "active",
    createdAt: "2026-10-01T08:00:00Z",
    updatedAt: "2026-10-01T08:00:00Z",
    identities: [],
    ...overrides
  };
}

function stateOf(subject: AdministeredUser, permission: Permission) {
  return userPermissionStates(subject).find((state) => state.permission === permission);
}

describe("user permission model", () => {
  it("offers every typed permission except the release permission of service tokens", () => {
    expect(USER_PERMISSIONS).toContain("agent_skills.approve");
    expect(USER_PERMISSIONS).not.toContain("config_assets.release");
    for (const permission of USER_PERMISSIONS) {
      expect(userPermissionCopy(permission), permission).toBeDefined();
    }
  });

  it("names where a permission comes from", () => {
    const admin = user({ roles: ["user", "admin"], permissions: ["!audit.view"] });
    const member = user({ permissions: ["agent_skills.approve"] });

    expect(stateOf(admin, "agent_skills.approve")).toMatchObject({ held: true, source: "role" });
    expect(stateOf(admin, "audit.view")).toMatchObject({ held: false, source: "revoked" });
    expect(stateOf(admin, "api_access.manage")).toMatchObject({ held: false, source: "none" });
    expect(stateOf(member, "agent_skills.approve")).toMatchObject({
      held: true,
      source: "granted"
    });
  });

  it("agrees with the effective permissions the server resolves", () => {
    const subjects = [
      user(),
      user({ permissions: ["agent_skills.approve", "!usage.view"] }),
      user({ roles: ["user", "admin"], permissions: ["!audit.view", "api_access.manage"] }),
      user({ roles: ["user", "admin", "superadmin"], permissions: ["!users.manage"] })
    ];

    for (const subject of subjects) {
      const effective = resolveEffectivePermissions(subject);
      for (const state of userPermissionStates(subject)) {
        expect(state.held, `${subject.roles.join("+")} ${state.permission}`).toBe(
          effective.has(state.permission)
        );
      }
    }
  });

  it("grants by adding the name and takes an individual grant away by removing it", () => {
    const member = user({ permissions: ["tool.custom"] });
    const granted = setUserPermission(member, "agent_skills.approve", true);

    expect(granted).toEqual(["tool.custom", "agent_skills.approve"]);
    expect(
      setUserPermission(user({ permissions: granted }), "agent_skills.approve", false)
    ).toEqual(["tool.custom"]);
  });

  it("revokes a role default with a ! entry and restores it by removing that entry", () => {
    const admin = user({ roles: ["user", "admin"] });
    const revoked = setUserPermission(admin, "agent_skills.approve", false);

    expect(revoked).toEqual(["!agent_skills.approve"]);
    expect(
      setUserPermission(
        user({ roles: ["user", "admin"], permissions: revoked }),
        "agent_skills.approve",
        true
      )
    ).toEqual([]);
  });

  it("replaces a redundant individual grant when a role default is revoked", () => {
    const admin = user({ roles: ["user", "admin"], permissions: ["usage.view", "audit.view"] });

    expect(setUserPermission(admin, "usage.view", false)).toEqual(["audit.view", "!usage.view"]);
  });

  it("grants over a stale revocation for a user whose role does not provide the permission", () => {
    const member = user({ permissions: ["!audit.view"] });

    expect(setUserPermission(member, "audit.view", true)).toEqual(["audit.view"]);
  });

  it("leaves the entries alone when nothing has to change", () => {
    const admin = user({ roles: ["user", "admin"], permissions: ["agent_skills.approve"] });

    expect(setUserPermission(admin, "agent_skills.approve", true)).toEqual([
      "agent_skills.approve"
    ]);
    expect(setUserPermission(user(), "audit.view", false)).toEqual([]);
  });
});

describe("user rights in the administration", () => {
  it("lists every right with its plain-language label, source and a toggle", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(UserPermissionsCard, {
          user: user({ roles: ["user", "admin"], permissions: ["!audit.view"] }),
          canManageSuperadminAccess: false,
          mutating: false,
          onUpdateUser: async () => user()
        })
      )
    );

    expect(markup).toContain("Rechte");
    expect(markup).toContain("Änderungen an Fähigkeiten freigeben");
    expect(markup).toContain("über Rolle");
    expect(markup).toContain("einzeln entzogen");
    expect(markup).toContain('aria-label="Auditprotokoll ansehen"');
    expect(markup).toContain("Dieses Recht können nur Superadmins vergeben.");
    expect(markup.match(/role="switch"/gu)).toHaveLength(USER_PERMISSIONS.length);
  });

  it("shows who may do what and tells role defaults from individual grants", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(UserPermissionOverview, {
          users: [
            user({ id: "admin", displayLabel: "Felix Pahlke", roles: ["user", "admin"] }),
            user({ id: "member", permissions: ["agent_skills.approve"] })
          ],
          onSelectUser: () => undefined
        })
      )
    );

    expect(markup).toContain("Felix Pahlke");
    expect(markup).toContain("Anna Beispiel");
    expect(markup).toContain("Änderungen an Fähigkeiten freigeben");
    expect(markup).toContain('<span class="sr-only">über Rolle</span>');
    expect(markup.match(/<span class="sr-only">einzeln vergeben<\/span>/gu)).toHaveLength(1);
    expect(markup).not.toContain('role="switch"');
  });
});
