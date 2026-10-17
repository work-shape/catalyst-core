// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
import { ToolCallPart, ToolSubjectsProvider } from "@work-shape/catalyst-chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

// The work history in words (UXA-7b). Each row says what happened: the operation and the
// Connection with the rows read, the title of any other step, "Showed a table" for a view, and
// a failed step says so. The input and output stand behind "Technical details", which is
// closed and puts nothing of them in the page until it is opened.

const TOP_CUSTOMERS = "connection.sample-business.top_customers";

const agents = [
  {
    connections: [
      {
        name: "sample-business",
        title: "Sample business",
        connectorType: "postgres",
        tools: [{ toolName: TOP_CUSTOMERS, effect: "reading" as const }]
      }
    ]
  }
];

const fiveRows = {
  content: [],
  structuredContent: {
    rows: [1, 2, 3, 4, 5].map((rank) => ({ rank, customer: `Customer ${rank}` })),
    total: 42
  }
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(
  call: {
    toolName: string;
    args?: Record<string, string | number>;
    result?: unknown;
    isError?: boolean;
  },
  locale: "en" | "de" = "en"
) {
  const args = call.args ?? { limit: 5 };
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale, children: null },
          createElement(
            ToolDisplayPanelProvider,
            null,
            createElement(
              ToolSubjectsProvider,
              { agents, children: null },
              createElement(ToolCallPart, {
                toolName: call.toolName,
                toolCallId: "call_1",
                args,
                argsText: JSON.stringify(args),
                result: call.result,
                isError: call.isError,
                type: "tool-call" as const,
                status: { type: "complete" as const },
                displayPresentation: "summary",
                addResult: () => undefined,
                resume: () => undefined,
                respondToApproval: () => undefined
              })
            )
          )
        )
      )
    )
  );
}

/** The words of the row: the line that opens the step. */
function rowText(): string {
  const row =
    host.querySelector('[data-testid="tool-call-sentence"]') ??
    host.querySelector('[data-testid="tool-call-row"]');
  return row?.textContent ?? "";
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name
  );
  if (!found) {
    throw new Error(`No button "${name}"`);
  }
  return found;
}

function click(element: HTMLElement) {
  act(() => element.click());
}

/** Opens the step's row, as a person clicks it. */
function openRow() {
  const row = host.querySelector<HTMLButtonElement>(
    '[data-testid="tool-call-card"] > button[aria-expanded]'
  );
  if (!row) {
    throw new Error("The step has no row to open");
  }
  if (row.getAttribute("aria-expanded") !== "true") {
    click(row);
  }
}

describe("the work history in words", () => {
  it("names the operation and the Connection of a read, with the rows it read", () => {
    render({ toolName: TOP_CUSTOMERS, result: fiveRows });
    expect(rowText()).toBe("Read top customers from Sample business · 5 rows");

    render({ toolName: TOP_CUSTOMERS, result: fiveRows }, "de");
    expect(rowText()).toBe("Top customers aus Sample business gelesen · 5 Zeilen");

    render({ toolName: TOP_CUSTOMERS, result: { structuredContent: { rows: [{}] } } });
    expect(rowText()).toBe("Read top customers from Sample business · 1 row");

    // Rows are records: an array of anything else gives no count.
    render({ toolName: TOP_CUSTOMERS, result: { rows: [null, 42] } });
    expect(rowText()).toBe("Read top customers from Sample business");
  });

  it("says what a view showed and gives any other step its title, without a status word", () => {
    render({
      toolName: "show_view",
      args: { html: "<table><tr><td>1</td></tr></table>", mode: "inline" },
      result: {
        output: { displayed: true },
        display: {
          kind: "html.rendered",
          version: 2,
          mode: "inline",
          data: { html: "<table><tr><td>1</td></tr></table>" }
        }
      }
    });
    expect(rowText()).toBe("Showed a table");

    render({ toolName: "read_skill", args: { name: "offers" }, result: {} }, "de");
    expect(rowText()).toBe("Anleitung lesen");
    expect(host.textContent).not.toContain("Abgeschlossen");
  });

  it("turns a name without a title into words, never the raw key", () => {
    render({ toolName: "demo.workflow_summary", result: { output: { ok: true } } });
    expect(rowText()).toBe("Workflow Summary");
    const row = host.querySelector('[data-testid="tool-call-card"] > button');
    expect(row?.textContent).not.toContain("demo.workflow_summary");
    expect(row?.textContent).not.toContain("workflow_summary");
  });

  it("says in words that a step failed, and why where the output is a sentence", () => {
    const why = "Sample business cannot be reached right now. Try again later.";
    render({ toolName: TOP_CUSTOMERS, result: { error: why }, isError: true });
    expect(rowText()).toBe("Could not read top customers from Sample business");
    openRow();
    expect(host.textContent).toContain(why);

    render({ toolName: "demo.workflow_summary", result: { error: why }, isError: true }, "de");
    expect(rowText()).toBe("Fehlgeschlagen: Workflow Summary");
  });

  it("keeps the input and output out of the page until Technical details is opened", () => {
    render({ toolName: TOP_CUSTOMERS, args: { limit: 5 }, result: fiveRows });
    openRow();
    const details = button("Technical details");
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("pre")).toBeNull();
    expect(host.textContent).not.toContain('"limit"');
    expect(host.textContent).not.toContain("Customer 3");
    expect(host.textContent).not.toContain(TOP_CUSTOMERS);

    click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("pre")?.textContent).toContain('"limit":5');
    expect(host.textContent).toContain("Customer 3");
    expect(host.textContent).toContain(TOP_CUSTOMERS);
  });

  it("keeps a failed step's input and output closed as well", () => {
    render({ toolName: TOP_CUSTOMERS, result: { error: "It failed." }, isError: true });
    openRow();
    expect(button("Technical details").getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("pre")).toBeNull();
  });
});
