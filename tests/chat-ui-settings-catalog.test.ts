import { describe, expect, it } from "vitest";
import type { ApiUser, CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import { createTranslationContext, type SettingsViewer } from "@vivd-catalyst/chat-ui";
import type { WorkspaceRoute } from "@vivd-catalyst/chat-ui/shell";
import { administration } from "@vivd-catalyst/chat-ui/admin";
import { workspaceRouteFromPath } from "../packages/chat-ui/src/routes";
import {
  firstAdministrationRoute,
  resolveSettingsRoute,
  settingsCatalog,
  settingsGoToTargets,
  visibleSettingsPages,
  type BuildAccess
} from "../packages/chat-ui/src/settings/catalog";
import { personalWorkspace, settingsUser, sharedWorkspace } from "./chat-ui-settings-fixtures";

const catalog = settingsCatalog(administration);
const buildOn: BuildAccess = { page: administration.build, enabled: true };
const buildOff: BuildAccess = { page: administration.build, enabled: false };

function viewer(
  user: Partial<ApiUser> = {},
  workspaces: CollaborationWorkspaceWithRole[] = [personalWorkspace()]
): SettingsViewer {
  return { user: settingsUser(user), workspaces };
}

function pageIds(of: SettingsViewer): string[] {
  return visibleSettingsPages(catalog, of).map((page) => `${page.group}/${page.id}`);
}

function resolve(path: string, of: SettingsViewer, build = buildOn, workspacesReady = true) {
  return resolveSettingsRoute({
    route: workspaceRouteFromPath(path),
    catalog,
    build,
    viewer: of,
    workspacesReady
  });
}

const you = ["you/profile", "you/language-appearance", "you/security"];
const workspace = ["workspace/general", "workspace/members"];
const instance = [
  "instance/users",
  "instance/access",
  "instance/api-access",
  "instance/usage",
  "instance/audit",
  "instance/jobs"
];

const member = viewer();
const workspaceOwner = viewer({}, [personalWorkspace(), sharedWorkspace()]);
const instanceAdmin = viewer(
  {
    roles: ["user", "admin"],
    permissions: ["users.manage", "api_access.manage", "usage.view", "audit.view"]
  },
  [personalWorkspace(), sharedWorkspace()]
);
// The server gives a superadmin the owner role in every shared workspace, member or not.
const superadminWithoutMembership = viewer(
  {
    roles: ["user", "admin", "superadmin"],
    permissions: [
      "users.manage",
      "api_access.manage",
      "usage.view",
      "audit.view",
      "config_assets.read"
    ]
  },
  [
    personalWorkspace(),
    sharedWorkspace({ id: "cw_a", membershipRole: null }),
    sharedWorkspace({ id: "cw_b", name: "Analytik", membershipRole: null })
  ]
);

describe("Settings catalog", () => {
  it("lists the pages of each group in the order of the navigation spec", () => {
    expect(catalog.map((page) => `${page.group}/${page.id}`)).toEqual([
      ...you,
      ...workspace,
      ...instance
    ]);
  });

  it("names every page and Build in both languages", () => {
    const en = createTranslationContext("en");
    const de = createTranslationContext("de");
    for (const page of [...catalog, administration.build]) {
      expect(en.t(page.labelKey)).not.toBe(page.labelKey);
      expect(de.t(page.labelKey)).not.toBe(page.labelKey);
    }
    expect(en.t("nav.build")).toBe("Build");
    expect(de.t("nav.build")).toBe("Bauen");
  });

  it.each<[key: string, pages: string[]]>([
    ["users.manage", ["instance/users", "instance/access"]],
    ["api_access.manage", ["instance/api-access"]],
    ["usage.view", ["instance/usage"]],
    ["audit.view", ["instance/audit", "instance/jobs"]]
  ])("shows the pages behind %s exactly to its holders", (permission, pages) => {
    expect(pageIds(viewer({ permissions: [permission] }))).toEqual([...you, ...pages]);
    for (const other of ["users.manage", "api_access.manage", "usage.view", "audit.view"]) {
      if (other !== permission) {
        for (const page of pages) {
          expect(pageIds(viewer({ permissions: [other] }))).not.toContain(page);
        }
      }
    }
  });

  it.each<[role: CollaborationWorkspaceWithRole["role"], shown: boolean]>([
    ["owner", true],
    ["admin", true],
    ["member", false]
  ])("shows the Workspace group to a shared workspace's %s: %s", (role, shown) => {
    const of = viewer({}, [personalWorkspace(), sharedWorkspace({ role, membershipRole: role })]);

    expect(pageIds(of)).toEqual(shown ? [...you, ...workspace] : you);
  });

  it("reads the role, not the membership, so a superadmin manages every shared workspace", () => {
    expect(pageIds(superadminWithoutMembership)).toEqual([...you, ...workspace, ...instance]);
  });

  it("leaves Security out where the password is kept elsewhere", () => {
    expect(pageIds(viewer({ authSource: "oidc" }))).toEqual([
      "you/profile",
      "you/language-appearance"
    ]);
  });

  it("shows Build to holders of config_assets.read while config assets are on", () => {
    const holder = viewer({ permissions: ["config_assets.read"] });

    expect(settingsGoToTargets(catalog, buildOn, holder).map((target) => target.id)).toContain(
      "build"
    );
    expect(settingsGoToTargets(catalog, buildOff, holder).map((target) => target.id)).not.toContain(
      "build"
    );
    expect(settingsGoToTargets(catalog, buildOn, member).map((target) => target.id)).not.toContain(
      "build"
    );
  });
});

describe("the four role views", () => {
  it.each<[name: string, of: SettingsViewer, pages: string[], build: boolean]>([
    ["member", member, you, false],
    ["workspace owner", workspaceOwner, [...you, ...workspace], false],
    ["instance admin", instanceAdmin, [...you, ...workspace, ...instance], false],
    [
      "superadmin without a membership",
      superadminWithoutMembership,
      [...you, ...workspace, ...instance],
      true
    ]
  ])(
    "gives a %s the rail and the Go to group of exactly their pages",
    (_name, of, pages, build) => {
      expect(pageIds(of)).toEqual(pages);
      expect(settingsGoToTargets(catalog, buildOn, of).map((target) => target.id)).toEqual([
        ...pages.map((page) => `settings/${page}`),
        ...(build ? ["build"] : [])
      ]);
    }
  );

  it("opens the gear on the first Instance page, else on General, else on Build", () => {
    expect(firstAdministrationRoute(catalog, buildOn, instanceAdmin)).toEqual({
      kind: "settings",
      group: "instance",
      page: "users"
    });
    expect(firstAdministrationRoute(catalog, buildOn, workspaceOwner)).toEqual({
      kind: "settings",
      group: "workspace",
      page: "general"
    });
    expect(
      firstAdministrationRoute(catalog, buildOn, viewer({ permissions: ["config_assets.read"] }))
    ).toEqual({ kind: "build" });
    expect(firstAdministrationRoute(catalog, buildOn, member)).toBeUndefined();
  });
});

describe("old addresses", () => {
  const page = (group: string, id: string) =>
    catalog.find((candidate) => candidate.group === group && candidate.id === id);

  it.each<[path: string, group: string, id: string]>([
    ["/settings", "you", "profile"],
    ["/admin/users", "instance", "users"],
    ["/admin/usage", "instance", "usage"],
    ["/admin/audit", "instance", "audit"],
    ["/admin/api-access", "instance", "api-access"]
  ])("lands %s on the page with the same content", (path, group, id) => {
    expect(resolve(path, superadminWithoutMembership)).toEqual({
      kind: "page",
      page: page(group, id)
    });
  });

  it("lands /admin/config on Build", () => {
    expect(resolve("/admin/config", superadminWithoutMembership)).toEqual({
      kind: "build",
      page: administration.build
    });
  });

  it("leads /admin to the first permitted Settings page, else to Build, else to chat", () => {
    const users: WorkspaceRoute = { kind: "settings", group: "instance", page: "users" };

    expect(resolve("/admin", instanceAdmin)).toEqual({ kind: "redirect", route: users });
    expect(resolve("/admin", viewer({ permissions: ["config_assets.read"] }))).toEqual({
      kind: "redirect",
      route: { kind: "build" }
    });
    expect(resolve("/admin", member)).toEqual({ kind: "chat" });
  });

  it("answers an administration address the viewer may not open as before", () => {
    const usageOnly = viewer({ permissions: ["usage.view"] });

    // The old panel fell back to the first tab the viewer had, and to chat with none.
    expect(resolve("/admin/users", usageOnly)).toEqual({
      kind: "redirect",
      route: { kind: "settings", group: "instance", page: "usage" }
    });
    expect(resolve("/admin/users", member)).toEqual({ kind: "chat" });
    expect(resolve("/admin/config", member)).toEqual({ kind: "chat" });
    expect(resolve("/admin/config", superadminWithoutMembership, buildOff)).toEqual({
      kind: "redirect",
      route: { kind: "settings", group: "instance", page: "users" }
    });
  });

  it("leads Security to Profile where the password cannot change", () => {
    expect(resolve("/settings/you/security", viewer({ authSource: "oidc" }))).toEqual({
      kind: "redirect",
      route: { kind: "settings", group: "you", page: "profile" }
    });
  });

  it("says that a Workspace page is closed to a viewer who manages none", () => {
    expect(resolve("/settings/workspace/members", member)).toEqual({ kind: "no-access" });
    expect(resolve("/settings/you/nothing", member)).toEqual({ kind: "no-access" });
  });

  it("waits for the workspace list before it answers a Workspace page", () => {
    expect(resolve("/settings/workspace/general", member, buildOn, false)).toEqual({
      kind: "pending"
    });
    expect(resolve("/admin", member, buildOn, false)).toEqual({ kind: "pending" });
  });
});
