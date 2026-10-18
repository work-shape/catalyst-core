// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  WorkflowRunsPageView,
  toWorkflow,
  toWorkflowRun,
  type WorkflowRunList
} from "@work-shape/catalyst-chat-ui/workflows";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

// EW-CAN in the runs list (Events, Workflows And Guardrails check 112): the parts of a run that
// continued as new are one Lauf, `<key>/1`, `/2`, `/3`, with the step runs of its parts summed,
// its labels, and a mark on the part that a republish moved to another version.

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

/** A run as the instance answers it. */
type WorkflowRunResource = Parameters<typeof toWorkflowRun>[0];

const noop = () => undefined;
const now = new Date("2026-10-17T12:00:00.000Z");

const workflow = toWorkflow(
  {
    name: "ledger-import",
    config: {
      id: "ledger-import",
      name: "Ledger import",
      runAs: "importer",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [{ id: "start", name: "Start", type: "trigger", triggers: [{ kind: "schedule" }] }],
      wiring: []
    },
    publishedRevision: 2
  },
  { mayStart: true }
);

/** A part of the Lauf `2026-10-17` whose first part is `wr_1`. */
function part(
  number: number,
  extra: Partial<WorkflowRunResource> & { status: WorkflowRunResource["status"] }
): WorkflowRunResource {
  return {
    id: `wr_${number}`,
    workflow: "ledger-import",
    trigger: "schedule",
    startedBy: { id: "sp_1", label: "Importer" },
    createdAt: `2026-10-17T0${number}:00:00.000Z`,
    startedAt: `2026-10-17T0${number}:00:05.000Z`,
    runKey: "2026-10-17",
    labels: { source: "ledger" },
    definitionRevisionId: "rev_a",
    stepRunCount: 20_000,
    continuation: {
      rootRunId: "wr_1",
      ...(number === 1 ? {} : { previousRunId: `wr_${number - 1}` }),
      number
    },
    ...extra
  };
}

const part1 = part(1, { status: "continued", finishedAt: "2026-10-17T01:59:00.000Z" });
const part2 = part(2, { status: "continued", finishedAt: "2026-10-17T02:59:00.000Z" });
// A republish between part 2 and part 3 moved part 3 to the next version.
const part3 = part(3, { status: "running", definitionRevisionId: "rev_b", stepRunCount: 10_004 });
const other = toWorkflowRun({
  id: "wr_other",
  workflow: "ledger-import",
  trigger: "manual",
  status: "done",
  startedBy: { id: "u_1", label: "Ada" },
  createdAt: "2026-10-17T02:30:00.000Z"
});

function list(rows: WorkflowRunList["rows"], hasMore: boolean): WorkflowRunList {
  return { rows, failed: false, hasMore, loadingMore: false, loadMore: noop, retry: noop };
}

function show(runs: WorkflowRunList, locale: "en" | "de" = "en") {
  const node: ReactNode = createElement(WorkflowRunsPageView, {
    workspaceId: "cw_1",
    workflowId: "ledger-import",
    workflow,
    runs,
    runsAvailable: true,
    now,
    onStart: noop,
    onOpenRoute: noop
  });
  act(() => {
    root.render(
      createElement(
        TranslationProvider,
        { locale, children: null },
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

function group(): HTMLElement {
  const row = host.querySelector<HTMLElement>('[data-run-group="wr_1"]');
  if (!row) throw new Error("No Lauf row.");
  return row;
}

function toggle(): HTMLButtonElement {
  const button = group().querySelector<HTMLButtonElement>("button");
  if (!button) throw new Error("The Lauf row does not unfold.");
  return button;
}

describe("a run that continued as new in the runs list (check 112)", () => {
  it("maps the parts of the wire and reads `continued` as a state", () => {
    const view = toWorkflowRun(part2);
    expect(view.continuation).toEqual({ rootRunId: "wr_1", previousRunId: "wr_1", number: 2 });
    expect(view.labels).toEqual({ source: "ledger" });
    expect(view.stepRuns).toBe(20_000);
    expect(view.ended).toBe(true);
    expect(toWorkflowRun({ ...part2, labels: {} }).labels).toBeUndefined();
  });

  it("shows the parts as one Lauf where its newest part stands, and opens to each part", () => {
    // Newest first: part 3, another run started by hand between the parts, then parts 2 and 1.
    show(list([toWorkflowRun(part3), other, toWorkflowRun(part2), toWorkflowRun(part1)], false));
    expect(host.querySelectorAll("[data-run-group]")).toHaveLength(1);
    expect(group().getAttribute("data-run-parts")).toBe("3");
    // The Lauf stands before the other run, at its newest part.
    expect(runLinks()).toEqual(["wr_other"]);
    const text = group().textContent ?? "";
    expect(text).toContain("key 2026-10-17 · 3 parts · 50,004 steps");
    expect(text).toContain("source: ledger");
    expect(text).toContain("Continued on a newly published version");
    expect(text).toContain("Running");
    // No revision id reaches the reader.
    expect(host.textContent).not.toContain("rev_");

    act(() => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(runLinks()).toEqual(["wr_3", "wr_2", "wr_1", "wr_other"]);
    const parts = [...group().querySelectorAll<HTMLElement>("[data-run-part]")];
    expect(parts.map((row) => row.getAttribute("data-run-part"))).toEqual(["3", "2", "1"]);
    // Each part is one row with one link, to its own run.
    expect(
      parts.map((row) => [...row.querySelectorAll("a")].map((a) => a.getAttribute("href")))
    ).toEqual([
      ["/w/cw_1/workflows/ledger-import/runs/wr_3"],
      ["/w/cw_1/workflows/ledger-import/runs/wr_2"],
      ["/w/cw_1/workflows/ledger-import/runs/wr_1"]
    ]);
    expect(parts.map((row) => row.textContent ?? "")).toEqual([
      expect.stringContaining("2026-10-17/3"),
      expect.stringContaining("2026-10-17/2"),
      expect.stringContaining("2026-10-17/1")
    ]);
    // Only the part a republish moved is marked, and a part that handed on reads Continued.
    expect(parts.map((row) => row.querySelector("[data-revision-changed]") !== null)).toEqual([
      true,
      false,
      false
    ]);
    expect(parts[1]?.textContent).toContain("Continued");

    act(() => toggle().click());
    expect(runLinks()).toEqual(["wr_other"]);
  });

  it("names the loaded parts while earlier ones are to load, and stays open as they arrive", () => {
    show(list([toWorkflowRun(part3), toWorkflowRun(part2)], true));
    const text = () => group().textContent ?? "";
    expect(text()).toContain("parts 2 to 3, earlier ones under Show more");
    expect(text()).toContain("30,004 steps in these parts");
    act(() => toggle().click());
    expect(runLinks()).toEqual(["wr_3", "wr_2"]);

    // The next page brings part 1: the same row counts it and stays open.
    show(list([toWorkflowRun(part3), toWorkflowRun(part2), toWorkflowRun(part1)], false));
    expect(text()).toContain("3 parts · 50,004 steps");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(runLinks()).toEqual(["wr_3", "wr_2", "wr_1"]);
  });

  it("shows carried failures on a completed Lauf before its earlier parts load", () => {
    show(list([toWorkflowRun(part(3, { status: "done", failedItemCount: 1 }))], true));
    expect(group().textContent).toContain("Done with failures");
  });

  it("says it in German", () => {
    show(list([toWorkflowRun(part3), toWorkflowRun(part2), toWorkflowRun(part1)], false), "de");
    const text = group().textContent ?? "";
    expect(text).toContain("Schlüssel 2026-10-17 · 3 Teile");
    expect(text).toContain("Auf einer neu veröffentlichten Version fortgesetzt");
  });
});
