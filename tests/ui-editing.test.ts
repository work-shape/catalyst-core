// @vitest-environment happy-dom

import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FieldListEditor,
  FlowCanvas,
  FlowGroup,
  FlowInsertPoint,
  FlowNode,
  ScheduleField,
  SidePanel,
  isScheduleZone,
  SourcedValueField,
  UiRoot,
  uiLabelsEn,
  type FieldListItem,
  type FieldListKind,
  type FlowCanvasProps,
  type FlowGraph,
  type FlowGraphNode,
  type FlowInsertPlace,
  type ScheduleValue,
  type SourcedValue,
  type SourcedValueKind
} from "@work-shape/catalyst-ui";
import { flowInsertSpots, layoutFlow } from "@work-shape/catalyst-ui/flow-layout";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  act(() => created.render(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, node)));
}
function find<T extends Element>(selector: string): T {
  const element = host?.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
function click(label: string) {
  const button = Array.from(host?.querySelectorAll("button") ?? []).find(
    (entry) =>
      entry.getAttribute("aria-label") === label ||
      entry.textContent === label ||
      (entry.id !== "" && host?.querySelector(`label[for="${entry.id}"]`)?.textContent === label)
  );
  if (!button) throw new Error(`Missing button ${label}`);
  act(() => button.click());
}
function input(selector: string, value: string) {
  const element = find<HTMLInputElement | HTMLSelectElement>(selector);
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  act(() => {
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })
    );
  });
}
describe("flow editing marks", () => {
  it("opens marked nodes and groups with Enter and Space", () => {
    const opened: string[] = [];
    render(
      createElement(
        "div",
        null,
        createElement(FlowNode, {
          title: "Node",
          change: "new",
          label: "Node, New",
          onOpen: () => opened.push("node")
        }),
        createElement(FlowGroup, {
          title: "Group",
          change: "changed",
          label: "Group, Changed",
          onOpen: () => opened.push("group")
        })
      )
    );
    for (const [slot, key] of [
      ["flow-node", "Enter"],
      ["flow-group", " "]
    ]) {
      const element = find<HTMLElement>(`[data-slot="${slot}"]`);
      expect(element.tabIndex).toBe(0);
      act(() => {
        element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    }
    expect(opened).toEqual(["node", "group"]);
  });

  it("refuses a disabled press and draws no hidden point", () => {
    let count = 0;
    render(
      createElement(
        "div",
        null,
        createElement(FlowInsertPoint, { label: "Add after Load", onClick: () => count++ }),
        createElement(FlowInsertPoint, {
          label: "Unavailable",
          disabled: true,
          onClick: () => count++
        }),
        createElement(FlowInsertPoint, { label: "Hidden", hidden: true })
      )
    );
    click("Add after Load");
    click("Unavailable");
    expect(count).toBe(1);
    expect(host?.querySelector('[aria-label="Hidden"]')).toBeNull();
  });
});

const graphNode = (id: string, extra: Partial<FlowGraphNode> = {}): FlowGraphNode => ({
  id,
  kind: "step",
  eyebrow: "Step",
  title: `Title ${id}`,
  ...extra
});
/** A start, a loop of two steps, a condition with two exits and a step on one of them. */
const draftGraph: FlowGraph = {
  nodes: [
    graphNode("start"),
    graphNode("a", { parentId: "loop", action: { label: "Act on a" } }),
    graphNode("b", { parentId: "loop" }),
    graphNode("branch", {
      kind: "condition",
      exits: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" }
      ]
    }),
    graphNode("after")
  ],
  groups: [{ id: "loop", kind: "loop", eyebrow: "Loop", title: "Title loop" }],
  edges: [
    { source: "start", target: "loop" },
    { source: "a", target: "b" },
    { source: "loop", target: "branch" },
    { source: "branch", target: "after", sourceExit: "yes" }
  ]
};

/** The canvas measures its box, which a document without layout reports as empty. */
function withCanvasSize() {
  const sizes = { clientWidth: 1200, clientHeight: 700 };
  for (const [name, value] of Object.entries(sizes)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
  return () => {
    for (const name of Object.keys(sizes)) {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  };
}

async function renderCanvas(props: Partial<FlowCanvasProps>) {
  host = document.createElement("div");
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  // The engine is loaded by a promise the canvas suspends on, so the render is awaited.
  await act(async () =>
    created.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(FlowCanvas, {
          graph: draftGraph,
          label: "Draft",
          emptyLabel: "Nothing",
          ...props
        })
      )
    )
  );
  // The engine is its own chunk: it arrives after the first render.
  for (let attempt = 0; attempt < 300; attempt++) {
    if (host?.querySelector("[data-flow-id]")) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/** The parts and points in the order the document has them, which is the order of Tab. */
function flowOrder(): string[] {
  return Array.from(host?.querySelectorAll<HTMLElement>("[data-flow-id], [data-place]") ?? []).map(
    (element) => element.dataset.flowId ?? element.dataset.place ?? ""
  );
}

describe("insert points on the canvas", () => {
  let restore: (() => void) | undefined;
  beforeEach(() => {
    restore = withCanvasSize();
  });
  afterEach(() => {
    restore?.();
  });

  it("stands on every edge, every exit row and the end of every open group, in the flow's order", async () => {
    await renderCanvas({
      onSelect: () => {},
      insertPoints: { mode: "add", label: (place) => `Add at ${place.kind}`, onPress: () => {} }
    });
    expect(flowOrder()).toEqual([
      "start",
      "edge:start:loop",
      "loop",
      "a",
      "edge:a:b",
      "b",
      "end:loop",
      "edge:loop:branch",
      "branch",
      "exit:branch:yes",
      "exit:branch:no",
      "after"
    ]);
    // An exit's point stands in its row, and an edge that leaves an exit has no second one.
    expect(find('[data-exit="yes"] [data-place="exit:branch:yes"]')).toBeDefined();
    expect(host?.querySelector('[data-place="edge:branch:after"]')).toBeNull();
    // Tab reaches every part and point, nothing else, in that order.
    const focusable = Array.from(
      host?.querySelectorAll<HTMLElement>("[data-flow-id], [data-place]") ?? []
    ).filter((element) => element.tabIndex >= 0);
    expect(focusable.map((element) => element.dataset.flowId ?? element.dataset.place)).toEqual(
      flowOrder()
    );
  });

  it("reports the place that was pressed and opens nothing", async () => {
    const pressed: FlowInsertPlace[] = [];
    const selected: (string | undefined)[] = [];
    await renderCanvas({
      onSelect: (id) => selected.push(id),
      insertPoints: {
        mode: "add",
        label: (place) => `Add at ${place.kind}`,
        onPress: (place) => pressed.push(place)
      }
    });
    for (const key of ["edge:start:loop", "exit:branch:no", "end:loop"]) {
      act(() => find<HTMLButtonElement>(`[data-place="${key}"]`).click());
    }
    expect(pressed).toEqual([
      { kind: "edge", source: "start", target: "loop", edgeId: undefined },
      { kind: "exit", nodeId: "branch", exitId: "no" },
      { kind: "end", groupId: "loop" }
    ]);
    expect(selected).toEqual([]);
  });

  it("turns every point into a Move here target, the nodes' own controls off and ends on Escape", async () => {
    let cancelled = 0;
    const selected: (string | undefined)[] = [];
    await renderCanvas({
      onSelect: (id) => selected.push(id),
      insertPoints: {
        mode: "move",
        label: (place) => (place.kind === "edge" ? `nach ${place.source}` : place.kind),
        shows: (place) => !(place.kind === "edge" && place.source === "a"),
        onPress: () => {},
        onCancel: () => cancelled++
      }
    });
    const targets = Array.from(host?.querySelectorAll<HTMLElement>("[data-target]") ?? []);
    expect(targets.map((target) => target.dataset.place)).toEqual([
      "edge:start:loop",
      "end:loop",
      "edge:loop:branch",
      "exit:branch:yes",
      "exit:branch:no"
    ]);
    // No node can be opened or acted on while a step moves.
    for (const part of Array.from(host?.querySelectorAll<HTMLElement>("[data-flow-id]") ?? [])) {
      expect(part.tabIndex).toBe(-1);
    }
    expect(host?.textContent).not.toContain("Act on a");
    act(() => find<HTMLElement>('[data-flow-id="a"]').click());
    expect(selected).toEqual([]);
    act(() => {
      targets[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(cancelled).toBe(1);
  });
});

describe("where insert points stand", () => {
  const sizes = new Map(
    ["start", "a", "b", "branch", "after"].map((id) => [id, { width: 216, height: 80 }])
  );
  it("halfway along an edge and in room of their own at a group's end", () => {
    const layout = layoutFlow({ graph: draftGraph, direction: "horizontal", sizes, room: "point" });
    const spots = flowInsertSpots(draftGraph, layout);
    const box = (id: string) => {
      const found = layout.boxes.get(id);
      if (!found) throw new Error(`Missing box ${id}`);
      return found;
    };
    const spot = (key: string) => {
      const found = spots.find(
        (candidate) =>
          (candidate.place.kind === "edge"
            ? `edge:${candidate.place.source}:${candidate.place.target}`
            : `end:${candidate.place.groupId}`) === key
      );
      if (!found) throw new Error(`Missing spot ${key}`);
      return found;
    };
    const start = box("start");
    const loop = box("loop");
    const edge = spot("edge:start:loop");
    expect(edge.x).toBeCloseTo((start.x + start.width + loop.x) / 2);
    expect(edge.y).toBeCloseTo((start.y + start.height / 2 + loop.y + loop.height / 2) / 2);
    // Inside a group the parts run top to bottom, far enough apart for a point of 28 px.
    const a = box("a");
    const b = box("b");
    expect(b.y - (a.y + a.height)).toBeGreaterThanOrEqual(28 + 8);
    expect(spot("edge:a:b").y).toBeCloseTo((a.y + a.height + b.y) / 2);
    // The end of the loop is under its last part and inside its frame, clear of both.
    const end = spot("end:loop");
    expect(end.y - 14).toBeGreaterThan(b.y + b.height);
    expect(end.y + 14).toBeLessThan(loop.y + loop.height);
    expect(end.x).toBeCloseTo(loop.x + loop.width / 2);
    // A target is wider than a + and is given the room between parts.
    const moving = layoutFlow({
      graph: draftGraph,
      direction: "horizontal",
      sizes,
      room: "target"
    });
    const movingLoop = moving.boxes.get("loop");
    const movingStart = moving.boxes.get("start");
    expect(
      (movingLoop?.x ?? 0) - ((movingStart?.x ?? 0) + (movingStart?.width ?? 0))
    ).toBeGreaterThanOrEqual(160);
    // Without points the layout keeps its own gaps.
    const plain = layoutFlow({ graph: draftGraph, direction: "horizontal", sizes });
    const plainA = plain.boxes.get("a");
    const plainB = plain.boxes.get("b");
    expect((plainB?.y ?? 0) - ((plainA?.y ?? 0) + (plainA?.height ?? 0))).toBe(22);
  });
});

function ValueHarness({
  initial,
  kind,
  readOnly = false,
  pickedOnly = false,
  error
}: {
  initial: SourcedValue;
  kind?: SourcedValueKind;
  readOnly?: boolean;
  pickedOnly?: boolean;
  error?: string;
}) {
  const [value, setValue] = useState(initial);
  return createElement(
    "div",
    null,
    createElement(SourcedValueField, {
      label: "Amount",
      value,
      onChange: setValue,
      kind,
      readOnly,
      error,
      pickedOnly,
      options: [
        { value: "earlier", label: "Earlier result" },
        { heading: "Load the clients", options: [{ value: "clients", label: "The clients" }] }
      ],
      choices: [{ value: "yes", label: "Yes" }]
    }),
    createElement("output", null, JSON.stringify(value))
  );
}

describe("SourcedValueField", () => {
  it.each<SourcedValueKind>(["number", "boolean", "select"])(
    "uses the fixed %s control",
    (kind) => {
      render(
        createElement(ValueHarness, {
          initial: { kind: "fixed", value: kind === "boolean" ? true : "" },
          kind
        })
      );
      if (kind === "boolean")
        expect(find('[role="switch"]').getAttribute("aria-checked")).toBe("true");
      if (kind === "select") {
        input("select", "yes");
        expect(host?.querySelector("output")?.textContent).toContain('"value":"yes"');
      }
      if (kind === "number") {
        input("input", "12");
        expect(host?.querySelector("output")?.textContent).toContain('"value":12');
        input("input", "");
        expect(host?.querySelector("output")?.textContent).toContain('"value":null');
      }
    }
  );
  it("switches from a reference to a fixed value without exposing the reference id", () => {
    render(
      createElement(ValueHarness, {
        initial: { kind: "picked", option: "earlier" },
        error: "Choose an earlier step"
      })
    );
    click("Fixed");
    expect(host?.querySelector("output")?.textContent).toBe('{"kind":"fixed","value":""}');
    input("input", "A fixed value");
    expect(host?.querySelector("output")?.textContent).toContain("A fixed value");
  });
  it("offers only a value from a step, with no toggle, when it is picked only", () => {
    render(
      createElement(ValueHarness, {
        initial: { kind: "picked", option: "earlier" },
        pickedOnly: true
      })
    );
    expect(host?.querySelector('[role="radio"]')).toBeNull();
    expect(host?.querySelector("input")).toBeNull();
  });
  it("keeps a read-only reference readable and prevents mode changes", () => {
    render(
      createElement(ValueHarness, {
        initial: { kind: "picked", option: "earlier" },
        readOnly: true
      })
    );
    expect(find<HTMLInputElement>("input").value).toBe("Earlier result");
    expect(find<HTMLInputElement>("input").readOnly).toBe(true);
    expect(
      Array.from(host?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []).every(
        (entry) => entry.disabled
      )
    ).toBe(true);
  });
});

const kinds: readonly FieldListKind[] = [
  { value: "text", label: "Text" },
  { value: "choice", label: "One of a list", choices: true },
  { value: "record", label: "Record", children: "record" },
  { value: "records", label: "Records", children: "records" }
];
const fields: readonly FieldListItem[] = [
  { id: "a", name: "First", kind: "text", required: true },
  {
    id: "b",
    name: "Second",
    kind: "record",
    required: false,
    fields: [{ id: "c", name: "Nested", kind: "text", required: false }]
  },
  { id: "d", name: "Status", kind: "choice", required: true, choices: ["Open", "Done"] }
];
function ListHarness({
  readOnly = false,
  initial = fields,
  error
}: {
  readOnly?: boolean;
  initial?: readonly FieldListItem[];
  error?: string;
}) {
  const [value, setValue] = useState(initial);
  return createElement(
    "div",
    null,
    createElement(FieldListEditor, {
      label: "Answers with",
      value,
      kinds,
      onChange: setValue,
      readOnly,
      error,
      errors: { a: { name: "Name is taken" }, d: { choices: "Give two choices" } }
    }),
    createElement("output", null, JSON.stringify(value))
  );
}
describe("FieldListEditor", () => {
  it("adds, removes and reorders by stable identity and edits a nested field", () => {
    render(createElement(ListHarness));
    click("Move down: First");
    expect(find("output").textContent?.indexOf('"id":"b"')).toBeLessThan(
      find("output").textContent?.indexOf('"id":"a"') ?? 0
    );
    input('[data-field-id="c"] input', "Child");
    expect(find("output").textContent).toContain('"name":"Child"');
    expect(find('[data-field-id="c"] select').querySelectorAll("option")).toHaveLength(2);
    click("Remove: First");
    expect(find("output").textContent).not.toContain('"id":"a"');
    const add = Array.from(host?.querySelectorAll("button") ?? [])
      .filter((button) => button.textContent === "Add field")
      .at(-1);
    act(() => add?.click());
    expect(find("output").textContent).toContain('"name":""');
    expect(host?.querySelectorAll("[data-field-id]")).toHaveLength(4);
  });
  it("edits the choices of a kind that has them", () => {
    render(createElement(ListHarness));
    const choices = () =>
      Array.from(
        host?.querySelectorAll<HTMLInputElement>('[data-field-id="d"] [data-choice] input') ?? []
      );
    expect(choices().map((entry) => entry.value)).toEqual(["Open", "Done"]);
    input('[data-field-id="d"] [data-choice="1"] input', "Closed");
    click("Add choice");
    input('[data-field-id="d"] [data-choice="2"] input', "Waiting");
    click("Remove: Open");
    expect(find("output").textContent).toContain('"choices":["Closed","Waiting"]');
    // A kind with choices starts with one to fill; another kind drops them.
    input('[data-field-id="a"] select', "choice");
    expect(find("output").textContent).toContain(
      '"id":"a","name":"First","kind":"choice","required":true,"choices":[""]'
    );
    input('[data-field-id="d"] select', "text");
    expect(find("output").textContent).not.toContain("Closed");
    expect(host?.querySelector('[data-field-id="d"] [data-field-choices]')).toBeNull();
  });
  it("moves the focus to a neighbour when a field or a choice is removed", () => {
    render(createElement(ListHarness));
    const active = () =>
      document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent;
    click("Remove: First");
    expect(active()).toBe("Remove: Second");
    click("Remove: Status");
    expect(active()).toBe("Remove: Second");
    click("Remove: Nested");
    expect(active()).toBe("Add field");
    expect(document.activeElement?.closest('[data-field-id="b"]')).not.toBeNull();
    click("Remove: Second");
    expect(active()).toBe("Add field");
    expect(document.activeElement).not.toBe(document.body);
  });
  it("makes every value read-only", () => {
    render(createElement(ListHarness, { readOnly: true }));
    expect(Array.from(host?.querySelectorAll("input") ?? []).every((entry) => entry.readOnly)).toBe(
      true
    );
    expect(host?.querySelector('[aria-label="Remove: First"]')).toBeNull();
    expect(host?.querySelector('[aria-label="Remove: Open"]')).toBeNull();
    expect(host?.textContent).not.toContain("Add choice");
    expect(
      Array.from(host?.querySelectorAll("select") ?? []).every((entry) => entry.disabled)
    ).toBe(true);
  });
  it("drops nested fields when the caller chooses a scalar kind", () => {
    render(createElement(ListHarness));
    input('[data-field-id="b"] select', "text");
    expect(find("output").textContent).not.toContain('"id":"c"');
  });
  it("edits a field's title and shows its key as a detail, where titled", () => {
    function Titled() {
      const [value, setValue] = useState<readonly FieldListItem[]>([
        { id: "a", name: "month", title: "Month", kind: "text", required: false }
      ]);
      return createElement(FieldListEditor, {
        label: "Asks for",
        value,
        kinds,
        onChange: setValue,
        titled: true,
        keyHint: "steps read it by this key"
      });
    }
    render(createElement(Titled));
    const field = find('[data-field-id="a"]');
    expect(field.querySelector("legend")?.textContent).toBe("Month");
    input('[data-field-id="a"] input', "Billing month");
    // The key is the caller's: the editor changes only the title.
    expect(field.querySelector("legend")?.textContent).toBe("Billing month");
    expect(find('[data-field-id="a"] [data-field-key]').textContent).toContain("month");
    // A field without a title yet is called by its place in the list.
    input('[data-field-id="a"] input', "");
    expect(field.querySelector("legend")?.textContent).toBe("Field 1");
  });
});

function ScheduleHarness({
  initial,
  readOnly = false
}: {
  initial: ScheduleValue;
  readOnly?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return createElement(
    "div",
    null,
    createElement(ScheduleField, { label: "Starts", value, onChange: setValue, readOnly }),
    createElement("output", null, JSON.stringify(value))
  );
}
describe("ScheduleField", () => {
  it("changes all five forms while preserving the time and zone", () => {
    render(
      createElement(ScheduleHarness, {
        initial: { kind: "day", time: "06:15", zone: "Europe/Berlin" }
      })
    );
    input("select", "week");
    click("Monday");
    click("Friday");
    expect(find("output").textContent).toBe(
      '{"kind":"week","time":"06:15","zone":"Europe/Berlin","days":[5]}'
    );
    input("select", "month");
    const selects = host?.querySelectorAll<HTMLSelectElement>("select");
    act(() => {
      if (selects?.[1]) {
        selects[1].value = "31";
        selects[1].dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(find("output").textContent).toContain('"day":31');
    input("select", "weekday");
    expect(find("output").textContent).toContain('"kind":"weekday"');
    input("select", "hour");
    expect(find("output").textContent).toContain('"minute":15');
    input("select", "day");
    expect(find("output").textContent).toContain('"time":"09:15"');
  });
  it("keeps a read-only schedule and its zone unchangeable", () => {
    render(
      createElement(ScheduleHarness, {
        initial: { kind: "day", time: "09:00", zone: "Europe/Berlin" },
        readOnly: true
      })
    );
    expect(find<HTMLSelectElement>("select").disabled).toBe(true);
    expect(find<HTMLInputElement>('input[type="time"]').readOnly).toBe(true);
    expect(
      Array.from(host?.querySelectorAll<HTMLInputElement>("input") ?? []).at(-1)?.readOnly
    ).toBe(true);
  });
  it("names the zone in words and keeps its id inside", () => {
    render(
      createElement(ScheduleHarness, {
        initial: { kind: "day", time: "09:00", zone: "America/New_York" }
      })
    );
    expect(find('[data-slot="schedule-field"]').textContent).not.toContain("America");
    act(() => find<HTMLButtonElement>('[aria-haspopup="dialog"]').click());
    const vienna = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === "Vienna time"
    );
    expect(vienna).toBeDefined();
    act(() => vienna?.click());
    expect(find("output").textContent).toContain('"zone":"Europe/Vienna"');
  });
  it("refuses a zone it does not know and says so under the zone", () => {
    render(
      createElement(ScheduleHarness, {
        initial: { kind: "day", time: "09:00", zone: "Mars/Olympus" }
      })
    );
    expect(find('[aria-haspopup="dialog"]').getAttribute("aria-invalid")).toBe("true");
    expect(isScheduleZone("Europe/Berlin")).toBe(true);
    expect(isScheduleZone("UTC")).toBe(true);
    expect(isScheduleZone("Mars/Olympus")).toBe(false);
    expect(isScheduleZone("")).toBe(false);
  });
  it("shows no zone where the zone is not the person's to choose, and keeps it", () => {
    let changed: ScheduleValue | undefined;
    render(
      createElement(ScheduleField, {
        label: "Full pass",
        value: { kind: "day", time: "02:00", zone: "Europe/Berlin" },
        zonePicker: false,
        onChange: (value: ScheduleValue) => {
          changed = value;
        }
      })
    );
    expect(host?.querySelector('[aria-haspopup="dialog"]')).toBeNull();
    input("select", "weekday");
    expect(changed).toEqual({ kind: "weekday", time: "02:00", zone: "Europe/Berlin" });
  });
});

describe("SidePanel editing", () => {
  it("keeps the footer out of the scroll body and closes on Escape", () => {
    let closed = false;
    render(
      createElement(SidePanel, {
        open: true,
        title: "Settings",
        tall: true,
        mode: "sheet",
        onClose: () => {
          closed = true;
        },
        children: "Fields",
        footer: "Save"
      })
    );
    const body = find('[data-slot="side-panel-body"]');
    const footer = find('[data-slot="side-panel-footer"]');
    expect(body.contains(footer)).toBe(false);
    expect(body.nextElementSibling).toBe(footer);
    act(() => {
      body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(closed).toBe(true);
  });
});

describe("library labels", () => {
  it("are each said by a library component, not only by the gallery", () => {
    const sourceDir = join(process.cwd(), "packages/ui/src");
    const files = readdirSync(sourceDir, { recursive: true, encoding: "utf8" }).filter(
      (file) => /\.tsx?$/u.test(file) && !file.startsWith(`gallery${sep}`) && file !== "labels.ts"
    );
    const source = files.map((file) => readFileSync(join(sourceDir, file), "utf8")).join("\n");
    // Unused already on main before the editing parts; not theirs to remove.
    const older = new Set(["clear"]);
    const unused = Object.keys(uiLabelsEn).filter(
      (key) => !older.has(key) && !source.includes(`labels.${key}`) && !source.includes(`"${key}"`)
    );
    expect(unused).toEqual([]);
  });
});
