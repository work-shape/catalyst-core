import { createElement } from "react";
import { ApiError, type EffectivePermissions, type Role } from "@work-shape/catalyst-api-client";
import {
  areaRightChoices,
  canEditRole,
  pendingApplyBlock,
  resetBlock,
  RolePage,
  RolesTab,
  roleAreaActions,
  roleAreaOf,
  roleGrantsByArea,
  rolesWithPending,
  roleWriteFailure,
  ROLE_AREAS,
  withAreaAllows,
  withoutGrant,
  type RoleEditor
} from "@work-shape/catalyst-chat-ui/access";
import { ACTIONS, ROLE_DEFAULT_ACTIONS } from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Instance > Access > Roles (AP-5b1): what the role list and a role's page offer, and to whom.

const nothing = () => undefined;
const never = async () => undefined;
const names = { workspace: () => undefined, asset: () => undefined };

function render(node: ReturnType<typeof createElement>, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
}

const allow = (action: string) => ({
  action,
  effect: "allow" as const,
  scopeKind: "instance" as const
});

function rights(actions: readonly string[]): EffectivePermissions {
  return {
    holderActive: true,
    items: actions.map((action) => ({ ...allow(action), source: "role" as const, roleId: "x" }))
  };
}

const admin: RoleEditor = { superadmin: false, rights: rights(ROLE_DEFAULT_ACTIONS.admin) };
const adminWithEdit: RoleEditor = {
  superadmin: false,
  rights: rights([...ROLE_DEFAULT_ACTIONS.admin, "roles.edit_built_in"])
};
const root: RoleEditor = { superadmin: true, rights: rights(ROLE_DEFAULT_ACTIONS.superadmin) };

function builtIn(id: "user" | "admin" | "superadmin", extra: Partial<Role> = {}): Role {
  const grants = ROLE_DEFAULT_ACTIONS[id].map(allow);
  return {
    id,
    name: id,
    builtIn: true,
    editable: id !== "superadmin",
    grants,
    defaultGrants: grants,
    equalsDefault: true,
    pendingActions: [],
    ...extra
  };
}

const reviewers: Role = {
  id: "role_reviewers",
  name: "Reviewers",
  description: "Read the audit log",
  builtIn: false,
  editable: true,
  grants: [allow("audit.view"), { action: "usage.view", effect: "deny", scopeKind: "instance" }],
  pendingActions: []
};

const writes = {
  onCreate: async () => reviewers,
  onUpdate: never,
  onDelete: never,
  onReset: never,
  onDecide: never
};

describe("the role model", () => {
  it("puts every action a role can hold in exactly one area of the User screen's grouping", () => {
    const placed = ROLE_AREAS.flatMap((area) => roleAreaActions(area));
    expect([...placed].sort()).toEqual(ACTIONS.filter((a) => a !== "assets.release").sort());
    expect(roleAreaOf("roles.edit_built_in")).toBe("roles");
    expect(roleAreaOf("builder")).toBe("workspace");
    expect(roleAreaOf("agent.use")).toBe("agent");
    expect(roleAreaOf("users.manage")).toBe("administration");
    expect(ROLE_AREAS.at(-1)).toBe("administration");
  });

  it("groups a role's grants by area and place, the whole instance first", () => {
    const areas = roleGrantsByArea([
      { action: "agent.use", effect: "allow", scopeKind: "workspace", scopeId: "ws-1" },
      allow("agent.read"),
      { action: "agent.use", effect: "allow", scopeKind: "asset", scopeId: "agent-1" }
    ]);
    expect(areas.map((area) => area.area)).toEqual([...ROLE_AREAS]);
    const agents = areas.find((area) => area.area === "agent");
    expect(agents?.places.map((place) => place.place)).toEqual([
      { scopeKind: "instance" },
      { scopeKind: "workspace", scopeId: "ws-1" },
      { scopeKind: "asset", scopeId: "agent-1", scopeAsset: { kind: "agent", active: true } }
    ]);
  });

  it("lets user and admin be edited only with roles.edit_built_in, and superadmin never", () => {
    const user = builtIn("user");
    expect(canEditRole(user, admin)).toBe(false);
    expect(canEditRole(reviewers, admin)).toBe(true);
    expect(canEditRole(user, adminWithEdit)).toBe(true);
    expect(canEditRole(builtIn("admin"), adminWithEdit)).toBe(true);
    expect(canEditRole(builtIn("superadmin"), root)).toBe(false);
    expect(canEditRole(user, root)).toBe(true);
    expect(canEditRole(reviewers, { superadmin: false, rights: rights(["usage.view"]) })).toBe(
      false
    );
  });

  it("offers a right to tick only to who holds it, a superadmin's right only to a superadmin", () => {
    const narrow: RoleEditor = {
      superadmin: false,
      rights: rights(["users.manage", "roles.edit_built_in", "usage.view"])
    };
    const choices = new Map(
      areaRightChoices("administration", reviewers.grants, narrow).map((c) => [c.action, c])
    );
    // Held: tickable. Ticked already: may be unticked although not held.
    expect(choices.get("users.manage")).toEqual({ action: "users.manage", checked: false });
    expect(choices.get("audit.view")).toEqual({ action: "audit.view", checked: true });
    expect(choices.get("service_principals.manage")?.lock).toBe("notHeld");
    expect(choices.get("api_access.manage")?.lock).toBe("superadminOnly");
    expect(choices.get("usage.view")?.lock).toBe("refusedByRole");
    expect(
      areaRightChoices("administration", [], root).find((c) => c.action === "api_access.manage")
    ).toEqual({ action: "api_access.manage", checked: false });
  });

  it("holds back a reset or an applied release change the server would refuse, and says why", () => {
    const narrow: RoleEditor = {
      superadmin: false,
      rights: rights(["users.manage", "roles.edit_built_in", "audit.view"])
    };
    const deny = (action: string) => ({ ...allow(action), effect: "deny" as const });
    const narrowed = builtIn("admin", {
      grants: [allow("audit.view"), deny("usage.view")],
      equalsDefault: false
    });
    // A reset gives back every default allow and lifts the deny: it needs what it gives.
    expect(resetBlock(narrowed, narrow)).toMatchObject({ kind: "needsRight" });
    expect(
      resetBlock(builtIn("user", { grants: [deny("usage.view")], equalsDefault: false }), narrow)
    ).toEqual({ kind: "needsRight", action: "usage.view" });
    expect(resetBlock(narrowed, adminWithEdit)).toBeUndefined();
    // Taking away a right only a superadmin hands out is a superadmin's, also by a reset.
    const widened = builtIn("admin", {
      grants: [...ROLE_DEFAULT_ACTIONS.admin.map(allow), allow("api_access.manage")],
      equalsDefault: false
    });
    expect(resetBlock(widened, adminWithEdit)).toEqual({ kind: "superadminOnly" });
    expect(resetBlock(widened, root)).toBeUndefined();
    expect(resetBlock(reviewers, narrow)).toBeUndefined();

    const added = (action: string) => ({ action, change: "added" as const });
    const removed = (action: string) => ({ action, change: "removed" as const });
    expect(pendingApplyBlock(narrowed, added("usage.view"), narrow)).toEqual({
      kind: "needsRight",
      action: "usage.view"
    });
    expect(pendingApplyBlock(narrowed, added("usage.view"), adminWithEdit)).toBeUndefined();
    expect(pendingApplyBlock(narrowed, added("agent_models.manage"), adminWithEdit)).toEqual({
      kind: "superadminOnly"
    });
    expect(pendingApplyBlock(narrowed, added("agent_models.manage"), root)).toBeUndefined();
    // A removal takes only the allow away and leaves a deny: nothing to hold for it.
    expect(pendingApplyBlock(narrowed, removed("audit.view"), narrow)).toBeUndefined();
    expect(pendingApplyBlock(narrowed, removed("usage.view"), narrow)).toBeUndefined();
    expect(pendingApplyBlock(widened, removed("api_access.manage"), adminWithEdit)).toEqual({
      kind: "superadminOnly"
    });
  });

  it("replaces only the area's instance-wide allows, and keeps refusals and places", () => {
    const grants = [
      allow("audit.view"),
      allow("agent.use"),
      { action: "usage.view", effect: "deny" as const, scopeKind: "instance" as const },
      {
        action: "users.manage",
        effect: "allow" as const,
        scopeKind: "workspace" as const,
        scopeId: "ws"
      }
    ];
    expect(withAreaAllows(grants, "administration", ["users.manage"])).toEqual([
      allow("agent.use"),
      { action: "usage.view", effect: "deny", scopeKind: "instance" },
      { action: "users.manage", effect: "allow", scopeKind: "workspace", scopeId: "ws" },
      allow("users.manage")
    ]);
    expect(
      withoutGrant(grants, { action: "usage.view", effect: "deny", scopeKind: "instance" })
    ).toEqual([allow("audit.view"), allow("agent.use"), grants[3]]);
  });

  it("reads a role write's refusal", () => {
    const refusal = (status: number, code: string, details?: Record<string, unknown>) =>
      new ApiError(status, "refused", { error: { code, message: "refused", details } });
    expect(roleWriteFailure(refusal(409, "CONFLICT", { reason: "role_name_taken" }))).toEqual({
      kind: "nameTaken"
    });
    expect(roleWriteFailure(refusal(409, "CONFLICT", { reason: "role_in_use" }))).toEqual({
      kind: "inUse"
    });
    expect(
      roleWriteFailure(
        refusal(403, "FORBIDDEN", { action: "roles.edit_built_in", reason: "no_grant" })
      )
    ).toEqual({ kind: "needsRight", action: "roles.edit_built_in" });
    expect(
      roleWriteFailure(refusal(403, "FORBIDDEN", { action: "roles.update", reason: "no_grant" }))
    ).toEqual({ kind: "superadminOnly" });
    expect(roleWriteFailure(new Error("offline"))).toEqual({ kind: "other" });
  });
});

describe("the role list", () => {
  const roles = [
    builtIn("user"),
    builtIn("admin", {
      equalsDefault: false,
      pendingActions: [{ action: "usage.view", change: "added" }]
    }),
    builtIn("superadmin"),
    reviewers
  ];

  it("lists the built-in roles first, then the custom ones, in German", () => {
    const html = render(
      createElement(RolesTab, {
        ...writes,
        roles,
        loadFailed: false,
        onRetry: nothing,
        editor: admin,
        selectedRoleId: undefined,
        onSelect: nothing,
        names
      }),
      "de"
    );
    const order = ["Benutzer", "Admin", "Superadmin", "Reviewers"].map((label) =>
      html.indexOf(label)
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Neue Rolle");
    expect(html).toContain("Schreibgeschützt");
    expect(html).toContain("Geändert");
    expect(html).toContain("1 neues Recht zu entscheiden");
    expect(html).toContain("Aktionen für Reviewers");
    expect(html).not.toContain("Aktionen für Benutzer");
    expect(rolesWithPending(roles).map((role) => role.id)).toEqual(["admin"]);
  });

  it("offers no new role and no menu to who cannot write roles", () => {
    const html = render(
      createElement(RolesTab, {
        ...writes,
        roles,
        loadFailed: false,
        onRetry: nothing,
        editor: { superadmin: false, rights: rights(["usage.view"]) },
        selectedRoleId: undefined,
        onSelect: nothing,
        names
      })
    );
    expect(html).toMatch(/type="button" disabled=""><svg[^>]*lucide-plus[\s\S]*?<\/svg>New role/u);
    expect(html).not.toContain("Actions for Reviewers");
  });
});

describe("a role's page", () => {
  const page = (role: Role, editor: RoleEditor, locale: "en" | "de" = "en") =>
    render(
      createElement(RolePage, {
        role,
        editor,
        names,
        onBack: nothing,
        onRename: nothing,
        onDelete: nothing,
        onUpdate: never,
        onReset: never,
        onDecide: never
      }),
      locale
    );

  it("shows superadmin read-only, its rights in sentences by area", () => {
    const html = page(builtIn("superadmin"), root, "de");
    expect(html).toContain("Schreibgeschützt");
    expect(html).not.toContain("Bearbeiten");
    expect(html).not.toContain("Auf Standard zurücksetzen");
    expect(html).toContain("Verwaltung");
    expect(html).toContain("Eingebaute Rollen Benutzer und Admin bearbeiten");
  });

  it("shows user to an admin without the right as a view that names the right to ask for", () => {
    const html = page(builtIn("user"), admin, "de");
    expect(html).toContain(
      "Du kannst diese Rolle ansehen. Um sie zu ändern, brauchst du das Recht „Eingebaute Rollen Benutzer und Admin bearbeiten“."
    );
    expect(html).not.toContain("Bearbeiten</");
    expect(html).not.toContain("Auf Standard zurücksetzen");
  });

  it("lets a holder of the right edit and reset user, and decide what a release brought", () => {
    const html = page(
      builtIn("admin", {
        equalsDefault: false,
        pendingActions: [
          { action: "usage.view", change: "added" },
          { action: "audit.view", change: "removed" }
        ]
      }),
      adminWithEdit,
      "de"
    );
    expect(html).toContain("Auf Standard zurücksetzen");
    expect(html).toContain("Eine Änderung gilt sofort für alle, die diese Rolle haben.");
    expect(html).toContain("1 Recht ist neu in diesem Release und nicht in dieser Rolle");
    expect(html).toContain("Hinzufügen");
    expect(html).toContain("Weglassen");
    expect(html).toContain("Entfernen");
    expect(html).toContain("Behalten");
    expect(html).toContain("Rechte für Verwaltung bearbeiten");
  });

  it("holds back Reset and Add where the server would refuse them, with the reason", () => {
    const html = page(
      builtIn("admin", {
        grants: [...ROLE_DEFAULT_ACTIONS.admin.map(allow), allow("api_access.manage")],
        equalsDefault: false,
        pendingActions: [
          { action: "agent_models.manage", change: "added" },
          { action: "audit.view", change: "removed" }
        ]
      }),
      adminWithEdit,
      "de"
    );
    expect(html).toContain('data-testid="role-reset-blocked"');
    const row = (action: string) =>
      html.split(`data-action="${action}"`)[1]?.split('data-testid="role-pending-action"')[0] ?? "";
    expect(row("agent_models.manage")).toContain(
      "Nur Superadmins vergeben oder entziehen dieses Recht."
    );
    expect(row("agent_models.manage")).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Hinzufügen/);
    expect(row("audit.view")).not.toContain("Nur Superadmins");
    expect(row("audit.view")).not.toContain('disabled=""');
    expect(page(builtIn("admin", { equalsDefault: false }), root)).not.toContain(
      "role-reset-blocked"
    );
  });

  it("says a custom role's refusals as refusals", () => {
    const html = page(reviewers, admin);
    expect(html).toContain("Reviewers");
    expect(html).toContain('data-effect="deny"');
    expect(html).toContain("Actions for Reviewers");
    expect(html).not.toContain("Reset to default");
  });
});
