import { describe, expect, it } from "vitest";
import type { WorkspaceRoute } from "@work-shape/catalyst-chat-ui/shell";
import {
  areaOfRoute,
  areaRoutePaths,
  areaRoutes,
  workspaceRouteFromPath,
  workspaceRouteNavigation,
  workspaceRoutePath,
  addressDockConversation,
  clampDockWidth,
  dockConversationOfSearch,
  dockMotion,
  dockPlacement,
  searchWithDock
} from "./support/chat-ui";

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
  ["/w/cw_1/scheduled", { kind: "scheduled", collaborationWorkspaceId: "cw_1" }, "scheduled"],
  ["/w/cw_1/projects", { kind: "projects", collaborationWorkspaceId: "cw_1" }, "projects"],
  [
    "/w/cw_1/p/projekt-nord-4k2p",
    { kind: "project", collaborationWorkspaceId: "cw_1", project: "projekt-nord-4k2p" },
    "projects"
  ],
  ["/inbox", { kind: "inbox" }, "inbox"],
  ["/inbox/apr_1", { kind: "inbox-item", itemId: "apr_1" }, "inbox"],
  ["/inbox/agent/writer", { kind: "inbox-agent", agentName: "writer" }, "inbox"],
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
  it("resolves each address to its view and leads back to it from its route", () => {
    for (const [path, route, view] of addresses) {
      expect(workspaceRouteFromPath(path), path).toEqual(route);
      expect(workspaceRouteFromPath(`${path === "/" ? "" : path}/`), path).toEqual(route);
      expect(areaOfRoute(workspaceRouteFromPath(path)), path).toBe(view);
      const { to, params = {} } = workspaceRouteNavigation(route);
      expect(
        to.replace(/\$(\w+)/gu, (_match, name: string) => params[name] ?? ""),
        path
      ).toBe(path);
      expect(areaRoutePaths().map((candidate) => candidate.path)).toContain(to);
    }
  });

  /** The addresses of the old areas, with the Settings page that holds the same content now. */
  const oldAddresses: [path: string, route: WorkspaceRoute][] = [
    ["/settings", { kind: "settings", group: "you", page: "profile" }],
    ["/admin/users", { kind: "settings", group: "instance", page: "users" }],
    ["/admin/api-access", { kind: "settings", group: "instance", page: "api-access" }]
  ];

  it("leads the old addresses to their Settings pages", () => {
    for (const [path, route] of oldAddresses) {
      const row = areaRoutePaths().find((candidate) => candidate.path === path);
      const { to, params = {} } = workspaceRouteNavigation(route);
      expect(row?.route, path).toBeUndefined();
      expect(row?.redirectTo, path).toBe(
        to.replace(/\$(\w+)/gu, (_match, name: string) => params[name] ?? "")
      );
      expect(workspaceRouteFromPath(path), path).toEqual(route);
    }
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

  it("leads the old Config address to Studio, which opens a list", () => {
    const row = areaRoutePaths().find((candidate) => candidate.path === "/admin/config");

    expect(row?.route).toBeUndefined();
    expect(row?.redirectTo).toBe("/build");
    expect(workspaceRouteFromPath("/admin/config")).toEqual({ kind: "build" });
  });

  it("reads the id of a Studio asset as written, with its hyphens, underscores and dots", () => {
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

  it("says not found for an address no row resolves, and leaves the address as it is", () => {
    for (const path of [
      "/w/",
      "/w/cw_1/c",
      "/admin/nothing",
      "/build/a/b/c",
      // A Workflow's address names its workspace; without it there is no such page.
      "/workflows/unknown"
    ]) {
      expect(workspaceRouteFromPath(path)).toEqual({ kind: "not-found" });
      expect(areaOfRoute(workspaceRouteFromPath(path))).toBe("not-found");
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

  it("leaves the dock and the page their minimum each", () => {
    expect(dockPlacement(760, 380)).toBe("beside");
    expect(dockPlacement(759, 380)).toBe("over");
    expect(clampDockWidth(200, 1200, 380)).toBe(380);
    expect(clampDockWidth(1000, 1200, 380)).toBe(820);
  });
});
