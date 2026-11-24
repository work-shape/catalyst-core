// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslationProvider } from "./support/chat-ui/shared";
import { ToolCallPart, ToolSubjectsProvider } from "@work-shape/catalyst-chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { ViewPolicyProvider } from "@work-shape/catalyst-chat-ui/views";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { required } from "./support/assertions";

// The work history (UXA-7b): the rows a read returned are counted, a failed step says why, and
// the input and output stand behind "Technical details", closed until it is opened.

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
  vi.restoreAllMocks();
});

function render(call: {
  toolName: string;
  args?: Record<string, string | number>;
  result?: unknown;
  isError?: boolean;
}) {
  const args = call.args ?? { limit: 5 };
  const part = createElement(ToolCallPart, {
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
  });
  act(() =>
    root.render(
      createElement(
        WorkspaceApiClientProvider,
        { apiBaseUrl: "https://chat.example.com", children: null },
        createElement(
          ViewPolicyProvider,
          { allowedScriptSrc: [], children: null },
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(
              TranslationProvider,
              { locale: "en", children: null },
              createElement(
                ToolDisplayPanelProvider,
                null,
                createElement(ToolSubjectsProvider, { agents, children: null }, part)
              )
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
  it("counts the rows a read returned, and only records", () => {
    render({ toolName: TOP_CUSTOMERS, result: fiveRows });
    expect(rowText()).toContain("5 rows");

    render({ toolName: TOP_CUSTOMERS, result: { structuredContent: { rows: [{}] } } });
    expect(rowText()).toContain("1 row");

    // Rows are records: an array of anything else gives no count.
    render({ toolName: TOP_CUSTOMERS, result: { rows: [null, 42] } });
    expect(rowText()).not.toContain("row");
  });

  it("says why a step failed where the output is a sentence", () => {
    const why = "Sample business cannot be reached right now. Try again later.";
    render({ toolName: TOP_CUSTOMERS, result: { error: why }, isError: true });
    openRow();
    expect(host.textContent).toContain(why);
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

  it("shows the overview a step showed again as soon as its row is drawn", () => {
    // The row is drawn when the person opens its group in the work history: that one click
    // shows the overview. Fails without the change: the row was closed and, opened, showed the
    // step's technical details only, so an overview could not be seen again.
    // happy-dom loads no frame page; a browser reports no error event on a frame.
    const dispatch = HTMLIFrameElement.prototype.dispatchEvent;
    vi.spyOn(HTMLIFrameElement.prototype, "dispatchEvent").mockImplementation(function (
      this: HTMLIFrameElement,
      event: Event
    ) {
      return event.type === "error" ? true : dispatch.call(this, event);
    });
    render({
      toolName: "show_view",
      args: { title: "Proposal", mode: "inline" },
      result: {
        output: { displayed: true },
        display: {
          kind: "html.rendered",
          version: 2,
          mode: "inline",
          title: "Proposal",
          data: { title: "Proposal", html: "<p>Split the skill in two.</p>" }
        }
      }
    });
    expect(rowText()).toBe("Showed an overview");
    expect(host.querySelector('iframe[title="Proposal"]')).not.toBeNull();
    // The row folds it away and opens it again.
    const row = host.querySelector<HTMLButtonElement>('[data-testid="tool-call-card"] > button');
    click(required(row));
    expect(host.querySelector('iframe[title="Proposal"]')).toBeNull();
    click(required(row));
    expect(host.querySelector('iframe[title="Proposal"]')).not.toBeNull();
  });

  it("opens a side-panel view a step showed beside the conversation from its row", () => {
    render({
      toolName: "show_view",
      args: { title: "Proposal", mode: "side_panel" },
      result: {
        output: { displayed: true },
        display: {
          kind: "html.rendered",
          version: 2,
          mode: "side_panel",
          title: "Proposal",
          data: { title: "Proposal", html: "<p>Split the skill in two.</p>" }
        }
      }
    });
    expect(rowText()).toBe("Showed an overview");
    const row = host.querySelector<HTMLButtonElement>('[data-testid="tool-call-card"] > button');
    expect(row?.textContent).toContain("Open");
    click(required(row));
    expect(row?.textContent).toContain("Shown");
  });
});
