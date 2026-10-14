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
import {
  addressDockConversation,
  clampDockWidth,
  DOCK_DEFAULT_WIDTH,
  dockConversationOfSearch,
  dockMotion,
  dockPlacement,
  searchWithDock
} from "@vivd-catalyst/chat-ui/dock-state";

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
  ["/w/cw_1/apps", { kind: "apps", collaborationWorkspaceId: "cw_1" }, "apps"],
  ["/w/cw_1/apps/quote", { kind: "app", collaborationWorkspaceId: "cw_1", app: "quote" }, "apps"],
  [
    "/w/cw_1/app-drafts/quote",
    { kind: "app-edit", collaborationWorkspaceId: "cw_1", app: "quote" },
    "apps"
  ],
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
  ["/ui-library", { kind: "ui-library" }, "ui-library"],
  // The Workflow pages over samples stand beside the library, behind the same right.
  ["/ui-library/workflows", { kind: "workflow-samples" }, "ui-library"]
];

describe("area route table", () => {
  it("has one row per area", () => {
    const areas = areaRoutes.map((row) => row.area);

    expect(areas).toEqual([
      "chat",
      "agents",
      "apps",
      "workflows",
      "settings",
      "inbox",
      "build",
      "ui-library"
    ]);
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

  // Fails with the list page: these addresses then opened the list of every conversation,
  // which no longer exists.
  it("leads the addresses of the former conversation list to the start page of the workspace", () => {
    const row = areaRoutePaths().find(
      (candidate) => candidate.path === "/w/$collaborationWorkspaceId/conversations"
    );

    expect(row?.route).toBeUndefined();
    expect(row?.redirectTo).toBe("/w/$collaborationWorkspaceId");
    expect(workspaceRouteFromPath("/w/cw%201/conversations")).toEqual({
      kind: "new-conversation",
      collaborationWorkspaceId: "cw 1"
    });
    expect(workspaceRouteFromPath("/conversations")).toEqual({
      kind: "collaboration-workspace-root"
    });
  });

  it("keeps /admin as an address the shell answers by the viewer's rights", () => {
    expect(workspaceRouteFromPath("/admin")).toEqual({ kind: "administration" });
  });

  it("leads the old Config address to Studio, which opens a list", () => {
    const row = areaRoutePaths().find((candidate) => candidate.path === "/admin/config");

    expect(row?.route).toBeUndefined();
    expect(row?.redirectTo).toBe("/build");
    expect(workspaceRouteFromPath("/admin/config")).toEqual({ kind: "build" });
  });

  it("reads the id of a Studio asset as written, with its Namespace prefix and dots", () => {
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

describe("the dock in the address", () => {
  const chatRoute: WorkspaceRoute = {
    kind: "conversation",
    collaborationWorkspaceId: "cw_1",
    conversationId: "conv_2"
  };
  const appsRoute: WorkspaceRoute = { kind: "apps", collaborationWorkspaceId: "cw_1" };
  const inboxRoute: WorkspaceRoute = { kind: "inbox" };

  it("holds the conversation of `?chat=` on every route but the chat route", () => {
    expect(addressDockConversation({ route: appsRoute, chat: "conv_2" })).toBe("conv_2");
    expect(addressDockConversation({ route: inboxRoute, chat: "conv_2" })).toBe("conv_2");
    expect(addressDockConversation({ route: chatRoute, chat: "conv_9" })).toBeUndefined();
    expect(addressDockConversation({ route: appsRoute, chat: "" })).toBeUndefined();
  });

  it("reads `?chat=` from a search and writes it beside the page's own parameters", () => {
    expect(dockConversationOfSearch({ chat: "conv_2" })).toBe("conv_2");
    expect(dockConversationOfSearch({ chat: "" })).toBeUndefined();
    expect(dockConversationOfSearch({ chat: 4 })).toBeUndefined();
    expect(searchWithDock({ tab: "runs", chat: "conv_1" }, "conv_2")).toEqual({
      tab: "runs",
      chat: "conv_2"
    });
    expect(searchWithDock({ tab: "runs", chat: "conv_1" }, undefined)).toEqual({ tab: "runs" });
    expect(searchWithDock(undefined, "conv_2")).toEqual({ chat: "conv_2" });
  });

  it("narrows the chat into the dock and widens it out again, and nothing else moves", () => {
    expect(dockMotion({ route: chatRoute }, { route: appsRoute, chat: "conv_2" })).toBe("dock-in");
    expect(dockMotion({ route: appsRoute, chat: "conv_2" }, { route: chatRoute })).toBe("dock-out");
    // Another conversation, a page to a page, and the chat route to a page without a dock.
    expect(dockMotion({ route: chatRoute }, { route: appsRoute, chat: "conv_3" })).toBeUndefined();
    expect(
      dockMotion({ route: appsRoute, chat: "conv_2" }, { route: inboxRoute, chat: "conv_2" })
    ).toBeUndefined();
    expect(dockMotion({ route: chatRoute }, { route: appsRoute })).toBeUndefined();
  });

  it("opens at 420 px and leaves the dock and the page 380 px each", () => {
    expect(DOCK_DEFAULT_WIDTH).toBe(420);
    expect(dockPlacement(1200, 380)).toBe("beside");
    expect(dockPlacement(760, 380)).toBe("beside");
    expect(dockPlacement(759, 380)).toBe("over");
    expect(dockPlacement(undefined, 380)).toBe("beside");
    expect(clampDockWidth(420, 1200, 380)).toBe(420);
    expect(clampDockWidth(200, 1200, 380)).toBe(380);
    expect(clampDockWidth(1000, 1200, 380)).toBe(820);
    expect(clampDockWidth(420, 700, 380)).toBe(380);
  });
});
