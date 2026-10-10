import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkspaceRoute } from "@vivd-catalyst/chat-ui/shell";
import {
  areaOfRoute,
  areaRoutePaths,
  areaRoutes,
  workspaceRouteFromPath,
  workspaceRouteNavigation,
  workspaceRoutePath
} from "../packages/chat-ui/src/routes";

type Area = (typeof areaRoutes)[number]["area"];

/** Every address of today, with the route and the view it resolved to before the table. */
const addresses: [path: string, route: WorkspaceRoute, view: Area][] = [
  ["/", { kind: "collaboration-workspace-root" }, "chat"],
  ["/w/cw_1", { kind: "new-conversation", collaborationWorkspaceId: "cw_1" }, "chat"],
  [
    "/w/cw_1/c/conv_2",
    { kind: "conversation", collaborationWorkspaceId: "cw_1", conversationId: "conv_2" },
    "chat"
  ],
  ["/c/conv_2", { kind: "legacy-conversation", conversationId: "conv_2" }, "chat"],
  // These two fail without the list of every conversation: the paths opened the application root.
  [
    "/w/cw_1/conversations",
    { kind: "conversation-list", collaborationWorkspaceId: "cw_1" },
    "conversations"
  ],
  ["/conversations", { kind: "conversation-list-root" }, "conversations"],
  ["/settings/you/profile", { kind: "settings", group: "you", page: "profile" }, "settings"],
  [
    "/settings/workspace/members",
    { kind: "settings", group: "workspace", page: "members" },
    "settings"
  ],
  ["/settings/instance/users", { kind: "settings", group: "instance", page: "users" }, "settings"],
  ["/inbox", { kind: "inbox" }, "inbox"],
  ["/inbox/apr_1", { kind: "inbox-item", itemId: "apr_1" }, "inbox"],
  ["/admin", { kind: "administration" }, "settings"],
  ["/build", { kind: "build" }, "build"],
  ["/build/agents", { kind: "build-kind", assetKind: "agents" }, "build"],
  [
    "/build/skills/tax-review",
    { kind: "build-asset", assetKind: "skills", name: "tax-review" },
    "build"
  ],
  ["/ui-library", { kind: "ui-library" }, "ui-library"]
];

describe("area route table", () => {
  it("has one row per area", () => {
    const areas = areaRoutes.map((row) => row.area);

    expect(areas).toEqual(["chat", "conversations", "settings", "inbox", "build", "ui-library"]);
  });

  it.each(addresses)("resolves %s to the view it had before", (path, route, view) => {
    expect(workspaceRouteFromPath(path)).toEqual(route);
    expect(workspaceRouteFromPath(`${path === "/" ? "" : path}/`)).toEqual(route);
    expect(areaOfRoute(workspaceRouteFromPath(path))).toBe(view);
  });

  it.each(addresses)("leads back to %s from its route", (path, route) => {
    const { to, params = {} } = workspaceRouteNavigation(route);
    const address = to.replace(/\$(\w+)/gu, (_match, name: string) => params[name] ?? "");

    expect(address).toBe(path);
    expect(areaRoutePaths().map((candidate) => candidate.path)).toContain(to);
  });

  /** The addresses of the old areas, with the Settings page that holds the same content now. */
  const oldAddresses: [path: string, route: WorkspaceRoute][] = [
    ["/settings", { kind: "settings", group: "you", page: "profile" }],
    ["/admin/users", { kind: "settings", group: "instance", page: "users" }],
    ["/admin/usage", { kind: "settings", group: "instance", page: "usage" }],
    ["/admin/audit", { kind: "settings", group: "instance", page: "audit" }],
    ["/admin/api-access", { kind: "settings", group: "instance", page: "api-access" }]
  ];

  it.each(oldAddresses)("leads the old address %s to its Settings page", (path, route) => {
    const row = areaRoutePaths().find((candidate) => candidate.path === path);
    const { to, params = {} } = workspaceRouteNavigation(route);

    expect(row?.route).toBeUndefined();
    expect(row?.redirectTo).toBe(
      to.replace(/\$(\w+)/gu, (_match, name: string) => params[name] ?? "")
    );
    expect(workspaceRouteFromPath(path)).toEqual(route);
    expect(areaOfRoute(workspaceRouteFromPath(path))).toBe("settings");
  });

  // Fails without the Inbox routes: /approvals was a route of its own and /inbox resolved to the root.
  it("leads the old review queue address to the Inbox and gives an item its own address", () => {
    const row = areaRoutePaths().find((candidate) => candidate.path === "/approvals");

    expect(row?.route).toBeUndefined();
    expect(row?.redirectTo).toBe("/inbox");
    expect(workspaceRouteFromPath("/approvals")).toEqual({ kind: "inbox" });
    expect(workspaceRouteNavigation({ kind: "inbox-item", itemId: "apr_1" })).toEqual({
      to: "/inbox/$itemId",
      params: { itemId: "apr_1" }
    });
  });

  it("keeps /admin as an address the shell answers by the viewer's rights", () => {
    expect(workspaceRouteFromPath("/admin")).toEqual({ kind: "administration" });
  });

  it("leads the old Config address to Build, which opens a list", () => {
    const row = areaRoutePaths().find((candidate) => candidate.path === "/admin/config");

    expect(row?.route).toBeUndefined();
    expect(row?.redirectTo).toBe("/build");
    expect(workspaceRouteFromPath("/admin/config")).toEqual({ kind: "build" });
  });

  it("reads the id of a Build asset as written, with its Namespace prefix and dots", () => {
    expect(workspaceRouteFromPath("/build/agents/tax-steuer_agent.v2")).toEqual({
      kind: "build-asset",
      assetKind: "agents",
      name: "tax-steuer_agent.v2"
    });
  });

  it("writes a route as a path a link can carry, and reads the same route from it", () => {
    for (const name of ["tax-steuer_agent.v2", "a/b", "50% off", "Übersicht", "new"]) {
      const route: WorkspaceRoute = { kind: "build-asset", assetKind: "agents", name };
      expect(workspaceRouteFromPath(workspaceRoutePath(route))).toEqual(route);
    }
    expect(workspaceRoutePath({ kind: "build-asset", assetKind: "agents", name: "a/b" })).toBe(
      "/build/agents/a%2Fb"
    );
    expect(workspaceRoutePath({ kind: "build-kind", assetKind: "skills" })).toBe("/build/skills");
    expect(workspaceRoutePath({ kind: "build" })).toBe("/build");
  });

  it("opens the application root for an address no row resolves", () => {
    for (const path of [
      "/w/",
      "/w/cw_1/c",
      "/w/cw_1/x/conv_2",
      "/c/a/b",
      "/admin/nothing",
      "/x",
      "/build/a/b/c"
    ]) {
      expect(workspaceRouteFromPath(path)).toEqual({ kind: "collaboration-workspace-root" });
    }
  });

  it("decodes the segments it reads", () => {
    expect(workspaceRouteFromPath("/w/cw%201/c/conv%202")).toEqual({
      kind: "conversation",
      collaborationWorkspaceId: "cw 1",
      conversationId: "conv 2"
    });
    expect(workspaceRouteFromPath("/c/%E0%A4%A")).toEqual({
      kind: "legacy-conversation",
      conversationId: "%E0%A4%A"
    });
  });
});

describe("standalone router", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../packages/chat-ui/src/standalone-chat-app.tsx", import.meta.url)),
    "utf8"
  );

  it("creates its routes from the table and none by hand", () => {
    expect(source.match(/createRoute\(/gu)).toHaveLength(1);
    expect(source).toMatch(/areaRoutePaths\(\)\s*\.map\(/u);
    expect(source).not.toMatch(/path:\s*["'`]/u);
  });
});
