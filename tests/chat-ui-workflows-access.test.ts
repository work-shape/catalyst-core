import { describe, expect, it } from "vitest";
import {
  areaOfRoute,
  railSections,
  resolveWorkflowRights,
  shownRailSections,
  workflowsAccess,
  workspaceRouteFromPath,
  workspaceRoutePath
} from "@vivd-catalyst/chat-ui/workflows";

// Who is shown the Workflows area: its row in the rail and its addresses. One function
// decides both, from the module's switch and the rights the instance names. Every test here
// fails without the area: the route table had no row for it and the rail no section.

const modulesOn = { workflows: { enabled: true } };
const reader = { actions: ["workflow.read"], assetActions: [] };

describe("who is shown the Workflows area", () => {
  it("opens it for a person who may read every Workflow", () => {
    expect(workflowsAccess({ modules: modulesOn, workspaces: true, context: reader })).toBe("open");
  });

  it("opens it for a person who may read one single Workflow", () => {
    expect(
      workflowsAccess({
        modules: modulesOn,
        workspaces: true,
        context: { actions: [], assetActions: ["workflow.read"] }
      })
    ).toBe("open");
  });

  it("closes it for a person without the right to read a Workflow", () => {
    expect(
      workflowsAccess({
        modules: modulesOn,
        workspaces: true,
        context: { actions: ["app.read", "workflow.use"], assetActions: ["app.read"] }
      })
    ).toBe("closed");
  });

  it("closes it while the module is off, whatever the person holds", () => {
    expect(workflowsAccess({ modules: {}, workspaces: true, context: reader })).toBe("closed");
    expect(
      workflowsAccess({
        modules: { workflows: { enabled: false } },
        workspaces: true,
        context: reader
      })
    ).toBe("closed");
  });

  it("closes it where the session has no workspace to hold a Workflow", () => {
    expect(workflowsAccess({ modules: modulesOn, workspaces: false, context: reader })).toBe(
      "closed"
    );
  });

  it("decides nothing before the instance has said what is on and what the person holds", () => {
    expect(workflowsAccess({ modules: undefined, workspaces: true, context: reader })).toBe(
      "unknown"
    );
    expect(workflowsAccess({ modules: modulesOn, workspaces: true, context: undefined })).toBe(
      "unknown"
    );
  });

  it("shows the rail row only where the area is open", () => {
    const ids = (workflows: boolean) =>
      shownRailSections(railSections, { apps: true, workflows }).map((section) => section.id);
    expect(ids(true)).toEqual(["apps", "workflows"]);
    expect(ids(false)).toEqual(["apps"]);
    expect(shownRailSections(railSections).map((section) => section.id)).toEqual([]);
  });
});

describe("what a reader of Workflows is offered", () => {
  it("offers the start to a person who may use every Workflow", () => {
    expect(
      resolveWorkflowRights({ actions: ["workflow.read", "workflow.use"], assetActions: [] })
    ).toEqual({ read: true, start: true, write: false });
  });

  it("does not offer the start to a person who may read every Workflow and use none", () => {
    expect(resolveWorkflowRights(reader)).toEqual({ read: true, start: false, write: false });
  });

  it("offers the start where a grant on single Workflows leaves it to the instance", () => {
    // The instance names only the read action of such a grant, so the page cannot know.
    expect(resolveWorkflowRights({ actions: [], assetActions: ["workflow.read"] })).toEqual({
      read: true,
      start: true,
      write: false
    });
  });

  it("offers nothing before the instance has answered", () => {
    expect(resolveWorkflowRights(undefined)).toEqual({ read: false, start: false, write: false });
  });
});

describe("the addresses of the Workflows area", () => {
  const ws = "cw_1";
  const addresses = [
    ["/w/cw_1/workflows", { kind: "workflows", collaborationWorkspaceId: ws }],
    [
      "/w/cw_1/workflows/notify",
      { kind: "workflow", collaborationWorkspaceId: ws, workflow: "notify" }
    ],
    // A Workflow a step opened has an address of its own, one level per Workflow opened.
    [
      "/w/cw_1/workflows/notify/open/remind",
      { kind: "workflow", collaborationWorkspaceId: ws, workflow: "notify", opened: "remind" }
    ],
    [
      "/w/cw_1/workflows/notify/open/remind/mail",
      { kind: "workflow", collaborationWorkspaceId: ws, workflow: "notify", opened: "remind/mail" }
    ],
    [
      "/w/cw_1/workflows/notify/runs",
      { kind: "workflow-runs", collaborationWorkspaceId: ws, workflow: "notify" }
    ],
    [
      "/w/cw_1/workflows/notify/runs/wr_7",
      { kind: "workflow-run", collaborationWorkspaceId: ws, workflow: "notify", run: "wr_7" }
    ]
  ] as const;

  it.each(addresses)("resolves %s and writes it again", (path, route) => {
    expect(workspaceRouteFromPath(path)).toEqual(route);
    expect(workspaceRoutePath(route)).toBe(path);
    expect(areaOfRoute(route)).toBe("workflows");
  });

  it("opens the application root for an address the area does not have", () => {
    expect(workspaceRouteFromPath("/w/cw_1/workflows/notify/runs/wr_7/more")).toEqual({
      kind: "collaboration-workspace-root"
    });
  });
});
