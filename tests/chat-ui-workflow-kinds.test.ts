// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranslationProvider } from "./support/chat-ui/shared";
import {
  WorkflowRunsPageView,
  WorkflowsPageView,
  toWorkflow,
  toWorkflowListItem,
  toWorkflowRun,
  type WorkflowRunList
} from "@work-shape/catalyst-chat-ui/workflows";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

// WF-KIND in a browser: the choice of a kind on the Workflows page and a folded stretch of
// empty runs that the reader opens, which stays open while older runs load.

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

const noop = () => undefined;
const now = new Date("2026-10-12T09:12:00.000Z");

function show(node: ReactNode) {
  act(() => {
    root.render(
      createElement(
        TranslationProvider,
        { locale: "en", children: null },
        createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, node)
      )
    );
  });
}

function runLinks(): string[] {
  return [...host.querySelectorAll("a")]
    .map((link) => link.getAttribute("href") ?? "")
    .filter((href) => href.includes("/runs/"))
    .map((href) => href.slice(href.lastIndexOf("/") + 1));
}

describe("the Workflows page by kind", () => {
  it("lists every Workflow at first, one kind once the reader chooses it, and all again after", () => {
    const rows = [
      toWorkflowListItem({ id: "notify-clients", name: "Notify clients" }),
      toWorkflowListItem({ id: "invoice-import", name: "Invoice import", kind: "data" })
    ];
    show(
      createElement(WorkflowsPageView, {
        workspaceId: "cw_1",
        list: {
          rows,
          failed: false,
          hasMore: false,
          loadingMore: false,
          loadMore: noop,
          retry: noop
        },
        now,
        runsAvailable: true,
        onOpenRoute: noop,
        onStart: noop
      })
    );
    const text = () => host.textContent ?? "";
    // Nothing waits behind a filter: both kinds stand on the list, All chosen.
    expect(text()).toContain("Notify clients");
    expect(text()).toContain("Invoice import");
    const choice = (label: string) => {
      const radio = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) =>
        button.textContent?.startsWith(label)
      );
      if (!radio) throw new Error(`No ${label} choice.`);
      return radio;
    };
    expect(choice("All").getAttribute("aria-checked")).toBe("true");
    expect(choice("All").textContent).toBe("All2");

    act(() => choice("Data flows").click());
    expect(choice("Data flows").getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("Invoice import");
    expect(text()).not.toContain("Notify clients");

    act(() => choice("Processes").click());
    expect(text()).toContain("Notify clients");
    expect(text()).not.toContain("Invoice import");

    act(() => choice("All").click());
    expect(text()).toContain("Notify clients");
    expect(text()).toContain("Invoice import");
  });
});

describe("folded empty runs", () => {
  const workflow = toWorkflow(
    {
      name: "invoice-import",
      config: {
        id: "invoice-import",
        name: "Invoice import",
        kind: "data",
        runAs: "importer",
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [{ id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] }],
        wiring: []
      },
      publishedRevision: 1
    },
    { mayStart: true }
  );
  const run = (id: string, empty: boolean) =>
    toWorkflowRun({
      id,
      workflow: "invoice-import",
      trigger: "schedule",
      status: "done",
      startedBy: { id: "sp_1", label: "Importer" },
      createdAt: `2026-10-12T0${id.slice(-1)}:00:00.000Z`,
      empty
    });
  const list = (rows: WorkflowRunList["rows"], hasMore: boolean): WorkflowRunList => ({
    rows,
    failed: false,
    hasMore,
    loadingMore: false,
    loadMore: noop,
    retry: noop
  });
  const page = (runs: WorkflowRunList) =>
    createElement(WorkflowRunsPageView, {
      workspaceId: "cw_1",
      workflowId: "invoice-import",
      workflow,
      runs,
      runsAvailable: true,
      now,
      onStart: noop,
      onOpenRoute: noop
    });

  it("opens to a link for each run it holds, and stays open while older runs load into it", () => {
    const first = [run("wr_9", false), run("wr_8", true), run("wr_7", true), run("wr_6", true)];
    show(page(list(first, true)));
    expect(runLinks()).toEqual(["wr_9"]);
    const toggle = host.querySelector<HTMLButtonElement>("[data-empty-runs] button");
    if (!toggle) throw new Error("No folded row.");
    expect(toggle.textContent).toContain("3 empty runs");
    act(() => toggle.click());
    expect(runLinks()).toEqual(["wr_9", "wr_8", "wr_7", "wr_6"]);

    // The next page continues the stretch with two more empty runs and ends it with one that
    // did something: the row counts five, stays open, and the page still offers more.
    show(page(list([...first, run("wr_5", true), run("wr_4", true), run("wr_3", false)], true)));
    expect(host.querySelector("[data-empty-runs]")?.getAttribute("data-empty-runs")).toBe("5");
    expect(runLinks()).toEqual(["wr_9", "wr_8", "wr_7", "wr_6", "wr_5", "wr_4", "wr_3"]);
    expect(host.textContent).toContain("Show more");

    // Folded again, the runs it holds are behind it once more.
    const again = host.querySelector<HTMLButtonElement>("[data-empty-runs] button");
    act(() => again?.click());
    expect(runLinks()).toEqual(["wr_9", "wr_3"]);
  });
});
