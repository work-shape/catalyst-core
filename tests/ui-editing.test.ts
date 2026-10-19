// @vitest-environment happy-dom

import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  FieldListEditor,
  FlowGroup,
  FlowInsertPoint,
  FlowNode,
  ScheduleField,
  SidePanel,
  SourcedValueField,
  UiRoot,
  uiLabelsDe,
  uiLabelsEn,
  type FieldListItem,
  type FieldListKind,
  type FlowChange,
  type FlowStatus,
  type ScheduleValue,
  type SourcedValue,
  type SourcedValueKind
} from "@work-shape/catalyst-ui";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function render(node: ReactNode, labels = uiLabelsEn) {
  host = document.createElement("div");
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  act(() => created.render(createElement(UiRoot, { mode: "light", labels }, node)));
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
const changes: readonly FlowChange[] = ["new", "changed", "removed", "unsaved"];
const statuses: readonly FlowStatus[] = [
  "idle",
  "running",
  "waiting",
  "done",
  "doneWithFailures",
  "failed",
  "skipped"
];

describe("flow editing marks", () => {
  it.each(changes)("keeps the %s mark alongside every status on nodes and groups", (change) => {
    render(
      createElement(
        "div",
        null,
        statuses.flatMap((status) => [
          createElement(FlowNode, {
            key: `node-${status}`,
            title: "New sentence",
            summary: "Now",
            oldSummary: "Before",
            change,
            status
          }),
          createElement(FlowGroup, {
            key: `group-${status}`,
            title: "Group",
            oldSummary: "Before",
            change,
            status,
            collapsed: true
          })
        ])
      ),
      uiLabelsDe
    );
    const words = {
      new: "Neu",
      changed: "Geändert",
      removed: "Entfernt",
      unsaved: "Nicht gespeichert"
    };
    expect(host?.querySelectorAll('[data-slot="flow-change"]')).toHaveLength(14);
    expect(
      Array.from(host?.querySelectorAll('[data-slot="flow-change"]') ?? []).every(
        (tag) => tag.textContent === words[change]
      )
    ).toBe(true);
    expect(host?.querySelectorAll("del")).toHaveLength(change === "changed" ? 14 : 0);
    const frame = find('[data-slot="flow-frame"]');
    const group = find('[data-slot="flow-group"]');
    if (change !== "removed") {
      expect(frame.classList.contains("border-primary")).toBe(true);
      expect(group.classList.contains("border-primary")).toBe(true);
      expect(frame.classList.contains("border-dashed")).toBe(change !== "changed");
      expect(group.classList.contains("border-solid")).toBe(change === "changed");
    }

    expect(host?.textContent).toContain(uiLabelsDe.stateFailed);
    expect(find('[data-slot="flow-node"]').classList.contains("opacity-55")).toBe(
      change === "removed"
    );
    expect(find('[data-slot="flow-group"]').classList.contains("opacity-55")).toBe(
      change === "removed"
    );
  });

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

  it("inserts on an exit without opening the surrounding node", () => {
    let opened = false;
    let inserted = false;
    render(
      createElement(FlowNode, {
        title: "Branch",
        onOpen: () => {
          opened = true;
        },
        rows: [
          {
            id: "yes",
            label: "Yes",
            handle: createElement(FlowInsertPoint, {
              label: "Add on Yes",
              onClick: () => {
                inserted = true;
              }
            })
          }
        ]
      })
    );
    click("Add on Yes");
    expect(inserted).toBe(true);
    expect(opened).toBe(false);
  });

  it("names insertion locations, hides absent points and refuses disabled activation", () => {
    let count = 0;
    render(
      createElement(
        "div",
        null,
        createElement(FlowInsertPoint, { label: "After Load", onClick: () => count++ }),
        createElement(FlowInsertPoint, { label: "Move here", target: true }),
        createElement(FlowInsertPoint, {
          label: "Unavailable",
          disabled: true,
          onClick: () => count++
        }),
        createElement(FlowInsertPoint, { label: "Hidden", hidden: true })
      )
    );
    click("After Load");
    click("Unavailable");
    expect(count).toBe(1);
    expect(host?.querySelector('[aria-label="Hidden"]')).toBeNull();
    expect(find('[aria-label="Move here"]').hasAttribute("data-target")).toBe(true);
    expect(find('[aria-label="Move here"]').textContent).toBe("Move here");
  });
});

function ValueHarness({
  initial,
  kind,
  readOnly = false,
  error
}: {
  initial: SourcedValue;
  kind?: SourcedValueKind;
  readOnly?: boolean;
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
      options: [{ value: "earlier", label: "Earlier result" }],
      choices: [{ value: "yes", label: "Yes" }]
    }),
    createElement("output", null, JSON.stringify(value))
  );
}

describe("SourcedValueField", () => {
  it.each<SourcedValueKind>(["text", "textarea", "number", "integer", "boolean", "select"])(
    "uses the fixed %s control with a label",
    (kind) => {
      render(
        createElement(ValueHarness, {
          initial: { kind: "fixed", value: kind === "boolean" ? true : "" },
          kind
        })
      );
      const label = find<HTMLLabelElement>("label");
      expect(document.getElementById(label.htmlFor)).not.toBeNull();
      expect(host?.querySelectorAll('[role="radio"]')).toHaveLength(2);
      if (kind === "textarea") expect(host?.querySelector("textarea")).not.toBeNull();
      if (kind === "boolean")
        expect(find('[role="switch"]').getAttribute("aria-checked")).toBe("true");
      if (kind === "select") {
        input("select", "yes");
        expect(host?.querySelector("output")?.textContent).toContain('"value":"yes"');
      }
      if (kind === "number" || kind === "integer") {
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
    expect(find('[aria-haspopup="dialog"]').getAttribute("aria-label")).toBe(
      "Amount: Earlier result"
    );
    expect(find('[aria-haspopup="dialog"]').getAttribute("aria-invalid")).toBe("true");
    expect(find('[role="alert"]').textContent).toBe("Choose an earlier step");
    click("Fixed");
    expect(host?.querySelector("output")?.textContent).toBe('{"kind":"fixed","value":""}');
    input("input", "A fixed value");
    expect(host?.querySelector("output")?.textContent).toContain("A fixed value");
  });
  it("keeps a read-only reference readable and prevents mode changes", () => {
    render(
      createElement(ValueHarness, {
        initial: { kind: "picked", option: "earlier" },
        readOnly: true
      }),
      uiLabelsDe
    );
    expect(find<HTMLInputElement>("input").value).toBe("Earlier result");
    expect(find<HTMLInputElement>("input").readOnly).toBe(true);
    expect(
      Array.from(host?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []).every(
        (entry) => entry.disabled
      )
    ).toBe(true);
    expect(host?.textContent).toContain("Aus einem Schritt");
  });
});

const kinds: readonly FieldListKind[] = [
  { value: "text", label: "Text" },
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
  }
];
function ListHarness({ readOnly = false }: { readOnly?: boolean }) {
  const [value, setValue] = useState(fields);
  return createElement(
    "div",
    null,
    createElement(FieldListEditor, {
      label: "Answers with",
      value,
      kinds,
      onChange: setValue,
      readOnly,
      errors: { a: { name: "Name is taken" } }
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
    expect(find('[data-field-id="c"] select').querySelectorAll("option")).toHaveLength(1);
    click("Remove: First");
    expect(find("output").textContent).not.toContain('"id":"a"');
    const add = Array.from(host?.querySelectorAll("button") ?? [])
      .filter((button) => button.textContent === "Add field")
      .at(-1);
    act(() => add?.click());
    expect(find("output").textContent).toContain('"name":""');
    expect(host?.querySelectorAll("[data-field-id]")).toHaveLength(3);
  });
  it("announces property errors and makes every value read-only", () => {
    render(createElement(ListHarness, { readOnly: true }));
    expect(find('[role="alert"]').textContent).toBe("Name is taken");
    expect(find('[data-field-id="a"] input').getAttribute("aria-invalid")).toBe("true");
    expect(Array.from(host?.querySelectorAll("input") ?? []).every((entry) => entry.readOnly)).toBe(
      true
    );
    expect(host?.querySelector('[aria-label="Remove: First"]')).toBeNull();
    expect(
      Array.from(host?.querySelectorAll("select") ?? []).every((entry) => entry.disabled)
    ).toBe(true);
  });
  it("drops nested fields when the caller chooses a scalar kind", () => {
    render(createElement(ListHarness));
    input('[data-field-id="b"] select', "text");
    expect(find("output").textContent).not.toContain('"id":"c"');
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
  it("has named controls in German and a readable immutable zone", () => {
    render(
      createElement(ScheduleHarness, {
        initial: { kind: "day", time: "09:00", zone: "Europe/Berlin" },
        readOnly: true
      }),
      uiLabelsDe
    );
    expect(host?.textContent).toContain("Zeitzone");
    expect(find<HTMLSelectElement>("select").disabled).toBe(true);
    expect(find<HTMLInputElement>('input[type="time"]').readOnly).toBe(true);
  });
});

describe("SidePanel editing", () => {
  it("keeps the footer after the scroll body and closes on Escape", () => {
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
    expect(find('[data-slot="side-panel"]').classList.contains("h-[92%]")).toBe(true);
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
