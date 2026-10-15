import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  WorkflowPageView,
  WorkflowRunPageView,
  createInstanceSource,
  failureHappened,
  startOffered,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun
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
  } = {}
) {
  let page = 0;
  const { client, calls } = recordedApiClient(({ operation }) => {
    switch (operation) {
      case "workflows.list":
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
              definitionRevisionId: "rev_7",
              actions: ["workflow.read", "workflow.use"],
              runnable: false,
              reasons: [NOT_BUILT],
              lastRun: { id: "wfr_0", status: "failed", startedAt: "2026-10-11T09:00:00.000Z" }
            }
          ]
        };
      case "assets.get":
        return ASSET;
      case "assets.list":
        // A published Workflow is listed by the engine; one never published only here.
        return {
          items: [
            summaryOf({ name: "month-end", title: "Month end", publishedRevision: 4 }),
            summaryOf({ name: "first-draft", title: "First draft", description: "Not yet." })
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
  it("lists what the engine lists, each Workflow with its latest run, and the drafts never published", async () => {
    const { source } = instance();
    const list = await source.listWorkflows("cw_1", { limit: 50, cursor: undefined }, signal);
    expect(list.items).toEqual([
      {
        id: "open-invoices",
        name: "Open invoices",
        published: true,
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
        startsByHand: true,
        // Listed although the instance starts none of it, with the instance's own reason.
        refusedFor: [{ code: NOT_BUILT.code, message: NOT_BUILT.message }],
        mayStart: true,
        startForm: { fields: [], unsupported: [] },
        lastRun: { id: "wfr_0", status: "failed", startedAt: "2026-10-11T09:00:00.000Z" }
      },
      // Never published: the engine names it nowhere, its asset lists it as a draft (NAV-2).
      {
        id: "first-draft",
        name: "First draft",
        description: "Not yet.",
        published: false,
        updatedAt: "2026-10-12T09:00:00.000Z",
        startsByHand: false,
        refusedFor: [],
        mayStart: false,
        startForm: { fields: [], unsupported: [] }
      }
    ]);
    expect(list.nextCursor).toBeUndefined();
  });

  it("reads a Workflow from its asset, and from the list whether it starts and its revision", async () => {
    const { source, calls } = instance();
    const workflow = await source.getWorkflow("cw_1", "month-end", signal);
    expect(calls.map((call) => [call.operation, call.params, call.query])).toEqual([
      ["assets.get", { kind: "workflow", name: "month-end" }, {}],
      ["workflows.list", {}, {}]
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
    expect(markup).toContain("The instance has no active principal");
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
