import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FlowCanvas,
  FlowControls,
  FlowGroup,
  FlowNode,
  SidePanel,
  UiRoot,
  flowEdgePath,
  uiLabelsEn,
  type FlowNodeProps
} from "@work-shape/catalyst-ui";

// The parts of a graph canvas, each rendered on its own.

const inRoot = (node: ReactNode) =>
  renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, node));
const node = (props: Partial<FlowNodeProps>) =>
  inRoot(createElement(FlowNode, { eyebrow: "Reads data", title: "Load the clients", ...props }));
const slot = (markup: string, name: string) =>
  new RegExp(`<[a-z]+[^>]*data-slot="${name}"[^>]*>`, "u").exec(markup)?.[0] ?? "";

describe("FlowNode", () => {
  it("takes the focus only when it can be opened", () => {
    expect(slot(node({ onOpen: () => undefined }), "flow-node")).toContain('tabindex="0"');
    expect(slot(node({}), "flow-node")).not.toContain("tabindex");
  });

  it("lets only a row that stands for a part of its own open that part", () => {
    const markup = node({
      status: "done",
      rows: [
        { id: "then", label: "Yes" },
        {
          id: "medium:then",
          label: "Otherwise if: Medium risk?",
          partId: "medium",
          status: "failed",
          onOpen: () => undefined
        },
        { id: "medium:else", label: "Otherwise", partId: "x", status: "skipped" }
      ]
    });

    expect(markup.match(/data-slot="flow-row-open"/gu)).toHaveLength(1);
    expect(slot(markup, "flow-row-open")).toContain('data-flow-id="medium"');
  });
});

describe("FlowGroup", () => {
  const group = (props: Partial<Parameters<typeof FlowGroup>[0]>) =>
    inRoot(
      createElement(
        FlowGroup,
        { eyebrow: "Loop", title: "For each client", ...props },
        createElement(FlowNode, { title: "Check the bookings" })
      )
    );

  it("folds to its head, and offers no control without a way to fold", () => {
    const open = group({ onCollapsedChange: () => undefined });
    const folded = group({ collapsed: true, onCollapsedChange: () => undefined });

    expect(slot(open, "flow-fold")).toContain('aria-expanded="true"');
    expect(open).toContain("Check the bookings");
    expect(slot(folded, "flow-fold")).toContain('aria-expanded="false"');
    expect(folded).not.toContain("Check the bookings");
    expect(group({})).not.toContain('data-slot="flow-fold"');
  });
});

describe("flowEdgePath", () => {
  it("leaves and arrives at a right angle to the sides it stands on", () => {
    expect(flowEdgePath({ x: 0, y: 10, side: "right" }, { x: 100, y: 50, side: "left" })).toBe(
      "M0 10C50 10,50 50,100 50"
    );
    // Two close nodes still get a curve.
    expect(flowEdgePath({ x: 0, y: 0, side: "bottom" }, { x: 0, y: 8, side: "top" })).toBe(
      "M0 0C0 10,0 -2,0 8"
    );
  });

  it("passes through its waypoints", () => {
    const routed = flowEdgePath({ x: 0, y: 0, side: "right" }, { x: 300, y: 0, side: "left" }, [
      { x: 100, y: 80 },
      { x: 200, y: 80 }
    ]);

    expect(routed).toContain(",100 80C");
    expect(routed).toContain(",200 80C");
    expect(routed.endsWith("300 0")).toBe(true);
  });
});

describe("FlowControls", () => {
  const controls = (props: Partial<Parameters<typeof FlowControls>[0]>) =>
    inRoot(
      createElement(FlowControls, {
        zoom: 0.493,
        onZoomIn: () => undefined,
        onZoomOut: () => undefined,
        onFit: () => undefined,
        ...props
      })
    );

  it("shows tidy only when given, and disables a zoom control at its end", () => {
    expect(controls({})).not.toContain(`aria-label="${uiLabelsEn.flowTidy}"`);
    expect(controls({ onTidy: () => undefined })).toContain(`aria-label="${uiLabelsEn.flowTidy}"`);
    const zoomOut = new RegExp(`<button[^>]*aria-label="${uiLabelsEn.flowZoomOut}"[^>]*>`, "u");
    expect(zoomOut.exec(controls({ canZoomOut: false }))?.[0]).toContain("disabled");
  });
});

describe("FlowCanvas", () => {
  it("says that a graph has nothing in it, and renders on a server without its engine", () => {
    const empty = inRoot(
      createElement(FlowCanvas, {
        graph: { nodes: [], edges: [] },
        label: "Monthly check",
        emptyLabel: "This workflow has no steps yet."
      })
    );
    expect(slot(empty, "flow-canvas")).toContain('data-state="empty"');

    const ready = inRoot(
      createElement(FlowCanvas, {
        graph: {
          nodes: [{ id: "a", kind: "step" as const, eyebrow: "Starts", title: "Every month" }],
          edges: []
        },
        label: "Monthly check",
        emptyLabel: ""
      })
    );
    expect(slot(ready, "flow-canvas")).toContain('data-state="ready"');
  });
});

describe("SidePanel", () => {
  it("renders nothing while it is closed", () => {
    const panel = (open: boolean) =>
      inRoot(
        createElement(SidePanel, {
          open,
          title: "Load the clients",
          onClose: () => undefined,
          children: "Fetches the list."
        })
      );

    expect(panel(true)).toContain("Fetches the list.");
    expect(panel(false)).not.toContain("side-panel");
  });
});
