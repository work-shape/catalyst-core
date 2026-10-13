import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ApiError } from "@vivd-catalyst/api-client";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  WorkflowPageView,
  WorkflowRunPageView,
  createInstanceSource,
  failureHappened,
  startOffered,
  startRefusal,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  unsupportedByEngine
} from "@vivd-catalyst/chat-ui/workflows";
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
const READER = { read: true, start: true, write: false };

const run = {
  id: "wfr_1",
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

/**
 * The source over the release's own client, whose requests are kept and answered here as the
 * instance answers them: what the source asks for is what the contract names.
 */
function instance(
  answers: {
    stepRunPages?: readonly { items: readonly unknown[]; nextCursor?: string }[];
  } = {}
) {
  let page = 0;
  const { client, calls } = recordedApiClient(({ operation }) => {
    switch (operation) {
      case "workflows.list":
        return {
          items: [
            { id: "open-invoices", name: "Open invoices" },
            {
              id: "month-end",
              name: " ",
              description: "Closes the month.",
              lastRun: { id: "wfr_0", status: "failed", startedAt: "2026-10-11T09:00:00.000Z" }
            }
          ]
        };
      case "workflows.list_step_runs": {
        const pages = answers.stepRunPages ?? [{ items: [] }];
        const current = pages[Math.min(page, pages.length - 1)];
        page += 1;
        return current;
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

describe("the Workflow screens over the engine of an instance", () => {
  it("lists what the engine lists, each Workflow with its latest run", async () => {
    const { source } = instance();
    const list = await source.listWorkflows("cw_1", { limit: 50, cursor: undefined }, signal);
    expect(list.items).toEqual([
      { id: "open-invoices", name: "Open invoices", published: true },
      {
        id: "month-end",
        // A name of blanks is no name: the id stands for it.
        name: "month-end",
        description: "Closes the month.",
        published: true,
        lastRun: { id: "wfr_0", status: "failed", startedAt: "2026-10-11T09:00:00.000Z" }
      }
    ]);
    expect(list.nextCursor).toBeUndefined();
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
    const frame = await source.runs?.listFrameStepRuns("wfr_1", signal);
    expect(frame?.complete).toBe(true);
    expect(frame?.stepRuns.map((entry) => entry.id)).toEqual(["sr_1", "sr_3"]);
    expect(calls.map((call) => [call.operation, call.params, call.query])).toEqual([
      ["workflows.list_step_runs", { runId: "wfr_1" }, { limit: "200" }],
      ["workflows.list_step_runs", { runId: "wfr_1" }, { limit: "200", cursor: "p2" }]
    ]);
  });

  it("stops reading a run with more step runs than the page holds, and says the frame is cut", async () => {
    const { source, calls } = instance({
      stepRunPages: [{ items: [stepRun("sr_1", "invoices")], nextCursor: "more" }]
    });
    const frame = await source.runs?.listFrameStepRuns("wfr_1", signal);
    expect(frame?.complete).toBe(false);
    expect(calls).toHaveLength(10);
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

  it("starts and cancels through the client, and reads a cancel that waits for the going call", async () => {
    const { source, calls } = instance();
    expect((await source.runs?.start("open-invoices"))?.id).toBe("wfr_1");
    expect(calls[0]).toEqual({
      operation: "workflows.start",
      params: { workflow: "open-invoices" },
      query: {},
      body: "{}"
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

describe("what the engine does not run yet", () => {
  const runnable = {
    steps: [
      { id: "start", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "invoices", name: "Read the invoices", type: "operation" },
      {
        id: "each",
        name: "For each invoice",
        type: "loop",
        steps: [{ id: "x", type: "operation" }]
      },
      { id: "result", type: "output" }
    ]
  };

  it("finds nothing in ordered steps and a loop that are started by hand", () => {
    expect(unsupportedByEngine(runnable)).toEqual([]);
  });

  it("names each thing a definition holds that is refused at the start", () => {
    expect(
      unsupportedByEngine({
        retention: { days: 30 },
        steps: [
          {
            id: "start",
            type: "trigger",
            triggers: [
              { kind: "manual" },
              { kind: "schedule", cron: "0 6 * * 1" },
              { kind: "parent" }
            ]
          },
          { id: "any", name: "Any findings", type: "condition", then: [], else: [] },
          {
            id: "at_once",
            name: "At once",
            type: "parallel",
            branches: [{ id: "a", steps: [{ id: "child", name: "Month end", type: "workflow" }] }]
          },
          {
            id: "each",
            name: "For each client",
            type: "loop",
            concurrency: 4,
            collect: { path: "" },
            steps: [{ id: "list", type: "operation", paginate: {} }]
          }
        ]
      })
    ).toEqual([
      { what: "steps", names: ["Any findings", "At once", "Month end"] },
      { what: "schedule", names: [] },
      { what: "trigger", names: [] },
      { what: "collect", names: ["For each client"] },
      { what: "concurrency", names: ["For each client"] },
      { what: "fields", names: ["retention", "paginate"] }
    ]);
  });

  const blocked = toWorkflow(
    {
      name: "weekly-check",
      publishedRevision: 1,
      config: {
        name: "Weekly check",
        steps: [
          {
            id: "start",
            type: "trigger",
            triggers: [{ kind: "manual" }, { kind: "schedule", cron: "0 6 * * 1" }]
          },
          { id: "any", name: "Any findings", type: "condition", then: [], else: [] }
        ]
      }
    },
    undefined,
    [
      { what: "steps", names: ["Any findings"] },
      { what: "schedule", names: [] }
    ]
  );

  it("shows such a Workflow with every reason and without a start", () => {
    expect(startOffered(blocked, READER)).toBe(false);
    const markup = render(
      createElement(WorkflowPageView, {
        workspaceId: "cw_1",
        workflowId: "weekly-check",
        read: { workflow: blocked, problem: undefined, retry: noop },
        rights: READER,
        runsAvailable: true,
        onOpenChild: noop,
        onOpenRoute: noop,
        onStart: noop
      })
    );
    expect(markup).toContain("Weekly check");
    expect(markup).toContain(t("workflows.notRunnable.title"));
    expect(markup).toContain(t("workflows.notRunnable.steps", { names: "“Any findings”" }));
    expect(markup).toContain(t("workflows.notRunnable.schedule"));
    expect(markup).not.toContain(t("workflows.startNow"));
  });

  it("reads a start the instance refused for it, with what the instance names", () => {
    const refusal = startRefusal(
      new ApiError(422, "The definition cannot be run", {
        error: {
          code: "VALIDATION_FAILED",
          message: "The definition cannot be run",
          details: {
            reason: "not_supported_yet",
            issues: [
              {
                path: "steps[2].collect",
                code: "not_supported_yet",
                message: "This engine does not run 'collect' yet (not_supported_yet)"
              },
              { path: "steps[0]", message: "Another issue" }
            ]
          }
        }
      })
    );
    expect(refusal).toEqual({
      why: "notSupported",
      issues: ["This engine does not run 'collect' yet (not_supported_yet)"]
    });
    expect(
      startRefusal(
        new ApiError(409, "not started by hand", {
          error: { code: "CONFLICT", message: "x", details: { reason: "no_manual_trigger" } }
        })
      )
    ).toEqual({ why: "notByHand", issues: [] });
    expect(startRefusal(new ApiError(403, "no", { error: { code: "FORBIDDEN" } }))).toBeUndefined();
    expect(startRefusal(new Error("offline"))).toBeUndefined();
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
    stepRuns: readonly Parameters<typeof toWorkflowStepRun>[0][] = [],
    stepRunsCut = false
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
          stepRuns: stepRuns.map(toWorkflowStepRun),
          stepRunsCut,
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

  it("says that a run has more step runs than the page reads", () => {
    expect(page(run, [], true)).toContain(t("workflows.run.stepRunsCut"));
    expect(page(run)).not.toContain(t("workflows.run.stepRunsCut"));
  });
});
