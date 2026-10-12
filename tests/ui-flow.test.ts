import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FlowCanvas,
  FlowControls,
  FlowEdge,
  FlowGroup,
  FlowHandle,
  FlowMinimap,
  IconRegistryProvider,
  RegistryIcon,
  FlowNode,
  SidePanel,
  UiRoot,
  flowEdgePath,
  genericIcons,
  uiLabelsDe,
  uiLabelsEn,
  type FlowEdgeState,
  type FlowNodeProps,
  type FlowStatus
} from "@vivd-catalyst/ui";

// The parts of a graph canvas, each rendered on its own. Every test here fails without the
// components: the library did not export them.

const inRoot = (node: ReactNode, labels = uiLabelsEn) =>
  renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels }, node));
const node = (props: Partial<FlowNodeProps>, labels = uiLabelsEn) =>
  inRoot(
    createElement(FlowNode, { eyebrow: "Reads data", title: "Load the clients", ...props }),
    labels
  );
const slot = (markup: string, name: string) =>
  new RegExp(`<[a-z]+[^>]*data-slot="${name}"[^>]*>`, "u").exec(markup)?.[0] ?? "";
const classesOf = (tag: string) => /\sclass="([^"]*)"/u.exec(tag)?.[1]?.split(" ") ?? [];
const textOf = (markup: string) => markup.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ");

const statuses: readonly FlowStatus[] = ["idle", "running", "waiting", "done", "failed", "skipped"];
const words: Record<FlowStatus, string | undefined> = {
  idle: undefined,
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped"
};
const frames: Record<FlowStatus, string> = {
  idle: "border-input",
  running: "border-info-border",
  waiting: "border-warning",
  done: "border-success-border",
  failed: "border-destructive",
  skipped: "border-input"
};

describe("FlowNode", () => {
  it.each(statuses)(
    "shows the status %s as a line, and as a word wherever it has one",
    (status) => {
      const markup = node({ status });

      expect(slot(markup, "flow-node")).toContain(`data-status="${status}"`);
      expect(classesOf(slot(markup, "flow-frame"))).toContain(frames[status]);
      const word = words[status];
      if (word === undefined) {
        expect(markup).not.toContain('data-slot="flow-footer"');
      } else {
        // Never a colour alone: the footer says the status in words.
        expect(textOf(markup.slice(markup.indexOf('data-slot="flow-footer"')))).toContain(word);
      }
      // The corner badge is a second sign for the states that ask for attention or report an end.
      expect(markup.includes('data-slot="flow-badge"')).toBe(
        ["running", "waiting", "done", "failed"].includes(status)
      );
      expect(classesOf(slot(markup, "flow-node")).includes("opacity-55")).toBe(
        status === "skipped"
      );
    }
  );

  it("keeps the status word for a screen reader when the footer says something else", () => {
    const markup = node({ status: "done", footer: "600 clients", meta: "4 sec" });

    expect(markup).toContain("600 clients");
    expect(markup).toContain("4 sec");
    expect(markup).toMatch(/<span class="sr-only"> Done<\/span>/u);
    expect(node({ status: "done" }, uiLabelsDe)).toContain(uiLabelsDe.stateDone);
  });

  it("marks the selected node with the ring and aria-current", () => {
    const markup = slot(node({ selected: true }), "flow-node");

    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('data-selected=""');
    expect(classesOf(markup)).toContain("focus-ring");
    expect(slot(node({}), "flow-node")).not.toContain("aria-current");
  });

  it("takes the focus only when it can be opened, under the name it is given", () => {
    const open = slot(
      node({ label: "Reads data, Load the clients, Done", onOpen: () => undefined }),
      "flow-node"
    );

    expect(open).toContain('role="group"');
    expect(open).toContain('tabindex="0"');
    expect(open).toContain('aria-label="Reads data, Load the clients, Done"');
    expect(slot(node({}), "flow-node")).not.toContain("tabindex");
  });

  it("shows its rows as large as its title when compact", () => {
    const rows = [{ id: "yes", label: "Yes" }];
    const row = (compact: boolean) => classesOf(slot(node({ compact, rows }), "flow-row"));
    const title = classesOf(
      slot(node({ compact: true, rows }).split('data-slot="flow-compact"')[1] ?? "", "flow-title")
    );

    expect(title).toContain("text-title-lg");
    expect(row(true)).toContain("text-title-lg");
    expect(row(false)).toContain("text-caption");
    expect(row(false)).not.toContain("text-title-lg");
  });

  it("shows one row per way out, each with its handle, and no status footer under them", () => {
    const markup = node({
      status: "done",
      rows: [
        { id: "yes", label: "Yes", handle: createElement(FlowHandle, { state: "done" }) },
        { id: "no", label: "Otherwise", handle: createElement(FlowHandle, { state: "skipped" }) }
      ]
    });

    expect([...markup.matchAll(/data-exit="([^"]*)"/gu)].map((match) => match[1])).toEqual([
      "yes",
      "no"
    ]);
    expect(markup.match(/data-slot="flow-handle"/gu)).toHaveLength(2);
    expect(markup).not.toContain('data-slot="flow-footer"');
  });

  it("keeps its whole anatomy in the frame when compact, hidden under icon and title", () => {
    const markup = node({ compact: true, summary: "Fetches every client.", status: "done" });

    expect(slot(markup, "flow-node")).toContain('data-compact=""');
    expect(markup).toContain('data-slot="flow-compact"');
    // The summary is still there, so the frame has the size the layout was made for.
    expect(markup).toContain("Fetches every client.");
    expect(classesOf(slot(markup, "flow-footer"))).toContain("invisible");
    expect(node({ summary: "Fetches every client." })).not.toContain('data-slot="flow-compact"');
  });

  it("draws a second frame behind a node that holds a graph of its own", () => {
    expect(node({ stacked: true })).toContain('data-slot="flow-stack"');
    expect(node({})).not.toContain('data-slot="flow-stack"');
  });
});

describe("FlowHandle", () => {
  it.each<[FlowEdgeState, string]>([
    ["rest", "border-input-strong"],
    ["done", "border-success"],
    ["active", "border-info"],
    ["skipped", "border-input"]
  ])("takes the state %s of its edge and is hidden from assistive technology", (state, line) => {
    const markup = renderToStaticMarkup(createElement(FlowHandle, { state }));

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain(`data-state="${state}"`);
    expect(classesOf(markup)).toContain(line);
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

  it("is a dashed container with a head and a body for what it holds", () => {
    const markup = group({});

    expect(classesOf(slot(markup, "flow-group"))).toContain("border-dashed");
    expect(markup).toContain('data-slot="flow-group-body"');
    expect(markup).toContain("Check the bookings");
  });

  it("folds to its head, and its control says which way it goes", () => {
    const open = group({ onCollapsedChange: () => undefined });
    const folded = group({ collapsed: true, status: "done", onCollapsedChange: () => undefined });

    expect(slot(open, "flow-fold")).toContain('aria-expanded="true"');
    expect(slot(open, "flow-fold")).toContain(`aria-label="${uiLabelsEn.collapse}"`);
    expect(slot(folded, "flow-fold")).toContain('aria-expanded="false"');
    expect(slot(folded, "flow-fold")).toContain(`aria-label="${uiLabelsEn.expand}"`);
    expect(folded).not.toContain('data-slot="flow-group-body"');
    expect(folded).not.toContain("Check the bookings");
    // Folded, the group is one part of the graph and carries the badge a node would.
    expect(folded).toContain('data-slot="flow-badge"');
    expect(open).not.toContain('data-slot="flow-badge"');
    // No control without a way to fold.
    expect(group({})).not.toContain('data-slot="flow-fold"');
  });

  it.each<[FlowStatus, string]>([
    ["running", "border-info"],
    ["waiting", "border-warning"],
    ["done", "border-success"],
    ["failed", "border-destructive"]
  ])("colours its line for %s and says the status in words", (status, line) => {
    const markup = group({ status });

    expect(classesOf(slot(markup, "flow-group"))).toContain(line);
    expect(markup).toContain(`<span class="sr-only">${words[status] ?? ""}</span>`);
  });

  it("marks the selected group", () => {
    expect(slot(group({ selected: true }), "flow-group")).toContain('aria-current="true"');
  });
});

describe("FlowEdge", () => {
  const path = flowEdgePath({ x: 0, y: 10, side: "right" }, { x: 100, y: 50, side: "left" });
  const edge = (state?: FlowEdgeState) =>
    renderToStaticMarkup(createElement("svg", null, createElement(FlowEdge, { path, state })));

  it("leaves and arrives at a right angle to the sides it stands on", () => {
    expect(path).toBe("M0 10C50 10,50 50,100 50");
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

  it.each<[FlowEdgeState, string]>([
    ["rest", "stroke-input-strong"],
    ["done", "stroke-success"],
    ["active", "stroke-info"],
    ["skipped", "stroke-input"]
  ])("colours the state %s", (state, stroke) => {
    const markup = edge(state);

    expect(markup).toContain(`data-state="${state}"`);
    expect(classesOf(slot(markup, "flow-edge"))).toContain(stroke);
  });

  it("moves only the active edge, and not under reduced motion", () => {
    const active = classesOf(slot(edge("active"), "flow-edge"));

    expect(active).toContain("animate-flow-dash");
    expect(active).toContain("motion-reduce:animate-none");
    expect(classesOf(slot(edge("done"), "flow-edge"))).not.toContain("animate-flow-dash");
    expect(edge()).toContain('data-state="rest"');
  });
});

describe("FlowControls", () => {
  const controls = (props: Partial<Parameters<typeof FlowControls>[0]>, labels = uiLabelsEn) =>
    inRoot(
      createElement(FlowControls, {
        zoom: 0.493,
        onZoomIn: () => undefined,
        onZoomOut: () => undefined,
        onFit: () => undefined,
        ...props
      }),
      labels
    );

  it("names every control in the language of the root and shows the zoom as a percentage", () => {
    const markup = controls({});

    for (const label of [uiLabelsEn.flowZoomOut, uiLabelsEn.flowZoomIn, uiLabelsEn.flowFit]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(textOf(slot(markup, "flow-zoom") + markup.split('data-slot="flow-zoom"')[1])).toMatch(
      /49\s*%/u
    );
    expect(controls({}, uiLabelsDe)).toContain(`aria-label="${uiLabelsDe.flowFit}"`);
  });

  it("shows tidy and the search field only when they are given", () => {
    const bare = controls({});
    const full = controls({
      onTidy: () => undefined,
      search: {
        label: "Find a step",
        value: "",
        onValueChange: () => undefined,
        onSubmit: () => undefined
      }
    });

    expect(bare).not.toContain(`aria-label="${uiLabelsEn.flowTidy}"`);
    expect(bare).not.toContain('type="search"');
    expect(full).toContain(`aria-label="${uiLabelsEn.flowTidy}"`);
    expect(full).toMatch(/<input[^>]*type="search"[^>]*aria-label="Find a step"/u);
  });

  it("disables a zoom control at its end", () => {
    const markup = controls({ canZoomOut: false });
    const zoomOut = new RegExp(`<button[^>]*aria-label="${uiLabelsEn.flowZoomOut}"[^>]*>`, "u");

    expect(zoomOut.exec(markup)?.[0]).toContain("disabled");
  });
});

describe("FlowMinimap", () => {
  it("is a named picture with one mark per part and one for what is shown", () => {
    const markup = inRoot(
      createElement(FlowMinimap, {
        items: [
          { id: "a", x: 0, y: 0, width: 200, height: 80, status: "done" },
          { id: "g", x: 260, y: 0, width: 240, height: 200, group: true },
          { id: "b", x: 272, y: 60, width: 200, height: 80, status: "failed" }
        ],
        viewport: { x: 0, y: 0, width: 300, height: 200 }
      })
    );

    expect(slot(markup, "flow-minimap")).toContain('role="img"');
    expect(slot(markup, "flow-minimap")).toContain(`aria-label="${uiLabelsEn.flowMinimap}"`);
    expect(markup.match(/data-status=/gu)).toHaveLength(3);
    expect(markup).toContain("bg-destructive");
    expect(markup).toContain("border-dashed");
    expect(markup).toContain('data-slot="flow-minimap-viewport"');
  });

  it("renders with nothing to show", () => {
    expect(inRoot(createElement(FlowMinimap, { items: [] }))).toContain('data-slot="flow-minimap"');
  });
});

describe("RegistryIcon", () => {
  const Mark = () => createElement("svg", { "data-mark": "ledger" });
  const icon = (props: Parameters<typeof RegistryIcon>[0], icons = {}) =>
    renderToStaticMarkup(
      createElement(IconRegistryProvider, {
        icons: { ledger: Mark, ...icons },
        children: createElement(RegistryIcon, props)
      })
    );
  const generic = (key: keyof typeof genericIcons) =>
    renderToStaticMarkup(createElement(genericIcons[key], { "aria-hidden": true }));
  const shape = (markup: string) => markup.replace(/^<svg[^>]*>/u, "");

  it("shows the registered icon, then the fallback, then the generic step", () => {
    expect(icon({ name: "ledger" })).toContain('data-mark="ledger"');
    expect(shape(icon({ name: "outlook", fallback: "mail" }))).toBe(shape(generic("mail")));
    expect(shape(icon({ name: "unknown" }))).toBe(shape(generic("step")));
    expect(shape(icon({ name: "database" }))).toBe(shape(generic("database")));
    expect(icon({ name: "database" })).toContain('aria-hidden="true"');
  });

  it.each(["file", "service", "skill", "tool"] as const)(
    "resolves an unknown key of the family %s to the family's generic icon",
    (family) => {
      expect(shape(icon({ name: "unknown", family }))).toBe(shape(generic(family)));
      expect(shape(icon({ family }))).toBe(shape(generic(family)));
      // A registered key and a registered fallback come before the family.
      expect(icon({ name: "ledger", family })).toContain('data-mark="ledger"');
      expect(shape(icon({ name: "unknown", fallback: "mail", family }))).toBe(
        shape(generic("mail"))
      );
    }
  );

  it("gives every family an icon of its own, and lets an application replace one", () => {
    const shapes = (["file", "service", "skill", "tool"] as const).map((family) =>
      shape(icon({ family }))
    );

    expect(new Set([...shapes, shape(generic("step"))]).size).toBe(5);
    expect(icon({ name: "unknown", family: "skill" }, { skill: Mark })).toContain(
      'data-mark="ledger"'
    );
  });
});

describe("FlowCanvas", () => {
  const graph = {
    nodes: [{ id: "a", kind: "step" as const, eyebrow: "Starts", title: "Every month" }],
    edges: []
  };

  it("says that a graph has nothing in it", () => {
    const markup = inRoot(
      createElement(FlowCanvas, {
        graph: { nodes: [], edges: [] },
        label: "Monthly check",
        emptyLabel: "This workflow has no steps yet."
      })
    );

    expect(slot(markup, "flow-canvas")).toContain('data-state="empty"');
    expect(markup).toContain("This workflow has no steps yet.");
  });

  it("shows the loading layout and says so while it loads", () => {
    const markup = inRoot(
      createElement(FlowCanvas, { graph, label: "Monthly check", emptyLabel: "", loading: true })
    );

    expect(slot(markup, "flow-canvas")).toContain('aria-busy="true"');
    expect(slot(markup, "flow-skeleton")).toContain('aria-hidden="true"');
    expect(markup).toContain(`<span class="sr-only">${uiLabelsEn.loading}</span>`);
  });

  it("renders the loading layout on a server, where it has no size and no engine", () => {
    const markup = inRoot(
      createElement(FlowCanvas, { graph, label: "Monthly check", emptyLabel: "" })
    );

    expect(slot(markup, "flow-canvas")).toContain('data-state="ready"');
    expect(markup).toContain('data-slot="flow-skeleton"');
  });
});

describe("SidePanel", () => {
  const panel = (props: Partial<Parameters<typeof SidePanel>[0]>) =>
    inRoot(
      createElement(SidePanel, {
        open: true,
        title: "Load the clients",
        onClose: () => undefined,
        children: "Fetches the list of every active client.",
        ...props
      })
    );

  it("is a named region that holds no focus and dims nothing", () => {
    const markup = panel({ eyebrow: "Reads data" });
    const aside = slot(markup, "side-panel");
    const titleId = /aria-labelledby="([^"]*)"/u.exec(aside)?.[1] ?? "";

    expect(aside.startsWith("<aside")).toBe(true);
    expect(markup).toContain(`<h2 id="${titleId}"`);
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain("aria-modal");
    expect(markup).toContain(`aria-label="${uiLabelsEn.close}"`);
    expect(markup).toContain("Fetches the list of every active client.");
  });

  it("renders nothing while it is closed", () => {
    expect(panel({ open: false })).not.toContain("side-panel");
  });

  it("stands at the right edge, or rises as a sheet with a grabber", () => {
    const float = panel({ mode: "float" });
    const sheet = panel({ mode: "sheet" });
    const auto = panel({});

    expect(slot(float, "side-panel")).toContain('data-placement="float"');
    expect(classesOf(slot(float, "side-panel-grabber"))).toContain("hidden");
    expect(slot(sheet, "side-panel")).toContain('data-placement="sheet"');
    expect(classesOf(slot(sheet, "side-panel"))).toContain("bottom-0");
    expect(classesOf(slot(sheet, "side-panel-grabber"))).toContain("block");
    // Left to itself it is a sheet in a window under 600 px.
    expect(classesOf(slot(auto, "side-panel"))).toContain("max-[600px]:bottom-0");
    expect(classesOf(slot(auto, "side-panel"))).toContain("motion-reduce:animate-none");
  });

  it("shows its views as tabs, with the chosen one selected", () => {
    const markup = panel({
      tabsLabel: "Views of the step",
      tabs: [
        { value: "what", label: "What it does" },
        { value: "entries", label: "Entries", count: 3 }
      ],
      tab: "entries"
    });

    expect(markup).toContain('aria-label="Views of the step"');
    expect(markup.match(/role="tab"/gu)).toHaveLength(2);
    expect(/<button[^>]*aria-selected="true"[^>]*>(.*?)<\/button>/u.exec(markup)?.[1]).toContain(
      "Entries"
    );
    expect(markup).toContain('role="tabpanel"');
  });
});

describe("accessibility of the canvas parts", () => {
  const all = inRoot(
    createElement(
      "div",
      null,
      ...statuses.map((status) =>
        createElement(FlowNode, {
          key: status,
          eyebrow: "Reads data",
          title: "Load the clients",
          status,
          label: `Reads data, Load the clients${words[status] ? `, ${words[status]}` : ""}`,
          onOpen: () => undefined,
          handles: createElement(FlowHandle, null)
        })
      ),
      createElement(FlowGroup, {
        eyebrow: "Loop",
        title: "For each client",
        label: "Loop, For each client",
        status: "running",
        onOpen: () => undefined,
        onCollapsedChange: () => undefined
      }),
      createElement(FlowControls, {
        zoom: 1,
        onZoomIn: () => undefined,
        onZoomOut: () => undefined,
        onFit: () => undefined,
        onTidy: () => undefined
      }),
      createElement(FlowMinimap, { items: [] })
    )
  );

  it("names everything that takes the focus", () => {
    const focusable = [...all.matchAll(/<(button|input|[a-z]+[^>]*tabindex="0")[^>]*>/gu)].map(
      (match) => match[0]
    );

    expect(focusable.length).toBeGreaterThan(10);
    for (const tag of focusable) {
      expect(tag, tag).toMatch(/aria-label="[^"]+"/u);
    }
  });

  it("says every status in words inside the part that has it", () => {
    for (const status of statuses) {
      const word = words[status];
      if (word === undefined) {
        continue;
      }
      const part = all
        .split('data-slot="flow-node"')
        .find((piece) => piece.includes(`data-status="${status}"`));
      expect(textOf(part ?? ""), status).toContain(word);
    }
  });

  it("hides every decoration from assistive technology", () => {
    const decorations = [
      ...all.matchAll(/<(svg|span)[^>]*data-slot="flow-(badge|handle)"[^>]*>/gu)
    ];

    expect(decorations.length).toBeGreaterThan(0);
    for (const [tag] of decorations) {
      expect(tag).toContain('aria-hidden="true"');
    }
    for (const [svg] of all.matchAll(/<svg[^>]*>/gu)) {
      expect(svg, svg).toMatch(/aria-hidden="true"|role="(img|status)"/u);
    }
  });

  it("puts no button inside a button", () => {
    const depth = { open: 0, nested: 0 };
    for (const [tag] of all.matchAll(/<\/?button\b[^>]*>/gu)) {
      if (tag.startsWith("</")) {
        depth.open -= 1;
      } else {
        depth.nested += depth.open > 0 ? 1 : 0;
        depth.open += 1;
      }
    }
    expect(depth.nested).toBe(0);
  });
});
