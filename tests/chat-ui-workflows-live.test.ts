import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  WorkflowPageView,
  WorkflowRunPageView,
  createInstanceSource,
  failureHappened,
  startOffered,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun
} from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// The Workflow screens over the engine of an instance: the reads and the two writes through
// the client, and what the pages say about what the engine does not do yet. Every test here
// fails without the live source: the screens read samples and named no limit of the engine.

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;
const render = (node: ReactNode) =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale: "en", children: node }));
const noop = () => undefined;

const run = {
  id: "wfr_1",
  rootRunId: "wfr_1",
  depth: 0,
  workflow: "open-invoices",
  definitionRevisionId: "rev_1",
  mode: "live" as const,
  trigger: "manual" as const,
  status: "running" as const,
  principal: { id: "sp_1", name: "workflow-runner", displayLabel: "Workflow runner" },
  startedBy: { kind: "user" as const, id: "user_1", label: "Ada Lovelace" },
  stepRunCount: 2,
  deadlineAt: "2026-10-12T10:00:00.000Z",
  createdAt: "2026-10-12T09:00:00.000Z",
  startedAt: "2026-10-12T09:00:01.000Z"
};

function stepRun(id: string, stepId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    runId: run.id,
    stepId,
    stepType: "operation" as const,
    key: stepId,
    status: "done" as const,
    attempt: 1,
    createdAt: "2026-10-12T09:00:01.000Z",
    ...extra
  };
}

const { signal } = new AbortController();

const NOT_BUILT = {
  code: "not_supported_yet",
  message: "This engine does not run a step of the type 'agent' yet (not_supported_yet)",
  path: "steps[1].type"
};

/** A Workflow as the read of an asset answers it: its definition is `config.manifest`. */
const ASSET = {
  id: "asset_1",
  kind: "workflow",
  name: "month-end",
  scope: { kind: "instance" },
  revision: 4,
  publishedRevision: 4,
  createdAt: "2026-10-10T09:00:00.000Z",
  updatedAt: "2026-10-10T09:00:00.000Z",
  config: {
    name: "month-end",
    manifest: {
      id: "month-end",
      name: "Month end",
      steps: [
        { id: "start", type: "trigger", triggers: [{ kind: "manual" }] },
        { id: "summary", name: "Write the summary", type: "agent" }
      ]
    }
  }
};

/** One Workflow as the list of its kind names it. */
function summaryOf(input: {
  name: string;
  title: string;
  description?: string;
  publishedRevision?: number;
}) {
  return {
    id: `asset_${input.name}`,
    kind: "workflow",
    scope: { kind: "instance" },
    revision: 1,
    draftRevision: 1,
    updatedAt: "2026-10-12T09:00:00.000Z",
    ...input
  };
}

/** The published inputs of "Open invoices": one month, as the list names them. */
const MONTH_INPUTS = {
  type: "object",
  properties: {
    month: { type: "string", description: "The month to look at.", pattern: "^\\d{4}-\\d{2}$" }
  },
  required: ["month"]
};

/**
 * The source over the release's own client, whose requests are kept and answered here as the
 * instance answers them: what the source asks for is what the contract names.
 */
function instance(
  answers: {
    stepRunPages?: readonly { items: readonly unknown[]; nextCursor?: string }[];
    /** The engine's list a page at a time, by the cursor each page is asked from. */
    workflowPages?: Readonly<Record<string, { items: readonly unknown[]; nextCursor?: string }>>;
    /** The Workflow assets a page at a time, by the cursor each page is asked from. */
    assetPages?: Readonly<Record<string, { items: readonly unknown[]; nextCursor?: string }>>;
    startIssues?: { code: string; message: string; principalDisplayLabel?: string }[];
  } = {}
) {
  const { client, calls } = recordedApiClient(({ operation, query }) => {
    switch (operation) {
      case "workflows.list":
        if (answers.workflowPages !== undefined) {
          return answers.workflowPages[query.cursor ?? ""];
        }
        return {
          items: [
            {
              id: "open-invoices",
              name: "Open invoices",
              definitionRevisionId: "rev_1",
              actions: ["workflow.read"],
              runnable: true,
              reasons: [],
              inputs: MONTH_INPUTS
            },
            {
              id: "month-end",
              name: " ",
              description: "Closes the month.",
              kind: "data",
              definitionRevisionId: "rev_7",
              actions: ["workflow.read", "workflow.use"],
              runnable: false,
              reasons: answers.startIssues ?? [NOT_BUILT],
              lastRun: { id: "wfr_0", status: "failed", startedAt: "2026-10-11T09:00:00.000Z" }
            }
          ].sort((a, b) => (a.id < b.id ? -1 : 1))
        };
      case "assets.get":
        return ASSET;
      case "assets.list":
        if (answers.assetPages !== undefined) {
          return answers.assetPages[query.cursor ?? ""];
        }
        // A published Workflow is listed by the engine; one never published only here.
        return {
          items: [
            summaryOf({ name: "month-end", title: "Month end", publishedRevision: 4 }),
            summaryOf({ name: "first-draft", title: "First draft", description: "Not yet." })
          ].sort((a, b) => (a.name < b.name ? -1 : 1))
        };
      case "workflows.list_step_runs": {
        // The page after the one that handed on the cursor asked; with none asked, the first.
        const pages = answers.stepRunPages ?? [{ items: [] }];
        const after = pages.findIndex((entry) => entry.nextCursor === query.cursor);
        return pages[query.cursor === undefined ? 0 : after + 1];
      }
      case "workflows.cancel_run":
        return { ...run, cancelledAt: "2026-10-12T09:01:00.000Z" };
      case "workflows.list_runs":
        return { items: [run], nextCursor: "next" };
      default:
        return run;
    }
  });
  return { source: createInstanceSource(client, "k"), calls };
}

/** How many step runs one page of a run's frame holds, and how many the frame read at most before. */
const FRAME_PAGE = 200;
const OLD_FRAME_CAP = 2_000;
/** How many Workflows the screen's list asks for per page. */
const WORKFLOW_PAGE = 50;

/** Engine entries `flow-<from>` and on, `count` of them. */
function workflowSummaries(from: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `flow-${String(from + index).padStart(3, "0")}`,
    name: `Flow ${from + index}`,
    definitionRevisionId: `rev_${from + index}`,
    actions: ["workflow.read"],
    runnable: true,
    reasons: []
  }));
}

/** Every row of the screen's list, page after page as the screen reads it. */
async function wholeList(source: ReturnType<typeof instance>["source"]) {
  const rows: Awaited<ReturnType<typeof source.listWorkflows>>["items"][number][] = [];
  const cursors: (string | undefined)[] = [];
  let cursor: string | undefined;
  do {
    // Each page hands on a cursor it was not read from; a list that does not advance fails.
    expect(cursors).not.toContain(cursor);
    cursors.push(cursor);
    const page = await source.listWorkflows("cw_1", { limit: WORKFLOW_PAGE, cursor }, signal);
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return rows;
}

describe("the Workflow screens over the engine of an instance", () => {
  it("lists what the engine lists, each Workflow with its latest run, and the drafts never published", async () => {
    const { source, calls } = instance();
    const list = await wholeList(source);
    // The two name-ordered pages are joined, retaining asset rights on engine summaries.
    expect(calls.map((call) => [call.operation, call.query])).toEqual([
      ["workflows.list", { limit: "50" }],
      ["assets.list", { limit: "50" }]
    ]);
    expect(list).toEqual(
      [
        {
          id: "open-invoices",
          name: "Open invoices",
          published: true,
          // The list names no kind: a process.
          kind: "process",
          startsByHand: true,
          refusedFor: [],
          mayStart: false,
          // The form of a start is made from the published inputs the list names.
          startForm: {
            fields: [
              {
                name: "month",
                label: "Month",
                hint: "The month to look at.",
                control: "text",
                required: true,
                initial: "",
                pattern: "^\\d{4}-\\d{2}$"
              }
            ],
            unsupported: []
          }
        },
        {
          id: "month-end",
          // A name of blanks is no name: the id stands for it.
          name: "month-end",
          description: "Closes the month.",
          published: true,
          kind: "data",
          startsByHand: true,
          // Listed although the instance starts none of it, with the instance's own reason.
          refusedFor: [{ code: NOT_BUILT.code, message: NOT_BUILT.message }],
          mayStart: true,
          startForm: { fields: [], unsupported: [] },
          lastRun: {
            id: "wfr_0",
            status: "failed",
            startedAt: "2026-10-11T09:00:00.000Z",
            // An instance that sends no counts yet: nothing failed below, no item failed.
            failedDescendantCount: 0,
            failedItemCount: 0
          }
        },
        // Never published: the engine names it nowhere, its asset lists it as a draft (NAV-2).
        {
          id: "first-draft",
          name: "First draft",
          description: "Not yet.",
          published: false,
          kind: "process",
          updatedAt: "2026-10-12T09:00:00.000Z",
          startsByHand: false,
          refusedFor: [],
          mayStart: false,
          startForm: { fields: [], unsupported: [] }
        }
      ].sort((a, b) => (a.id < b.id ? -1 : 1))
    );
  });

  it.each([
    "{",
    "[]",
    JSON.stringify({ published: { done: "false" }, assets: { done: false } }),
    JSON.stringify({ published: { done: false, cursor: 17 }, assets: { done: false } }),
    JSON.stringify({ published: { done: false, after: 17 }, assets: { done: false } })
  ])("refuses an invalid list cursor before reading the instance: %s", async (cursor) => {
    const { source, calls } = instance();
    await expect(source.listWorkflows("cw_1", { limit: 2, cursor }, signal)).rejects.toThrow(
      "Invalid Workflow list cursor"
    );
    expect(calls).toEqual([]);
  });

  it("joins rights across independent pages, retaining a write-only published Workflow", async () => {
    const firstEnginePage = [workflowSummaries(0, 1)[0], workflowSummaries(2, 1)[0]];
    const { source, calls } = instance({
      workflowPages: {
        "": { items: firstEnginePage, nextCursor: "e2" },
        e2: { items: workflowSummaries(4, 1) }
      },
      assetPages: {
        "": {
          items: [
            {
              ...summaryOf({ name: "flow-000", title: "Read", publishedRevision: 1 }),
              allowed: ["read"]
            },
            {
              ...summaryOf({ name: "flow-001", title: "Write only", publishedRevision: 1 }),
              allowed: ["write"]
            }
          ],
          nextCursor: "a2"
        },
        a2: {
          items: [
            {
              ...summaryOf({ name: "flow-002", title: "Publish", publishedRevision: 1 }),
              allowed: ["publish"]
            },
            {
              ...summaryOf({ name: "flow-004", title: "Read", publishedRevision: 1 }),
              allowed: ["read"]
            }
          ]
        }
      }
    });
    const found = [];
    const cursors = new Set<string | undefined>();
    let cursor: string | undefined;
    do {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
      const page = await source.listWorkflows("cw_1", { limit: 2, cursor }, signal);
      expect(page.items.length).toBeLessThanOrEqual(2);
      found.push(...page.items);
      // The engine page was only partly consumed. Deleting an earlier row must not skip
      // the next unread name when that page is requested again.
      if (cursor === undefined) firstEnginePage.shift();
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(found.map((item) => [item.id, item.allowed, item.published])).toEqual([
      ["flow-000", ["read"], true],
      ["flow-001", ["write"], true],
      ["flow-002", ["publish"], true],
      ["flow-004", ["read"], true]
    ]);
    expect(found.find((item) => item.id === "flow-001")?.mayStart).toBe(false);
    expect(calls.every((call) => call.query.limit === "2")).toBe(true);
  });

  // DISCOVERY-PAGING: the engine pages its list. The source read one answer and lost every
  // Workflow after the first page; it follows the engine's cursor, and the drafts' after it.
  it("follows the engine's cursor to the Workflow after the first page, in the list and in a read", async () => {
    const { source, calls } = instance({
      workflowPages: {
        "": { items: workflowSummaries(0, WORKFLOW_PAGE), nextCursor: "e2" },
        e2: { items: workflowSummaries(WORKFLOW_PAGE, 1) }
      },
      assetPages: { "": { items: [] } }
    });
    const list = await wholeList(source);
    const published = list.filter((item) => item.published);
    expect(published).toHaveLength(WORKFLOW_PAGE + 1);
    expect(published.at(-1)?.id).toBe(`flow-${String(WORKFLOW_PAGE).padStart(3, "0")}`);
    expect(calls.map((call) => [call.operation, call.query.cursor])).toEqual([
      ["workflows.list", undefined],
      ["assets.list", undefined],
      ["workflows.list", "e2"]
    ]);

    calls.length = 0;
    const last = await source.getWorkflow(
      "cw_1",
      `flow-${String(WORKFLOW_PAGE).padStart(3, "0")}`,
      signal
    );
    expect(last).toMatchObject({ published: true, revisionId: `rev_${WORKFLOW_PAGE}` });
    expect(
      calls.filter((call) => call.operation === "workflows.list").map((call) => call.query)
    ).toEqual([{ limit: "200" }, { limit: "200", cursor: "e2" }]);
  });

  // DISCOVERY-PAGING: with no published Workflow the first page came back empty, and the screen
  // showed its empty state with no way on to the drafts. A page that finds nothing reads on.
  it("lists the draft on the first page of an instance with no published Workflow", async () => {
    const { source, calls } = instance({
      workflowPages: { "": { items: [] } },
      assetPages: { "": { items: [summaryOf({ name: "only-draft", title: "Only draft" })] } }
    });
    const first = await source.listWorkflows(
      "cw_1",
      { limit: WORKFLOW_PAGE, cursor: undefined },
      signal
    );
    expect(first.items.map((item) => [item.id, item.published])).toEqual([["only-draft", false]]);
    expect(first.nextCursor).toBeUndefined();
    expect(calls.map((call) => call.operation)).toEqual(["workflows.list", "assets.list"]);
  });

  it("reads past an empty asset page to the draft after it", async () => {
    const { source, calls } = instance({
      workflowPages: { "": { items: [] } },
      assetPages: {
        "": {
          items: [],
          nextCursor: "a2"
        },
        a2: { items: [summaryOf({ name: "late-draft", title: "Late draft" })] }
      }
    });
    const first = await source.listWorkflows(
      "cw_1",
      { limit: WORKFLOW_PAGE, cursor: undefined },
      signal
    );
    expect(first.items.map((item) => item.id)).toEqual(["late-draft"]);
    expect(first.nextCursor).toBeUndefined();
    expect(calls.map((call) => [call.operation, call.query.cursor])).toEqual([
      ["workflows.list", undefined],
      ["assets.list", undefined],
      ["assets.list", "a2"]
    ]);
  });

  it("hands on a cursor after a bounded number of reads that find nothing", async () => {
    const empty = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        index === 0 ? "" : `a${index}`,
        {
          items: [],
          nextCursor: `a${index + 1}`
        }
      ])
    );
    const { source, calls } = instance({
      workflowPages: { "": { items: [] } },
      assetPages: { ...empty, a12: { items: [summaryOf({ name: "far-draft", title: "Far" })] } }
    });
    const first = await source.listWorkflows(
      "cw_1",
      { limit: WORKFLOW_PAGE, cursor: undefined },
      signal
    );
    // Nothing found yet, and the way on: the screen reads the rest when asked.
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    expect(calls.length).toBeLessThanOrEqual(5);
    const list = await wholeList(source);
    expect(list.map((item) => item.id)).toEqual(["far-draft"]);
  });

  it("reads a Workflow from its asset, and from the list whether it starts and its revision", async () => {
    const { source, calls } = instance();
    const workflow = await source.getWorkflow("cw_1", "month-end", signal);
    expect(calls.map((call) => [call.operation, call.params, call.query])).toEqual([
      ["assets.get", { kind: "workflow", name: "month-end" }, {}],
      ["workflows.list", {}, { limit: "200" }]
    ]);
    expect(workflow).toMatchObject({
      id: "month-end",
      name: "Month end",
      published: true,
      revisionId: "rev_7",
      startsByHand: true,
      refusedFor: [{ code: "not_supported_yet", message: NOT_BUILT.message }],
      mayStart: true
    });
    expect(workflow.steps.map((step) => step.name)).toEqual(["Start", "Write the summary"]);
    expect(startOffered(workflow)).toBe(false);
  });

  it("reads the unpublished draft's account label from the asset", async () => {
    const { client } = recordedApiClient(({ operation }) =>
      operation === "assets.get"
        ? {
            ...ASSET,
            publishedRevision: undefined,
            draftRevision: 1,
            runsAs: "Draft account",
            config: {
              ...ASSET.config,
              manifest: { ...ASSET.config.manifest, runAs: "internal-account-name" }
            }
          }
        : { items: [] }
    );
    const source = createInstanceSource(client, "draft-account");
    const workflow = await source.getWorkflow("cw_1", "month-end", signal);
    expect(workflow).toMatchObject({ published: false, mayStart: false, runsAs: "Draft account" });
  });

  it("holds no start for a Workflow whose entry names the read alone", async () => {
    const { source } = instance();
    const workflow = await source.getWorkflow("cw_1", "open-invoices", signal);
    expect(workflow).toMatchObject({ published: true, refusedFor: [], mayStart: false });
    // The form is the published revision's, as the list names it, not the draft's.
    expect(workflow.startForm.fields.map((field) => field.name)).toEqual(["month"]);
    expect(startOffered(workflow)).toBe(false);
  });

  it("reads the runs of a Workflow a page at a time", async () => {
    const { source, calls } = instance();
    const page = await source.runs?.listRuns("open-invoices", { limit: 20, cursor: "c1" }, signal);
    expect(calls[0]).toMatchObject({
      operation: "workflows.list_runs",
      params: { workflow: "open-invoices" },
      query: { limit: "20", cursor: "c1" }
    });
    expect(page?.nextCursor).toBe("next");
    expect(page?.items[0]).toMatchObject({
      id: "wfr_1",
      status: "running",
      ended: false,
      stopping: false,
      startedBy: { id: "user_1", name: "Ada Lovelace" },
      revisionId: "rev_1"
    });
  });

  it("picks the frame of a run out of all its step runs, and leaves out the items of a loop", async () => {
    const { source, calls } = instance({
      stepRunPages: [
        {
          items: [
            stepRun("sr_1", "invoices"),
            stepRun("sr_2", "remind", { iteration: { index: 0 }, containerStepRunId: "sr_3" })
          ],
          nextCursor: "p2"
        },
        { items: [stepRun("sr_3", "each", { stepType: "loop" })] }
      ]
    });
    const first = await source.runs?.listFrameStepRuns("wfr_1", undefined, signal);
    expect(first?.stepRuns.map((entry) => entry.id)).toEqual(["sr_1"]);
    expect(first?.nextCursor).toBe("p2");
    const second = await source.runs?.listFrameStepRuns("wfr_1", "p2", signal);
    expect(second?.stepRuns.map((entry) => entry.id)).toEqual(["sr_3"]);
    expect(second?.nextCursor).toBeUndefined();
    expect(calls.map((call) => [call.operation, call.params, call.query])).toEqual([
      ["workflows.list_step_runs", { runId: "wfr_1" }, { limit: "200" }],
      ["workflows.list_step_runs", { runId: "wfr_1" }, { limit: "200", cursor: "p2" }]
    ]);
  });

  // DISCOVERY-PAGING: the frame stopped after ten reads of 200, so the step run after the
  // 2,000th never reached the canvas. Each page now hands on its cursor, with no total cap.
  it("reaches the step run after the 2,000th by the cursor each page hands on", async () => {
    const pages = Array.from({ length: OLD_FRAME_CAP / FRAME_PAGE + 1 }, (_, index) => ({
      items: Array.from({ length: index < OLD_FRAME_CAP / FRAME_PAGE ? FRAME_PAGE : 1 }, (_, row) =>
        stepRun(`sr_${index * FRAME_PAGE + row}`, `step-${index * FRAME_PAGE + row}`)
      ),
      ...(index < OLD_FRAME_CAP / FRAME_PAGE ? { nextCursor: `c${index + 1}` } : {})
    }));
    const { source, calls } = instance({ stepRunPages: pages });
    const ids: string[] = [];
    let cursor: string | undefined;
    // As many reads as the run has pages, and no more: a read that does not advance fails here.
    for (const expected of pages) {
      const page = await source.runs?.listFrameStepRuns("wfr_1", cursor, signal);
      expect(page?.stepRuns.at(-1)?.id).toBe(expected.items.at(-1)?.id);
      ids.push(...(page?.stepRuns.map((entry) => entry.id) ?? []));
      cursor = page?.nextCursor;
    }
    expect(cursor).toBeUndefined();
    expect(calls.map((call) => call.query.cursor)).toEqual([
      undefined,
      ...pages.slice(0, -1).map((entry) => entry.nextCursor)
    ]);
    expect(ids).toHaveLength(OLD_FRAME_CAP + 1);
    expect(ids.at(-1)).toBe(`sr_${OLD_FRAME_CAP}`);
    expect(calls.at(-1)?.query).toEqual({ limit: "200", cursor: `c${OLD_FRAME_CAP / FRAME_PAGE}` });
  });

  it("asks the instance for the entries of one loop in one state", async () => {
    const { source, calls } = instance();
    await source.runs?.listEntryStepRuns(
      "wfr_1",
      { containerStepRunId: "sr_3", status: "failed", limit: 50, cursor: undefined },
      signal
    );
    expect(calls[0]).toMatchObject({
      operation: "workflows.list_step_runs",
      params: { runId: "wfr_1" },
      query: { containerStepRunId: "sr_3", status: "failed", limit: "50" }
    });
  });

  it("keeps the technical account label through the list and detail mappings", async () => {
    const issue = {
      code: "principal_inactive",
      message: "The account is disabled.",
      principalDisplayLabel: "Booking checks"
    };
    const { source } = instance({ startIssues: [issue] });
    const list = await wholeList(source);
    expect(list.find(({ id }) => id === "month-end")?.refusedFor).toEqual([issue]);
    expect((await source.getWorkflow("cw_1", "month-end", signal))?.refusedFor).toEqual([issue]);
  });

  it("starts and cancels through the client, and reads a cancel that waits for the going call", async () => {
    const { source, calls } = instance();
    expect((await source.runs?.start("open-invoices", { month: "2026-09" }))?.id).toBe("wfr_1");
    expect(calls[0]).toEqual({
      operation: "workflows.start",
      params: { workflow: "open-invoices" },
      query: {},
      body: JSON.stringify({ input: { month: "2026-09" } })
    });
    const cancelled = await source.runs?.cancel("wfr_1");
    expect(calls[1]).toMatchObject({
      operation: "workflows.cancel_run",
      params: { runId: "wfr_1" }
    });
    // The run was asked to stop and is still going: the call at work is not broken off.
    expect(cancelled).toMatchObject({ status: "running", ended: false, stopping: true });
  });
});

describe("a Workflow the instance accepts no start of", () => {
  const blocked = (issues: { code: string; message: string }[], mayStart = true) =>
    toWorkflow(
      {
        name: "weekly-check",
        publishedRevision: 1,
        config: {
          name: "Weekly check",
          steps: [{ id: "start", type: "trigger", triggers: [{ kind: "manual" }] }]
        }
      },
      { revisionId: "rev_1", refusedFor: issues, mayStart }
    );
  const page = (workflow: ReturnType<typeof blocked>) =>
    render(
      createElement(WorkflowPageView, {
        workspaceId: "cw_1",
        workflowId: "weekly-check",
        read: { workflow, problem: undefined, retry: noop },
        runsAvailable: true,
        onOpenChild: noop,
        onOpenRoute: noop,
        onStart: noop
      })
    );

  it("is shown with each reason of the instance, and its start is switched off", () => {
    const workflow = blocked([NOT_BUILT]);
    expect(startOffered(workflow)).toBe(false);
    const markup = page(workflow);
    expect(markup).toContain("Weekly check");
    expect(markup).toContain(t("workflows.notRunnable.title"));
    expect(markup).toContain("does not run a step of the type &#x27;agent&#x27; yet");
    expect(markup).toMatch(/<button[^>]* disabled=""[^>]*>.*Start now/su);
  });

  it("says that it cannot be started now where the reason is none of the engine's", () => {
    const markup = page(
      blocked([{ code: "principal_inactive", message: "The instance has no active principal" }])
    );
    expect(markup).toContain(t("workflows.notRunnable.refused"));
    expect(markup).not.toContain(t("workflows.notRunnable.title"));
    expect(markup).toContain(t("workflows.notRunnable.accountUnavailable"));
    expect(markup).not.toContain("The instance has no active principal");
  });

  it("shows no start, switched off or not, to a reader who may not start", () => {
    expect(page(blocked([NOT_BUILT], false))).not.toContain(t("workflows.startNow"));
    expect(page(blocked([]))).not.toContain(' disabled=""');
  });
});

describe("what a run says about how it ended", () => {
  const definition = toWorkflow({
    name: "open-invoices",
    publishedRevision: 1,
    config: {
      name: "Open invoices",
      steps: [
        { id: "start", type: "trigger", triggers: [{ kind: "manual" }] },
        { id: "remind", name: "Send the reminders", type: "operation" }
      ]
    }
  });
  const page = (
    resource: Parameters<typeof toWorkflowRun>[0],
    stepRuns: readonly Parameters<typeof toWorkflowStepRun>[0][] = []
  ) =>
    render(
      createElement(WorkflowRunPageView, {
        workspaceId: "cw_1",
        workflowId: "open-invoices",
        workflow: definition,
        read: {
          run: toWorkflowRun(resource),
          problem: undefined,
          silentSince: undefined,
          stepsFailed: false,
          stepRuns: stepRuns.map(toWorkflowStepRun),
          retry: noop
        },
        now: new Date("2026-10-12T09:12:00.000Z"),
        canCancel: true,
        canRunAgain: false,
        stopping: toWorkflowRun(resource).stopping,
        onCancel: noop,
        onRunAgain: noop,
        onOpenRoute: noop
      })
    );

  it("names the right the account of the Workflow lacks", () => {
    const failure = toWorkflowRun({
      ...run,
      status: "failed",
      error: { code: "FORBIDDEN", message: "may not", action: "connection.use" }
    }).failure;
    expect(failure).toMatchObject({ reason: "missingRight", action: "connection.use" });
    expect(failure && failureHappened(failure, t)).toBe(
      "The workflow may not do this: its account lacks the right “connection.use”."
    );
    expect(failure && failureHappened(failure, de)).toContain("„connection.use“");
    // A refusal that names no action keeps the sentence without one.
    expect(failureHappened({ reason: "missingRight" }, t)).toBe(t("workflows.reason.missingRight"));
    expect(
      page({
        ...run,
        status: "failed",
        error: { code: "FORBIDDEN", message: "may not", action: "connection.use" }
      })
    ).toContain("lacks the right “connection.use”");
  });

  it("names the Workflow whose run key is held in the step's own call chain, and nothing else", () => {
    const cycle = {
      code: "run_key_cycle",
      message: "The operation 'workflow.open-invoices.start' failed (run_key_cycle)"
    };
    const failure = toWorkflowStepRun(
      stepRun("wfs_cycle", "remind", { stepType: "workflow", status: "failed", error: cycle })
    ).failure;
    expect(failure).toMatchObject({ reason: "runKeyCycle", workflow: "open-invoices" });
    expect(failure && failureHappened(failure, t)).toBe(
      "The key for Workflow “open-invoices” is held by a run in its own call chain."
    );
    expect(failure && failureHappened(failure, de)).toBe(
      "Den Schlüssel für den Workflow „open-invoices“ hält ein Lauf in seiner eigenen Aufrufkette."
    );
    // The run the step failed carries the same sentence.
    expect(page({ ...run, status: "failed", error: cycle })).toContain(
      "The key for Workflow “open-invoices” is held by a run in its own call chain."
    );

    // A sentence of any other form names no Workflow: nothing of it reaches the sentence.
    for (const message of [
      "The operation 'workflow.open-invoices.start' failed (run_key_cycle): key=abc",
      "The operation 'workflow.Open Invoices.start' failed (run_key_cycle)",
      "The operation 'connection.open-invoices.start' failed (run_key_cycle)",
      "run key 'secret-key' is held"
    ]) {
      const other = toWorkflowRun({
        ...run,
        status: "failed",
        error: { code: "run_key_cycle", message }
      }).failure;
      expect(other).toMatchObject({ reason: "runKeyCycle" });
      expect(other?.workflow).toBeUndefined();
      expect(other && failureHappened(other, t)).toBe(t("workflows.reason.runKeyCycle"));
    }
    // The form alone names no Workflow under another code.
    expect(
      toWorkflowRun({
        ...run,
        status: "failed",
        error: { code: "run_key_invalid", message: cycle.message }
      }).failure?.workflow
    ).toBeUndefined();
  });

  it("says of a run interrupted in a changing call that the call may have happened and was not repeated", () => {
    const markup = page({
      ...run,
      status: "failed",
      error: { code: "operation_interrupted", message: "interrupted" }
    });
    expect(markup).toContain("The change may or may not have happened");
    expect(markup).toContain("was not repeated");
    expect(de("workflows.reason.interrupted")).toContain("nicht wiederholt");
  });

  it("says that a cancel waits for the call that is going, and offers no second cancel", () => {
    const markup = page({ ...run, cancelledAt: "2026-10-12T09:01:00.000Z" });
    expect(markup).toContain(t("workflows.run.stopping"));
    expect(markup).toContain(t("workflows.run.stoppingLine"));
    expect(markup).not.toContain(`>${t("workflows.run.cancel")}<`);
    expect(page(run)).not.toContain(t("workflows.run.stoppingLine"));
  });
});
