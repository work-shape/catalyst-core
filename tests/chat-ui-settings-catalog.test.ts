import { describe, expect, it } from "vitest";
import type { ApiUser, CollaborationWorkspaceWithRole } from "@work-shape/catalyst-api-client";
import { createTranslationContext, type SettingsViewer } from "@work-shape/catalyst-chat-ui";
import type { WorkspaceRoute } from "@work-shape/catalyst-chat-ui/shell";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import { workspaceRouteFromPath } from "../packages/chat-ui/src/shared/routes";
import {
  firstAdministrationRoute,
  resolveSettingsRoute,
  settingsCatalog,
  settingsGoToTargets,
  visibleSettingsPages,
  type BuildAccess
} from "../packages/chat-ui/src/admin/settings/catalog";
import { platformContext } from "./chat-ui-build-fixtures";
import { personalWorkspace, settingsUser, sharedWorkspace } from "./chat-ui-settings-fixtures";

const catalog = settingsCatalog(administration);
const buildOn: BuildAccess = { page: administration.build, enabled: true, ready: true };
const buildOff: BuildAccess = { page: administration.build, enabled: false, ready: true };
/** The instance has not said yet which Namespaces the viewer holds. */
const buildUnanswered: BuildAccess = { page: administration.build, enabled: true, ready: false };

function viewer(
  user: Partial<ApiUser> = {},
  workspaces: CollaborationWorkspaceWithRole[] = [personalWorkspace()]
): SettingsViewer {
  return { user: settingsUser(user), workspaces };
}

function pageIds(of: SettingsViewer): string[] {
  return visibleSettingsPages(catalog, of).map((page) => `${page.group}/${page.id}`);
}

function resolve(
  path: string,
  of: SettingsViewer,
  build = buildOn,
  workspacesReady = true,
  platformReady = true
) {
  return resolveSettingsRoute({
    route: workspaceRouteFromPath(path),
    catalog,
    build,
    viewer: of,
    workspacesReady,
    platformReady
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
  "instance/jobs",
  "instance/operations",
  "instance/modules",
  "instance/infrastructure"
];

const member = viewer();
/** No permission on the instance, and a right in one Namespace. */
const namespaceHolder: SettingsViewer = {
  ...viewer(),
  platform: platformContext([{ prefix: "tax-", displayName: "Tax", actions: ["skill.read"] }])
};
/** The instance answered, and the viewer holds nothing in it. */
const answeredMember: SettingsViewer = { ...viewer(), platform: platformContext() };
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
    // API keys and Connect a local agent are the module `personalApiKeys`'s, shown only where it is on.
    expect(catalog.map((page) => `${page.group}/${page.id}`)).toEqual([
      ...you,
      "you/api-keys",
      "you/connect",
      ...workspace,
      ...instance
    ]);
  });

  it("names every page and Studio in both languages", () => {
    const en = createTranslationContext("en");
    const de = createTranslationContext("de");
    for (const page of [...catalog, administration.build]) {
      expect(en.t(page.labelKey)).not.toBe(page.labelKey);
      expect(de.t(page.labelKey)).not.toBe(page.labelKey);
    }
    expect(en.t("nav.build")).toBe("Studio");
    expect(de.t("nav.build")).toBe("Studio");
  });

  it.each<[key: string, pages: string[]]>([
    ["users.manage", ["instance/users", "instance/access", "instance/infrastructure"]],
    ["api_access.manage", ["instance/api-access"]],
    ["usage.view", ["instance/usage"]],
    ["audit.view", ["instance/audit", "instance/jobs", "instance/operations", "instance/modules"]]
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

  it("shows Studio to holders of config_assets.read while config assets are on", () => {
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

  it("shows Studio to a holder of a Namespace who has no permission on the instance", () => {
    const targets = (build: BuildAccess, of: SettingsViewer) =>
      settingsGoToTargets(catalog, build, of).map((target) => target.id);

    expect(pageIds(namespaceHolder)).toEqual(you);
    expect(targets(buildOn, namespaceHolder)).toEqual([
      ...you.map((id) => `settings/${id}`),
      "build"
    ]);
    expect(firstAdministrationRoute(catalog, buildOn, namespaceHolder)).toEqual({ kind: "build" });
    // Studio is the instance's switch first: off, no Namespace opens it.
    expect(targets(buildOff, namespaceHolder)).not.toContain("build");
    expect(firstAdministrationRoute(catalog, buildOff, namespaceHolder)).toBeUndefined();
  });

  it("shows no Studio to a viewer who holds no right on an agent or a skill", () => {
    for (const of of [member, answeredMember, instanceAdmin]) {
      expect(settingsGoToTargets(catalog, buildOn, of).map((target) => target.id)).not.toContain(
        "build"
      );
    }
    expect(firstAdministrationRoute(catalog, buildOn, answeredMember)).toBeUndefined();
  });

  it("shows Studio to a holder of config_assets.write alone", () => {
    expect(
      settingsGoToTargets(catalog, buildOn, viewer({ permissions: ["config_assets.write"] })).map(
        (target) => target.id
      )
    ).toContain("build");
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

  it("opens the gear on the first Instance page, else on General, else on Studio", () => {
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

  it("lands /admin/config on Studio", () => {
    expect(resolve("/admin/config", superadminWithoutMembership)).toEqual({
      kind: "build",
      page: administration.build
    });
  });

  const buildAddresses = ["/build", "/build/agents", "/build/skills/tax-review"];

  it.each(buildAddresses)("answers %s with Studio for a viewer who may open it", (path) => {
    const open = { kind: "build", page: administration.build };

    expect(resolve(path, superadminWithoutMembership)).toEqual(open);
    expect(resolve(path, namespaceHolder)).toEqual(open);
    // The session names an instance right, so its holder does not wait for the instance.
    expect(resolve(path, superadminWithoutMembership, buildUnanswered)).toEqual(open);
  });

  it.each(buildAddresses)(
    "says at %s that Studio is closed to a viewer who holds nothing in it",
    (path) => {
      const closed = { kind: "build-closed", page: administration.build };

      expect(resolve(path, answeredMember)).toEqual(closed);
      expect(resolve(path, instanceAdmin)).toEqual(closed);
    }
  );

  it.each(buildAddresses)("waits at %s until the instance said what the viewer may do", (path) => {
    expect(resolve(path, member, buildUnanswered)).toEqual({ kind: "pending" });
    // Once it answered, the same viewer is told, and a holder of a Namespace is let in.
    expect(resolve(path, answeredMember, buildOn)).toMatchObject({ kind: "build-closed" });
    expect(resolve(path, namespaceHolder, buildOn)).toMatchObject({ kind: "build" });
  });

  it.each(buildAddresses)("leads %s away where the instance runs without Studio", (path) => {
    expect(resolve(path, member, buildOff)).toEqual({ kind: "chat" });
    expect(resolve(path, namespaceHolder, buildOff)).toEqual({ kind: "chat" });
    expect(resolve(path, member, { ...buildOff, ready: false })).toEqual({ kind: "chat" });
    expect(resolve(path, instanceAdmin, buildOff)).toEqual({
      kind: "redirect",
      route: { kind: "settings", group: "instance", page: "users" }
    });
    // An assembly without a Studio page has nothing to say that it is closed.
    expect(
      resolve(path, superadminWithoutMembership, { page: undefined, enabled: true, ready: true })
    ).toEqual({
      kind: "redirect",
      route: { kind: "settings", group: "instance", page: "users" }
    });
  });

  it("leads /admin to the first permitted Settings page, else to Studio, else to chat", () => {
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
    // The old address of Studio is a Studio address: closed to a viewer who holds nothing in it.
    expect(resolve("/admin/config", member)).toEqual({
      kind: "build-closed",
      page: administration.build
    });
    expect(resolve("/admin/config", member, buildOff)).toEqual({ kind: "chat" });
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

  it("waits for the platform context before it calls a page shown by a right closed", () => {
    // An administrator opens API access by its address: the right that shows the page comes
    // with the platform context, and until it arrives the page is not sent elsewhere.
    const admin = viewer({ roles: ["admin"], permissions: ["users.manage"] });
    expect(resolve("/settings/instance/api-access", admin, buildOn, true, false)).toEqual({
      kind: "pending"
    });
    expect(
      resolve("/settings/instance/api-access", {
        ...admin,
        platform: { ...platformContext(), instanceActions: ["service_principals.manage"] }
      })
    ).toMatchObject({ kind: "page" });
  });
});
