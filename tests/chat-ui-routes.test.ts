import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkspaceRoute } from "@vivd-catalyst/chat-ui/shell";
import {
  areaOfRoute,
  areaRoutePaths,
  areaRoutes,
  workspaceRouteFromPath,
  workspaceRouteNavigation
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
  ["/settings", { kind: "settings" }, "settings"],
  ["/approvals", { kind: "approvals" }, "approvals"],
  ["/admin/usage", { kind: "superadmin", tab: "usage" }, "superadmin"],
  ["/admin/users", { kind: "superadmin", tab: "users" }, "superadmin"],
  ["/admin/api-access", { kind: "superadmin", tab: "api-access" }, "superadmin"],
  ["/admin/audit", { kind: "superadmin", tab: "audit" }, "superadmin"],
  ["/admin/config", { kind: "superadmin", tab: "config" }, "superadmin"],
  ["/ui-library", { kind: "ui-library" }, "ui-library"]
];

describe("area route table", () => {
  it("has one row per area", () => {
    const areas = areaRoutes.map((row) => row.area);

    expect(areas).toEqual(["chat", "settings", "approvals", "superadmin", "ui-library"]);
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

  it("sends /admin to the users tab and resolves nothing by itself", () => {
    const admin = areaRoutePaths().find((candidate) => candidate.path === "/admin");

    expect(admin).toEqual({ path: "/admin", redirectTo: "/admin/users" });
    expect(workspaceRouteFromPath("/admin")).toEqual({ kind: "collaboration-workspace-root" });
  });

  it("opens the application root for an address no row resolves", () => {
    for (const path of ["/w/", "/w/cw_1/c", "/w/cw_1/x/conv_2", "/c/a/b", "/admin/nothing", "/x"]) {
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
