import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { WORKFLOW_MAX_BLOCK_DEPTH } from "@work-shape/catalyst-core";
import type { FlowBox, FlowGraph, ScheduleValue } from "@work-shape/catalyst-ui";
import { layoutFlow } from "@work-shape/catalyst-ui/flow-layout";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  applyFileEdits,
  applyStepEdits,
  checkStartForm,
  conditionChain,
  countsLine,
  createInstanceSource,
  cronSchedule,
  defaultEntryFilter,
  draftChanges,
  draftValueOf,
  earlierFields,
  editIssues,
  editPlaces,
  fieldListProblems,
  fieldsSchema,
  heldIds,
  issuePlace,
  loopEntries,
  mailAnswerOf,
  mailRunOf,
  mappingOf,
  newStepOf,
  paletteGroups,
  pickedSchema,
  placedSteps,
  readCutJson,
  readersOf,
  rebaseStepEdits,
  recipientsInput,
  replayMoments,
  resolveWorkflowRights,
  rowsOf,
  sampleMarkdown,
  scheduleCron,
  scheduleInWords,
  schemaFields,
  SCRIPT_FIELD,
  startFormOf,
  startRefusalByField,
  StepPanel,
  stepIdFrom,
  stepOutputRows,
  stepPlaceOf,
  stepRunsAt,
  stepValue,
  textInput,
  textParts,
  timelineRows,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  withKeys,
  withRemovedSteps,
  workflowGraph,
  WorkflowsHostProvider,
  workflowSteps,
  WORKFLOW_FIELDS,
  type CallableOperationOption,
  type CanvasRun,
  type StepEdit,
  type StepPinControl,
  type WorkflowsHost
} from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { required } from "./support/assertions";
import {
  createSampleSource,
  readsRecipientPeople,
  workspaceQueryKeys,
  WorkflowsHostWithRecipients
} from "./support/chat-ui";
import { recordedApiClient } from "./support/recorded-api-client";

// The pure logic of the Workflow screens: the drawing of a definition and of a run, edits a
// person makes by hand, the field lists of Settings, the start form, schedules, pins, Notify
// recipients and the mail step. Every definition is the parsed file, taken through the mapping
// the instance's read goes through.

const en = createTranslationContext("en");
const de = createTranslationContext("de");
const noop = () => undefined;
const signal = new AbortController().signal;
const now = new Date("2026-10-12T09:12:00.000Z");

type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];
type Step = Record<string, unknown>;

const OBJECT = { type: "object" };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function definition(
  steps: readonly Step[],
  stepFacts: NonNullable<Parameters<typeof toWorkflow>[2]>["stepFacts"] = {
    clients: { source: { kind: "connection" } },
    bookings: { source: { kind: "connection" } },
    save: { source: { kind: "data_store" } }
  }
) {
  return toWorkflow(
    {
      name: "check",
      config: {
        id: "check",
        name: "Check",
        runAs: "runner",
        inputs: OBJECT,
        outputs: OBJECT,
        steps
      },
      publishedRevision: 1
    },
    {},
    { stepFacts }
  );
}

const trigger: Step = {
  id: "start",
  type: "trigger",
  name: "Start",
  triggers: [{ kind: "schedule", cron: "0 6 1 * *" }, { kind: "manual" }]
};
const operation = (id: string, operation = "connection.bookings.list"): Step => ({
  id,
  type: "operation",
  name: `Step ${id}`,
  operation,
  input: {}
});
const loop = (id: string, steps: readonly Step[]): Step => ({
  id,
  type: "loop",
  name: `Loop ${id}`,
  items: { step: "start", path: "items" },
  itemName: "client",
  steps
});
const output: Step = { id: "result", type: "output", name: "Result", input: {} };

function stepRun(
  input: Partial<StepRunResource> & Pick<StepRunResource, "stepId">
): StepRunResource {
  return {
    id: `sr_${input.stepId}`,
    stepType: "operation",
    status: "done",
    attempt: 1,
    createdAt: "2026-10-12T09:00:00.000Z",
    startedAt: "2026-10-12T09:00:00.000Z",
    finishedAt: "2026-10-12T09:00:04.000Z",
    ...input
  };
}

function runOf(
  stepRuns: readonly StepRunResource[],
  status: "running" | "failed" = "running"
): CanvasRun {
  return {
    run: toWorkflowRun({
      id: "wr_1",
      workflow: "check",
      trigger: "schedule",
      status,
      startedBy: { id: "sp_1", label: "runner" },
      createdAt: "2026-10-12T09:00:00.000Z",
      startedAt: "2026-10-12T09:00:00.000Z"
    }),
    stepRuns: stepRuns.map(toWorkflowStepRun),
    now
  };
}

/** The edges of a drawing in an order of their own: a drawing has none among its edges. */
const written = (entry: object) => JSON.stringify(Object.entries(entry).sort());
const edgesOf = (graph: { edges: readonly object[] }) => graph.edges.map(written).sort();
const edges = (...list: readonly object[]) => list.map(written).sort();
const ids = (parts: readonly { id: string }[]) => parts.map((part) => part.id);
const edge = (source: string, target: string, rest: Record<string, string> = {}) => ({
  source,
  target,
  ...rest
});

/** The value, or a failed test where there is none. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value.");
  return value;
}

describe("the drawing of a definition", () => {
  it("draws a step as a node, a loop as a group that holds its steps, and an edge for each next step", () => {
    const workflow = definition([
      trigger,
      operation("clients"),
      loop("each_client", [operation("bookings"), operation("save", "data_store.findings.insert")]),
      output
    ]);
    const graph = workflowGraph(workflow.steps, en);
    expect(ids(graph.nodes)).toEqual(["start", "clients", "bookings", "save", "result"]);
    expect(ids(graph.groups)).toEqual(["each_client"]);
    expect(
      graph.nodes.filter((node) => node.parentId === "each_client").map((node) => node.id)
    ).toEqual(["bookings", "save"]);
    // The file has no edges: they follow from the order of each list, and a loop is entered
    // and left as one part.
    expect(edgesOf(graph)).toEqual(
      edges(
        edge("start", "clients"),
        edge("clients", "each_client"),
        edge("bookings", "save"),
        edge("each_client", "result")
      )
    );
  });

  it("draws sixteen loops inside one another, each a group in the one before", () => {
    let steps: readonly Step[] = [operation("innermost")];
    for (let depth = WORKFLOW_MAX_BLOCK_DEPTH; depth >= 1; depth -= 1) {
      steps = [loop(`loop_${String(depth)}`, steps)];
    }
    const workflow = definition([trigger, ...steps, output]);
    const graph = workflowGraph(workflow.steps, en);

    expect(WORKFLOW_MAX_BLOCK_DEPTH).toBe(16);
    expect(graph.groups).toHaveLength(16);
    for (let depth = 2; depth <= 16; depth += 1) {
      expect(graph.groups[depth - 1]?.parentId).toBe(`loop_${String(depth - 1)}`);
    }
    expect(graph.nodes.find((node) => node.id === "innermost")?.parentId).toBe("loop_16");
    expect(edgesOf(graph)).toEqual(edges(edge("start", "loop_1"), edge("loop_1", "result")));
    expect(placedSteps(workflow.steps).get("innermost")).toMatchObject({
      blockId: "loop_16",
      repeated: true
    });
  });

  it("takes a step's source from the server's step facts, never from the manifest", async () => {
    const asset = {
      id: "asset_1",
      kind: "workflow",
      name: "month-end",
      scope: { kind: "instance" },
      revision: 1,
      publishedRevision: 1,
      updatedAt: "2026-10-19T00:00:00.000Z",
      stepFacts: {
        read: {
          effect: "reading",
          source: { kind: "connection", title: "Exampledata", service: "exampledata" }
        }
      },
      config: {
        name: "month-end",
        manifest: {
          id: "month-end",
          name: "Month end",
          steps: [
            {
              id: "read",
              name: "Read bookings",
              type: "operation",
              operation: "connection.crm.echo",
              effect: "changing",
              source: "Wrong manifest source",
              service: "wrong"
            }
          ]
        }
      }
    };
    const notBuilt = { code: "not_supported_yet", message: "Cannot", path: "steps[1].type" };
    const calls = recordedApiClient(({ operation: called }) =>
      called === "assets.get"
        ? asset
        : called === "assets.list"
          ? { items: [] }
          : {
              items: [
                {
                  id: "month-end",
                  name: "Month end",
                  definitionRevisionId: "r1",
                  runnable: false,
                  reasons: [notBuilt],
                  actions: [],
                  inputs: {}
                }
              ]
            }
    );
    const workflow = await createInstanceSource(calls.client, "instance").getWorkflow(
      "cw_1",
      "month-end",
      signal
    );
    expect(workflow.steps[0]).toMatchObject({
      source: "Exampledata",
      service: "exampledata",
      effect: "reading"
    });
    expect(workflowGraph(workflow.steps, en).nodes[0]?.chip).toEqual({
      label: "Exampledata",
      icon: "exampledata"
    });
    // The step path of a refusal survives the mapping of the list.
    expect(workflow.refusedFor).toEqual([notBuilt]);
  });
});

describe("a loop over thousands of items", () => {
  const workflow = definition([
    trigger,
    loop("each_client", [operation("bookings"), operation("save", "data_store.findings.insert")]),
    output
  ]);
  const counts = { total: 20_000, done: 11_988, failed: 12, running: 8 };
  const bookingsCounts = { total: 20_000, done: 12_004, failed: 4, running: 3 };
  const loopRun = stepRun({
    stepId: "each_client",
    stepType: "loop",
    status: "waiting",
    finishedAt: undefined,
    loop: counts,
    bodyCounts: {
      bookings: bookingsCounts,
      save: { total: 20_000, done: 11_988, failed: 8, running: 5 }
    }
  });
  // What a read without a filter would also hold: a step run of every item.
  const ofItems = Array.from({ length: 5_000 }, (_, index) =>
    stepRun({
      id: `sr_item_${String(index)}`,
      stepId: "bookings",
      status: index % 7 === 0 ? "failed" : "done",
      containerStepRunId: "sr_each_client",
      iteration: { index, label: `Client ${String(index)}` }
    })
  );

  it("draws the loop once with its counts, each step of it by the counts the loop carries", () => {
    const graph = workflowGraph(workflow.steps, en, runOf([stepRun({ stepId: "start" }), loopRun]));
    expect(ids(graph.nodes)).toEqual(["start", "bookings", "save", "result"]);
    expect(graph.groups[0]).toMatchObject({ status: "running", counts });
    expect(countsLine(counts, en)).toBe("11,988 done · 12 failed · 8 running · 7,992 to go");
    expect(graph.nodes.find((node) => node.id === "bookings")).toMatchObject({
      status: "running",
      footer: countsLine(bookingsCounts, en)
    });
  });

  it("reads no step run of an item: the drawing is the same with five thousand of them", () => {
    const frame = workflowGraph(workflow.steps, en, runOf([loopRun]));
    const flooded = workflowGraph(workflow.steps, en, runOf([...ofItems, loopRun, ...ofItems]));
    expect(flooded).toEqual(frame);
    // Where the instance sends no counts of a step, the step says nothing.
    const bare = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "waiting",
      loop: counts
    });
    const graph = workflowGraph(workflow.steps, en, runOf([bare, ...ofItems]));
    expect(graph.nodes.find((node) => node.id === "bookings")?.status).toBeUndefined();
  });

  it("leaves nothing to go once the loop has ended: a step no item reached was skipped", () => {
    const ended = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "done",
      loop: { total: 600, done: 595, failed: 5, running: 0 },
      bodyCounts: {
        bookings: { total: 600, done: 595, failed: 5, running: 0 },
        save: { total: 600, done: 595, failed: 0, running: 0 }
      }
    });
    const graph = workflowGraph(workflow.steps, en, runOf([ended]));
    expect(graph.groups[0]?.note).not.toContain("to go");
    expect(graph.nodes.find((node) => node.id === "save")?.status).toBe("done");
    const cancelled = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "cancelled",
      loop: { total: 600, done: 96, failed: 0, running: 0 },
      bodyCounts: {
        bookings: { total: 600, done: 96, failed: 0, running: 0 },
        save: { total: 600, done: 0, failed: 0, running: 0 }
      }
    });
    const stopped = workflowGraph(workflow.steps, en, runOf([cancelled]));
    expect(stopped.nodes.find((node) => node.id === "save")?.status).toBe("skipped");
  });

  it("warns, never a plain done, on a loop and a step of it that ended with failed items", () => {
    const ended = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "done",
      loop: { total: 600, done: 599, failed: 1, running: 0 },
      bodyCounts: {
        bookings: { total: 600, done: 599, failed: 1, running: 0 },
        save: { total: 599, done: 599, failed: 0, running: 0 }
      }
    });
    const graph = workflowGraph(workflow.steps, en, runOf([ended]));
    expect(graph.groups[0]?.status).toBe("doneWithFailures");
    expect(graph.nodes.find((node) => node.id === "bookings")?.status).toBe("doneWithFailures");
    expect(graph.nodes.find((node) => node.id === "save")?.status).toBe("done");
    // All of a step's items through while the loop still goes: the same warning.
    const going = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "waiting",
      finishedAt: undefined,
      loop: { total: 600, done: 590, failed: 1, running: 9 },
      bodyCounts: { bookings: { total: 600, done: 599, failed: 1, running: 0 } }
    });
    const running = workflowGraph(workflow.steps, en, runOf([going]));
    expect(running.nodes.find((node) => node.id === "bookings")?.status).toBe("doneWithFailures");
    expect(running.groups[0]?.status).toBe("running");
    // Every item failed stays failed.
    const allFailed = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "done",
      loop: { total: 2, done: 0, failed: 2, running: 0 },
      bodyCounts: { bookings: { total: 2, done: 0, failed: 2, running: 0 } }
    });
    const lost = workflowGraph(workflow.steps, en, runOf([allFailed]));
    expect(lost.nodes.find((node) => node.id === "bookings")?.status).toBe("failed");
  });

  it("lists the items a page of step runs speaks of, and opens on the failed ones", () => {
    const entries = loopEntries(ofItems.slice(0, 14).map(toWorkflowStepRun));
    expect(
      entries.filter((entry) => entry.status === "failed").map((entry) => entry.index)
    ).toEqual([0, 7]);
    expect(entries[7]?.failed?.stepId).toBe("bookings");
    expect(defaultEntryFilter(counts, false)).toBe("failed");
    expect(defaultEntryFilter({ ...counts, failed: 0 }, false)).toBe("running");
    expect(defaultEntryFilter({ ...counts, failed: 0 }, true)).toBe("all");
  });
});

describe("conditions, parallel blocks and child Workflows", () => {
  const condition: Step = {
    id: "any_findings",
    type: "condition",
    name: "Any findings?",
    when: { ref: { step: "clients", path: "count" }, op: "greater_than", value: 0 },
    then: [operation("remind"), operation("log")],
    else: [operation("file")]
  };
  const workflow = definition([trigger, operation("clients"), condition, output]);

  it("draws a condition with one exit per path, joins both after it, and leaves an empty path by its exit", () => {
    const graph = workflowGraph(workflow.steps, en);
    expect(
      graph.nodes.find((node) => node.id === "any_findings")?.exits?.map((exit) => exit.id)
    ).toEqual(["then", "else"]);
    expect(edgesOf(graph)).toEqual(
      edges(
        edge("start", "clients"),
        edge("clients", "any_findings"),
        edge("any_findings", "remind", { sourceExit: "then" }),
        edge("remind", "log"),
        edge("any_findings", "file", { sourceExit: "else" }),
        edge("log", "result"),
        edge("file", "result")
      )
    );
    const oneSided = definition([{ ...condition, else: [] }, output]);
    expect(workflowGraph(oneSided.steps, en).edges).toContainEqual(
      edge("any_findings", "result", { sourceExit: "else" })
    );
  });

  it("shows a failed path and marks the path the run did not take", () => {
    const run = runOf(
      [
        stepRun({ stepId: "start", stepType: "trigger" }),
        stepRun({ stepId: "clients" }),
        stepRun({ stepId: "any_findings", stepType: "condition", taken: "then" }),
        stepRun({ stepId: "remind", containerStepRunId: "sr_any_findings", branch: "then" }),
        stepRun({
          stepId: "log",
          status: "failed",
          containerStepRunId: "sr_any_findings",
          branch: "then",
          error: { code: "FORBIDDEN", message: "runner may not call it." }
        })
      ],
      "failed"
    );
    const graph = workflowGraph(workflow.steps, en, run);
    const state = (id: string) => graph.nodes.find((node) => node.id === id)?.status;
    expect([state("any_findings"), state("remind"), state("log"), state("file")]).toEqual([
      "done",
      "done",
      "failed",
      "skipped"
    ]);
    // The run has ended: the step after the block was not reached, and is dimmed as such.
    expect(state("result")).toBe("skipped");
    expect(graph.edges).toContainEqual(
      edge("any_findings", "file", { sourceExit: "else", state: "skipped" })
    );
    expect(graph.edges).toContainEqual(edge("log", "result"));
  });

  it("draws a parallel block as a group whose paths no edge joins, each step with its own run", () => {
    const parallel = definition([
      trigger,
      {
        id: "at_once",
        type: "parallel",
        name: "At the same time",
        branches: [
          { id: "team", name: "Team", steps: [operation("tell"), operation("note")] },
          { id: "clients", name: "Clients", steps: [operation("mail")] }
        ]
      },
      output
    ]);
    const graph = workflowGraph(parallel.steps, en);
    expect(graph.groups.map((group) => [group.id, group.kind])).toEqual([["at_once", "parallel"]]);
    expect(edgesOf(graph)).toEqual(
      edges(edge("start", "at_once"), edge("tell", "note"), edge("at_once", "result"))
    );
    const run = runOf([
      stepRun({
        stepId: "at_once",
        stepType: "parallel",
        status: "running",
        finishedAt: undefined
      }),
      stepRun({ stepId: "tell", containerStepRunId: "sr_at_once", branch: "team" }),
      stepRun({
        stepId: "mail",
        status: "running",
        finishedAt: undefined,
        containerStepRunId: "sr_at_once",
        branch: "clients"
      })
    ]);
    const ran = workflowGraph(parallel.steps, en, run);
    expect(ran.groups[0]?.status).toBe("running");
    expect(ran.nodes.map((node) => [node.id, node.status])).toEqual([
      ["start", undefined],
      ["tell", "done"],
      ["note", undefined],
      ["mail", "running"],
      ["result", undefined]
    ]);
  });

  it("draws a step that starts another Workflow as a subflow, and maps child and parent runs", () => {
    const parent = definition([
      { id: "remind", type: "workflow", name: "Remind", workflow: "send-reminders", input: {} }
    ]);
    expect(parent.steps[0]?.workflow).toBe("send-reminders");
    expect(workflowGraph(parent.steps, en).nodes[0]?.kind).toBe("subflow");
    expect(
      toWorkflowStepRun(stepRun({ stepId: "remind", stepType: "workflow", linkedRunId: "wr_9" }))
    ).toMatchObject({ kind: "workflow", childRunId: "wr_9" });
    expect(
      toWorkflowRun({
        id: "wr_9",
        workflow: "send-reminders",
        trigger: "parent",
        status: "running",
        startedBy: { id: "sp_1", label: "runner" },
        parentRunId: "wr_1",
        parentWorkflow: "check",
        createdAt: "2026-10-12T09:00:00.000Z"
      })
    ).toMatchObject({ parent: { runId: "wr_1", workflowId: "check" }, startedBy: undefined });
  });

  it("dims what a failed run did not reach, a loop with the steps it holds", () => {
    const withLoop = definition([
      trigger,
      operation("clients"),
      loop("each", [operation("save")]),
      output
    ]);
    const graph = workflowGraph(
      withLoop.steps,
      en,
      runOf(
        [
          stepRun({ stepId: "start", stepType: "trigger" }),
          stepRun({
            stepId: "clients",
            status: "failed",
            error: { code: "FORBIDDEN", message: "runner may not call it." }
          })
        ],
        "failed"
      )
    );
    expect(graph.groups[0]?.status).toBe("skipped");
    const state = (id: string) => graph.nodes.find((node) => node.id === id)?.status;
    expect([state("clients"), state("save"), state("result")]).toEqual([
      "failed",
      "skipped",
      "skipped"
    ]);
    // A run that is still going leaves what it has not reached as it is.
    const going = workflowGraph(withLoop.steps, en, runOf([stepRun({ stepId: "start" })]));
    expect(going.groups[0]?.status).toBeUndefined();
  });

  it("counts each part's reference of a joined text once per step (EW-TEXT)", () => {
    const mail: Step = {
      ...operation("mail", "mail.send"),
      input: {
        subject: {
          text: [
            "Result ",
            { ref: { step: "start", path: "input.month" } },
            { ref: { step: "read", path: "name" } }
          ]
        },
        body: { text: [{ ref: { step: "read", path: "rows" } }] }
      }
    };
    const view = definition([trigger, operation("read"), mail, output]);
    expect(view.steps.find((step) => step.id === "mail")?.sources).toEqual([
      { from: "run_input" },
      { from: "step", name: "Step read" }
    ]);
  });

  // DT-1b: a test run marks where each call went; a run of the published revision does not.
  it("marks each call of a test run with where it went, and nothing on a published run", () => {
    const tested = definition([
      trigger,
      operation("read", "connection.bookings.list"),
      operation("write", "data_store.invoices.insert"),
      output
    ]);
    const runs = [
      stepRun({ stepId: "start" }),
      stepRun({ stepId: "read", target: "live" }),
      stepRun({ stepId: "write", target: "dry_run" })
    ];
    const run = runOf(runs);
    const graph = workflowGraph(tested.steps, en, { ...run, run: { ...run.run, test: true } });
    const target = (id: string) => graph.nodes.find((node) => node.id === id)?.target;
    expect([target("start"), target("read"), target("write")]).toEqual([
      undefined,
      "live",
      "dry_run"
    ]);
    const published = workflowGraph(tested.steps, en, runOf(runs));
    expect(published.nodes.every((node) => node.target === undefined)).toBe(true);
  });
});

describe("a step's output as rows", () => {
  const rows = [
    { number: "10432", name: "Nordlicht GmbH", client_since: 2019, city: "Kiel" },
    { number: "10433", name: "Bäckerei Thomsen", client_since: 2021, city: "Husum" }
  ];

  it("reads a list of records as a table, keeps the whole records of a cut preview, and nothing else", () => {
    const text = JSON.stringify({ items: rows });
    expect(stepOutputRows({ text, truncated: false })).toEqual({
      columns: ["Number", "Name", "Client since"],
      rows: [
        ["10432", "Nordlicht GmbH", "2019"],
        ["10433", "Bäckerei Thomsen", "2021"]
      ],
      total: 2
    });
    const cut = stepOutputRows({ text: text.slice(0, text.length - 20), truncated: true });
    expect(cut?.rows).toEqual([["10432", "Nordlicht GmbH", "2019"]]);
    expect(cut?.total).toBeUndefined();
    expect(stepOutputRows({ text: '{"summary":"597 checked"}', truncated: false })).toBeUndefined();
    expect(stepOutputRows({ text: "[1,2,3]", truncated: false })).toBeUndefined();
  });
});

describe("schedules", () => {
  it("puts the forms a person writes into words, and nothing for one it cannot", () => {
    expect(scheduleInWords("30 7 * * *", en)).toBe(
      en.t("workflows.schedule.daily", { time: "07:30 AM" })
    );
    for (const cron of ["*/5 * * * *", "0 6 31 2 *", "0 6 1 * 1", "61 6 * * *", "0 6 * *"]) {
      expect(scheduleInWords(cron, en)).toBeUndefined();
    }
  });

  // ACCEPT-2a E1: the clock time is the cron's as written, in the schedule's zone, never
  // converted to the reader's.
  it("names the schedule's own zone, else the instance's, and the default where none is set", () => {
    const titleOf = (
      schedule: Record<string, unknown>,
      instance: { timeZone: string; defaulted: boolean }
    ) =>
      workflowGraph(
        definition([
          { ...trigger, triggers: [{ kind: "schedule", ...schedule }] },
          operation("load")
        ]).steps,
        en,
        undefined,
        undefined,
        instance
      ).nodes[0]?.title;
    const newYork = { timeZone: "America/New_York", defaulted: false };
    expect(titleOf({ cron: "25 23 * * *", timeZone: "Europe/Berlin" }, newYork)).toContain(
      "11:25 PM"
    );
    expect(titleOf({ cron: "25 23 * * *", timeZone: "Europe/Berlin" }, newYork)).toContain(
      "Berlin"
    );
    // Saved before schedules named a zone: it runs in the instance's.
    expect(titleOf({ cron: "25 23 * * *" }, newYork)).toContain("New York");
    expect(titleOf({ cron: "25 23 * * *" }, { timeZone: "UTC", defaulted: true })).toContain(
      "the default time zone"
    );
  });

  // WF-EDIT-5: each form of `ScheduleField` writes one cron and reads back as itself; a cron
  // outside these forms reads as none, so the Settings leave it untouched.
  it.each<[ScheduleValue, string]>([
    [{ kind: "hour", minute: 15, zone: "Europe/Berlin" }, "15 * * * *"],
    [{ kind: "weekday", time: "07:30", zone: "Europe/Berlin" }, "30 7 * * 1-5"],
    [{ kind: "week", days: [1, 3, 7], time: "18:00", zone: "Europe/Berlin" }, "0 18 * * 0,1,3"]
  ])("writes %o as %s and reads it back", (value, cron) => {
    expect(scheduleCron(value)).toBe(cron);
    expect(cronSchedule(cron, "Europe/Berlin")).toEqual(value);
  });

  it("reads a cron outside the forms as none, and writes nothing for a schedule not whole", () => {
    for (const cron of ["*/15 * * * *", "0 9 * * 1-3", "60 9 * * *", "@daily"]) {
      expect(cronSchedule(cron, "Europe/Berlin")).toBeUndefined();
    }
    expect(cronSchedule("0 8 * * 7", "Europe/Berlin")).toMatchObject({ kind: "week", days: [7] });
    expect(scheduleCron({ kind: "day", time: "", zone: "Europe/Berlin" })).toBeUndefined();
    expect(
      scheduleCron({ kind: "week", days: [], time: "09:00", zone: "Europe/Berlin" })
    ).toBeUndefined();
  });
});

// T31B: a parallel block drawn as lanes with a join after them, a chain of conditions in
// `else` drawn as one fork of several ways, and a run played back moment by moment.
describe("lanes, chains of conditions and a run played back (T31B)", () => {
  const step = (id: string): Step => ({
    id,
    type: "code",
    name: `Step ${id}`,
    file: "x.ts",
    input: {},
    inputSchema: OBJECT,
    outputSchema: OBJECT
  });
  const parallel = (
    id: string,
    branches: readonly { id: string; name?: string; steps: Step[] }[]
  ): Step => ({ id, type: "parallel", name: `Block ${id}`, branches });
  const condition = (id: string, then: Step[], otherwise: Step[]): Step => ({
    id,
    type: "condition",
    name: `Test ${id}`,
    when: { ref: { step: "load", path: "level" }, op: "equals", value: id },
    then,
    else: otherwise
  });
  const flow = (steps: readonly Step[]) => definition(steps, {});

  /** One load step and three analyses at the same time, the second two steps long. */
  const analyses = flow([
    step("load"),
    parallel("analyses", [
      { id: "revenue", name: "Umsatz", steps: [step("revenue_trend")] },
      { id: "costs", name: "Kosten", steps: [step("cost_groups"), step("cost_outliers")] },
      { id: "risks", name: "Risiken", steps: [step("risk_rating")] }
    ]),
    step("report")
  ]);

  const T0 = Date.parse("2026-10-28T07:00:00.000Z");
  const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
  const timed = (
    stepId: string,
    from: number,
    to: number | undefined,
    rest: Partial<StepRunResource> = {}
  ): StepRunResource => ({
    id: `sr_${stepId}`,
    stepId,
    stepType: "code",
    status: to === undefined ? "running" : "done",
    attempt: 1,
    createdAt: at(from),
    startedAt: at(from),
    ...(to === undefined ? {} : { finishedAt: at(to) }),
    ...rest
  });
  const inBlock = (branch: string) => ({ containerStepRunId: "sr_analyses", branch });

  /** The run of the analyses: they began together at 38 s; the costs took longest. */
  const analysisRuns = [
    timed("load", 0, 38),
    timed("analyses", 38, 251, {
      stepType: "parallel",
      bodyCounts: {
        revenue_trend: { total: 1, done: 1, failed: 0, running: 0 },
        cost_groups: { total: 1, done: 1, failed: 0, running: 0 },
        cost_outliers: { total: 1, done: 1, failed: 0, running: 0 },
        risk_rating: { total: 1, done: 1, failed: 0, running: 0 }
      }
    }),
    timed("revenue_trend", 38, 152, inBlock("revenue")),
    timed("cost_groups", 38, 81, inBlock("costs")),
    timed("cost_outliers", 81, 251, inBlock("costs")),
    timed("risk_rating", 38, 109, inBlock("risks")),
    timed("report", 251, 262)
  ];

  function laneRun(
    stepRuns: readonly StepRunResource[],
    ended: boolean,
    until = at(300)
  ): CanvasRun {
    return {
      run: toWorkflowRun({
        id: "wr_1",
        workflow: "check",
        trigger: "manual",
        status: ended ? "done" : "running",
        startedBy: { id: "u_1", label: "Dana Weber" },
        createdAt: at(0),
        startedAt: at(0),
        ...(ended ? { finishedAt: at(262) } : {})
      }),
      stepRuns: stepRuns.map(toWorkflowStepRun),
      now: new Date(until)
    };
  }

  it("puts each step of a parallel block in its lane, with one join after it", () => {
    const graph = workflowGraph(analyses.steps, de);
    const block = graph.groups.find((group) => group.id === "analyses");
    expect(block?.lanes?.map((lane) => lane.id)).toEqual(["revenue", "costs", "risks"]);
    const laneOf = (id: string) => graph.nodes.find((node) => node.id === id)?.lane;
    expect(["revenue_trend", "cost_groups", "cost_outliers", "risk_rating"].map(laneOf)).toEqual([
      "revenue",
      "costs",
      "costs",
      "risks"
    ]);
    // The block is entered once and left once: the step after it waits for every lane.
    expect(edgesOf(graph)).toEqual(
      edges(
        edge("load", "analyses"),
        edge("cost_groups", "cost_outliers"),
        edge("analyses", "report")
      )
    );
  });

  it("says in a run how each lane went and how long it took, as the run's timeline says it", () => {
    const run = laneRun(analysisRuns, true);
    const graph = workflowGraph(analyses.steps, de, run);
    const block = graph.groups.find((group) => group.id === "analyses");
    expect(block?.status).toBe("done");
    expect(block?.counts).toEqual({ total: 4, done: 4, failed: 0, running: 0 });
    const rows = timelineRows(analyses.steps, run.stepRuns, T0 + 300_000, de);
    for (const lane of block?.lanes ?? []) {
      expect(lane.status).toBe("done");
      expect(lane.meta).toBe(rows.find((row) => row.id === `analyses/${lane.id}`)?.meta);
    }
    expect(graph.nodes.find((node) => node.id === "cost_outliers")?.status).toBe("done");

    const running = laneRun(
      [
        timed("load", 0, 38),
        timed("analyses", 38, undefined, { stepType: "parallel" }),
        timed("revenue_trend", 38, 152, inBlock("revenue")),
        timed("cost_groups", 38, 81, inBlock("costs"))
      ],
      false,
      at(160)
    );
    // A lane runs while one of its steps is still to come; one not yet begun stays plain.
    expect(
      workflowGraph(analyses.steps, de, running).groups[0]?.lanes?.map((lane) => lane.status)
    ).toEqual(["done", "running", undefined]);
  });

  const chained = flow([
    step("load"),
    condition("high", [step("warn")], [condition("medium", [step("review")], [])]),
    step("report")
  ]);

  it("draws a chain of conditions in `else` as one fork with a way out per test", () => {
    expect(conditionChain(present(chained.steps[1])).map((test) => test.id)).toEqual([
      "high",
      "medium"
    ]);
    const graph = workflowGraph(chained.steps, de);
    const fork = graph.nodes.find((node) => node.id === "high");
    expect(fork?.exits?.map((exit) => [exit.id, exit.part?.id])).toEqual([
      ["then", undefined],
      ["medium:then", "medium"],
      ["medium:else", undefined]
    ]);
    expect(graph.nodes.some((node) => node.id === "medium")).toBe(false);
    expect(graph.tests.map((test) => [test.id, test.kind])).toEqual([["medium", "condition"]]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: "high", sourceExit: "then", target: "warn" },
        { source: "high", sourceExit: "medium:then", target: "review" },
        // The last `else` holds no step: it leaves the fork for the step after it.
        { source: "high", sourceExit: "medium:else", target: "report" }
      ])
    );
    // A step put on the way of the inner test goes into that test's path.
    expect(stepPlaceOf({ kind: "exit", nodeId: "high", exitId: "medium:then" })).toEqual({
      kind: "first",
      block: "medium",
      path: "then"
    });
  });

  it("marks the way the run took from the step runs of the inner test, and the others as skipped", () => {
    const run = laneRun(
      [
        timed("load", 0, 5),
        timed("high", 5, 5, { stepType: "condition" }),
        timed("medium", 5, 6, {
          stepType: "condition",
          containerStepRunId: "sr_high",
          branch: "else"
        }),
        timed("review", 6, 9, { containerStepRunId: "sr_medium", branch: "then" }),
        timed("report", 9, 10)
      ],
      true
    );
    const graph = workflowGraph(chained.steps, de, run);
    expect(graph.nodes.find((node) => node.id === "warn")?.status).toBe("skipped");
    expect(graph.nodes.find((node) => node.id === "review")?.status).toBe("done");
    expect(graph.edges).toContainEqual({
      source: "high",
      sourceExit: "medium:else",
      target: "report",
      state: "skipped"
    });
    expect(graph.nodes.find((node) => node.id === "high")?.exits?.[1]?.part?.status).toBe("done");
    expect(graph.tests[0]?.status).toBe("done");

    // Not reached: the inner test's row says so.
    const other = laneRun(
      [
        timed("load", 0, 5),
        timed("high", 5, 5, { stepType: "condition", taken: "then" }),
        timed("warn", 5, 7, { containerStepRunId: "sr_high", branch: "then" }),
        timed("report", 7, 8)
      ],
      true
    );
    const thenTaken = workflowGraph(chained.steps, de, other);
    expect(thenTaken.nodes.find((node) => node.id === "high")?.exits?.[1]?.part).toEqual({
      id: "medium",
      status: "skipped"
    });
  });

  it("gives each test of a longer chain its own row, and fails the fork where one test failed", () => {
    const longer = flow([
      step("load"),
      condition(
        "high",
        [step("warn")],
        [condition("medium", [step("review")], [condition("low", [step("note")], [])])]
      )
    ]);
    const run = laneRun(
      [
        timed("load", 0, 5),
        timed("high", 5, 5, { stepType: "condition" }),
        timed("medium", 5, 6, {
          stepType: "condition",
          containerStepRunId: "sr_high",
          branch: "else"
        }),
        timed("low", 6, 8, {
          stepType: "condition",
          status: "failed",
          containerStepRunId: "sr_medium",
          branch: "else"
        })
      ],
      true
    );
    const graph = workflowGraph(longer.steps, de, run);
    const fork = graph.nodes.find((node) => node.id === "high");
    expect(fork?.exits?.map((exit) => [exit.id, exit.part?.status])).toEqual([
      ["then", undefined],
      ["medium:then", "done"],
      ["low:then", "failed"],
      ["low:else", undefined]
    ]);
    expect(fork?.status).toBe("failed");
  });

  it("puts a condition in a lane, and a parallel block in a loop, each part in the block it stands in", () => {
    const nested = flow([
      step("load"),
      loop("each", [
        parallel("both", [
          { id: "left", steps: [condition("check", [step("fix")], [step("keep")])] },
          { id: "right", steps: [step("note")] }
        ])
      ])
    ]);
    const graph = workflowGraph(nested.steps, de);
    const place = (id: string) => {
      const part = [...graph.nodes, ...graph.groups].find((item) => item.id === id);
      return [part?.parentId, part?.lane];
    };
    expect(place("both")).toEqual(["each", undefined]);
    expect(place("check")).toEqual(["both", "left"]);
    // The steps of a condition's paths stay in the lane of the condition.
    expect(place("fix")).toEqual(["both", "left"]);
    expect(place("note")).toEqual(["both", "right"]);
  });

  describe("the layout of lanes", () => {
    const overlap = (a: FlowBox, b: FlowBox) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const node = (id: string, parentId?: string, lane?: string) => ({
      id,
      kind: "step" as const,
      eyebrow: "Step",
      title: id,
      ...(parentId === undefined ? {} : { parentId }),
      ...(lane === undefined ? {} : { lane })
    });
    const graph: FlowGraph = {
      nodes: [
        node("load"),
        node("a1", "block", "a"),
        node("b1", "block", "b"),
        node("b2", "block", "b"),
        node("c1", "block", "c"),
        node("after")
      ],
      groups: [
        {
          id: "block",
          kind: "parallel",
          eyebrow: "Parallel",
          title: "Block",
          lanes: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
            { id: "c", label: "C" }
          ]
        }
      ],
      edges: [
        { source: "load", target: "block" },
        { source: "b1", target: "b2" },
        { source: "block", target: "after" }
      ]
    };

    it("stands lanes side by side left to right and one under the other top to bottom, inside the frame", () => {
      const wide = layoutFlow({ graph, direction: "horizontal" });
      const box = (id: string) => present(wide.boxes.get(id));
      expect(wide.lanes.get("block")?.side).toBe(true);
      expect(box("a1").y).toBe(box("b1").y);
      expect(box("a1").x + box("a1").width).toBeLessThan(box("b1").x);
      expect(box("b2").x).toBe(box("b1").x);
      const block = box("block");
      for (const id of ["a1", "b1", "b2", "c1"]) {
        const part = box(id);
        expect(part.x).toBeGreaterThanOrEqual(block.x);
        expect(part.x + part.width).toBeLessThanOrEqual(block.x + block.width);
        expect(part.y + part.height).toBeLessThanOrEqual(block.y + block.height);
      }
      const tall = layoutFlow({ graph, direction: "vertical" });
      expect(tall.lanes.get("block")?.side).toBe(false);
      const parts = ["a1", "b1", "b2", "c1"].map((id) => present(tall.boxes.get(id)));
      for (const [index, a] of parts.entries()) {
        for (const b of parts.slice(index + 1)) expect(overlap(a, b)).toBe(false);
      }
    });

    it("nests a group with lanes in a lane of another, and folds one to its head", () => {
      const nested: FlowGraph = {
        nodes: [node("x1", "outer", "x"), node("in1", "inner", "p"), node("in2", "inner", "q")],
        groups: [
          {
            id: "outer",
            kind: "parallel",
            eyebrow: "",
            title: "Outer",
            lanes: [
              { id: "x", label: "X" },
              { id: "y", label: "Y" }
            ]
          },
          {
            id: "inner",
            parentId: "outer",
            lane: "y",
            kind: "parallel",
            eyebrow: "",
            title: "Inner",
            lanes: [
              { id: "p", label: "P" },
              { id: "q", label: "Q" }
            ]
          }
        ],
        edges: []
      };
      const layout = layoutFlow({ graph: nested, direction: "horizontal" });
      const box = (id: string) => present(layout.boxes.get(id));
      expect(box("in1").y).toBe(box("in2").y);
      expect(overlap(box("x1"), box("inner"))).toBe(false);
      const folded = layoutFlow({
        graph: nested,
        direction: "horizontal",
        collapsed: new Set(["inner"])
      });
      expect(folded.lanes.has("inner")).toBe(false);
      expect(folded.boxes.has("in1")).toBe(false);
      expect(folded.lanes.has("outer")).toBe(true);
    });
  });

  it("plays a run back moment by moment, the overlapping paths side by side", () => {
    const stepRuns = analysisRuns.map(toWorkflowStepRun);
    expect(replayMoments(stepRuns).map((moment) => (moment.at - T0) / 1000)).toEqual([
      0, 38, 81, 109, 152, 251, 262
    ]);
    const then = stepRunsAt(stepRuns, T0 + 60_000);
    const state = (id: string) => then.find((entry) => entry.stepId === id)?.status;
    expect(["load", "revenue_trend", "cost_groups", "cost_outliers"].map(state)).toEqual([
      "done",
      "running",
      "running",
      undefined
    ]);
    // The block's counts are those of that moment.
    expect(then.find((entry) => entry.stepId === "analyses")?.bodyCounts).toEqual({
      revenue_trend: { total: 1, done: 0, failed: 0, running: 1 },
      cost_groups: { total: 1, done: 0, failed: 0, running: 1 },
      risk_rating: { total: 1, done: 0, failed: 0, running: 1 }
    });
    const rows = timelineRows(analyses.steps, stepRuns, T0 + 300_000, de);
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ["load", 0],
      ["analyses", 0],
      ["analyses/revenue", 1],
      ["analyses/costs", 1],
      ["cost_groups", 2],
      ["cost_outliers", 2],
      ["analyses/risks", 1],
      ["report", 0]
    ]);
    expect(rows.find((row) => row.id === "analyses/costs")).toMatchObject({
      start: T0 + 38_000,
      end: T0 + 251_000
    });
  });
});

// WF-EDIT-1: the step operations a person makes, carried over to a draft the agent saved
// meanwhile, and what a draft changes against the published revision.
describe("editing a Workflow by hand (WF-EDIT-1)", () => {
  const published = {
    id: "client-notes",
    name: "Client notes",
    inputs: { type: "object", properties: { region: { type: "string", title: "Region" } } },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "clients",
        name: "Load the clients",
        description: "The clients of one region.",
        type: "operation",
        operation: "crm.list",
        input: { region: { ref: { step: "start", path: "input.region" } } }
      },
      {
        id: "each",
        name: "For each client",
        type: "loop",
        items: { step: "clients", path: "rows" },
        steps: [
          {
            id: "summary",
            name: "Write the summary",
            type: "agent",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", properties: { note: { type: "string" } } }
          }
        ]
      },
      {
        id: "notice",
        name: "Tell the office",
        type: "notify",
        to: { users: ["user_1"] },
        channels: ["inbox"],
        title: { value: "Notes are ready" },
        text: { value: "The client notes are written." }
      },
      { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
    ]
  };
  const set = (step: string, fields: Record<string, unknown>): StepEdit => ({
    kind: "set",
    step,
    fields
  });
  const stepsOf = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(isRecord) : [];

  it("sets the fields of a step at any depth and leaves every other step and the given manifest as they were", () => {
    const next = applyStepEdits(published, [
      set("summary", { name: "Write the note" }),
      set("notice", { title: { value: "Done" } })
    ]);
    expect(stepsOf(stepsOf(next.steps)[2]?.steps)[0]).toMatchObject({
      id: "summary",
      name: "Write the note"
    });
    expect(stepsOf(next.steps)[3]).toMatchObject({ title: { value: "Done" } });
    expect(stepsOf(next.steps)[1]).toEqual(published.steps[1]);
    expect(published.steps[3]).toMatchObject({ title: { value: "Notes are ready" } });
    expect(applyStepEdits(published, [set("gone", { name: "x" })])).toEqual(published);
  });

  it("takes a field away for undefined, never changes an id or a type, and sets the Workflow's own fields", () => {
    const next = applyStepEdits(published, [
      set("notice", { link: { kind: "run" } }),
      set("notice", { link: undefined, id: "other", type: "agent" }),
      set(WORKFLOW_FIELDS, { outputs: { type: "object" }, id: "renamed", steps: [] })
    ]);
    const notice = stepsOf(next.steps)[3] ?? {};
    expect(notice).not.toHaveProperty("link");
    expect(notice).toMatchObject({ id: "notice", type: "notify" });
    expect(next).toMatchObject({ id: "client-notes", outputs: { type: "object" } });
    expect(next.steps).toHaveLength(5);
  });

  describe("a save after the agent saved meanwhile", () => {
    const edits = [set("notice", { title: { value: "The notes are ready" } })];

    it("carries the edits over without a question where the agent changed another step", () => {
      const latest = applyStepEdits(published, [set("clients", { name: "Load every client" })]);
      const rebased = rebaseStepEdits({ base: published, latest, edits });
      expect(rebased).toEqual({ edits, conflicts: [], dropped: [] });
      const saved = JSON.stringify(applyStepEdits(latest, rebased.edits));
      expect(saved).toContain("Load every client");
      expect(saved).toContain("The notes are ready");
    });

    it("keeps the person's value and names the agent's where both changed a field, unless they agree", () => {
      const latest = applyStepEdits(published, [
        set("notice", { title: { value: "Agent title" } })
      ]);
      const rebased = rebaseStepEdits({ base: published, latest, edits });
      expect(rebased.edits).toEqual(edits);
      expect(rebased.conflicts).toEqual([
        { step: "notice", field: "title", theirs: { value: "Agent title" } }
      ]);
      const same = applyStepEdits(published, edits);
      expect(rebaseStepEdits({ base: published, latest: same, edits }).conflicts).toEqual([]);
    });

    it("drops the edits of a step the agent deleted", () => {
      const latest = { ...published, steps: published.steps.filter((s) => s.id !== "notice") };
      expect(rebaseStepEdits({ base: published, latest, edits })).toEqual({
        edits: [],
        conflicts: [],
        dropped: ["notice"]
      });
    });
  });

  describe("what a draft changes against the published revision", () => {
    it("names new, changed, removed and moved steps, and the fields that changed", () => {
      expect(draftChanges(undefined, published).steps.size).toBe(0);
      const steps = published.steps;
      const draft = {
        ...published,
        steps: [
          steps[0],
          steps[3],
          { ...steps[1], name: "Load every client" },
          { id: "extra", name: "Look up the region", type: "agent" },
          steps[4]
        ]
      };
      const changes = draftChanges(published, draft);
      expect(Object.fromEntries(changes.steps)).toMatchObject({
        clients: "changed",
        extra: "new",
        each: "removed",
        summary: "removed"
      });
      expect(changes.fields.get("clients")).toEqual(["name"]);
      // Of two steps that swapped places, one is the one that moved.
      const moved = draftChanges(published, {
        ...published,
        steps: [steps[0], steps[3], steps[1], steps[2], steps[4]]
      });
      expect([...moved.steps.keys()]).toHaveLength(1);
      expect(moved.fields.size).toBe(0);
      // Only the block is drawn back; its step goes with it.
      expect(changes.removed).toEqual([{ id: "each", list: "", after: "clients" }]);
    });

    it("marks a step that moved into a block as changed, and puts a removed step back where it stood", () => {
      const steps = published.steps;
      const intoLoop = {
        ...published,
        steps: [
          steps[0],
          steps[1],
          { ...steps[2], steps: [...stepsOf(steps[2]?.steps), steps[3]] },
          steps[4]
        ]
      };
      expect(Object.fromEntries(draftChanges(published, intoLoop).steps)).toEqual({
        notice: "changed"
      });
      const without = { ...published, steps: steps.filter((step) => step.id !== "notice") };
      const drawn = withRemovedSteps(
        workflowSteps(without),
        workflowSteps(published),
        draftChanges(published, without).removed
      );
      expect(drawn.map((step) => step.id)).toEqual([
        "start",
        "clients",
        "each",
        "notice",
        "result"
      ]);
    });

    it("draws a changed step on the canvas with its published sentence beside it", () => {
      const draft = applyStepEdits(published, [
        set("clients", { description: "Every client of the region." })
      ]);
      const was = workflowSteps(published).find((step) => step.id === "clients");
      const graph = workflowGraph(
        workflowSteps(draft),
        en,
        undefined,
        undefined,
        undefined,
        new Map([
          ["clients", { change: "changed" as const, ...(was === undefined ? {} : { was }) }],
          ["notice", { change: "unsaved" as const }]
        ])
      );
      const node = (id: string) => graph.nodes.find((candidate) => candidate.id === id);
      expect(node("clients")).toMatchObject({
        change: "changed",
        summary: "Every client of the region.",
        oldSummary: "The clients of one region."
      });
      expect(node("notice")?.change).toBe("unsaved");
      expect(node("start")?.change).toBeUndefined();
    });
  });

  it("offers the run input and each earlier step's result, nearest first, and a loop's entry inside it", () => {
    const words = { entry: (name: string) => `Each entry of ${name}`, input: "Run input" };
    const facts = {
      clients: {
        outputSchema: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: { type: "object", properties: { name: { type: "string" } } }
            },
            count: { type: "integer", title: "How many" }
          }
        }
      }
    };
    expect(earlierFields(published, "notice", facts, words)).toEqual([
      {
        heading: "Load the clients",
        options: [
          { value: "clients#rows", label: "rows" },
          { value: "clients#count", label: "How many" }
        ]
      },
      { heading: "Run input", options: [{ value: "start#input.region", label: "Region" }] }
    ]);
    expect(earlierFields(published, "each", facts, words, { lists: true })).toEqual([
      { heading: "Load the clients", options: [{ value: "clients#rows", label: "rows" }] }
    ]);
    expect(earlierFields(published, "summary", facts, words)[0]?.options).toEqual([
      { value: "each#name", label: "name" }
    ]);
  });

  it("puts what the instance refuses under the field it names, and keeps the rest apart", () => {
    expect(issuePlace(["steps.notice.title"], published)).toEqual({
      step: "notice",
      field: "title"
    });
    expect(issuePlace(["manifest", "steps", "1", "name"], published)).toEqual({
      step: "clients",
      field: "name"
    });
    expect(issuePlace(["steps.result.input.done"], published)).toEqual({
      step: "result",
      field: "input",
      name: "done"
    });
    expect(issuePlace(["steps.2.steps.0.name"], published)).toEqual({
      step: "summary",
      field: "name"
    });
    expect(issuePlace(["steps.gone.name"], published)).toBeUndefined();
    const issues = editIssues(
      [
        { message: "A step reads a later step", path: ["steps.notice.text"] },
        { message: "The one output step is the last step", path: ["steps"] }
      ],
      published
    );
    expect(issues.fields.get("notice:text")).toBe("A step reads a later step");
    expect(issues.other).toEqual(["The one output step is the last step"]);
  });
});

// WF-EDIT-4: where a new step goes for each place of the canvas, the id it takes from its
// name, which steps stop a delete, and that a block moves with what it holds.
describe("adding, deleting and moving steps (WF-EDIT-4)", () => {
  type Manifest = Readonly<Record<string, unknown>>;
  const idsOf = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter(isRecord).map((step) => String(step.id)) : [];
  const listOf = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(isRecord) : [];
  const stepIn = (manifest: Manifest, id: string): Record<string, unknown> =>
    required(listOf(manifest.steps).find((step) => step.id === id));

  const draft: Manifest = {
    id: "client-notes",
    name: "Client notes",
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "clients", name: "Load the clients", type: "operation", operation: "crm.list" },
      {
        id: "each",
        name: "For each client",
        type: "loop",
        items: { step: "clients", path: "rows" },
        steps: [
          { id: "summary", name: "Write the summary", type: "operation", operation: "notes.write" },
          { id: "file", name: "File the summary", type: "operation", operation: "notes.file" }
        ]
      },
      {
        id: "check",
        name: "Any notes?",
        type: "condition",
        if: { value: true },
        then: [
          { id: "notice", name: "Tell the office", type: "operation", operation: "mail.send" }
        ],
        else: []
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { notes: { ref: { step: "clients", path: "rows" } } }
      }
    ]
  };
  const fields = { name: "Check the address", type: "operation", operation: "crm.check" };

  it("puts a new step after an edge's source, first on a condition's path, last in a loop, nowhere gone", () => {
    const next = applyStepEdits(draft, [
      {
        kind: "insert",
        step: "address",
        at: stepPlaceOf({ kind: "edge", source: "clients", target: "each" }),
        fields
      },
      {
        kind: "insert",
        step: "other",
        at: stepPlaceOf({ kind: "exit", nodeId: "check", exitId: "else" }),
        fields
      },
      {
        kind: "insert",
        step: "archive",
        at: stepPlaceOf({ kind: "end", groupId: "each" }),
        fields
      }
    ]);
    expect(idsOf(next.steps)).toEqual(["start", "clients", "address", "each", "check", "result"]);
    expect(idsOf(stepIn(next, "check").else)).toEqual(["other"]);
    expect(idsOf(stepIn(next, "each").steps)).toEqual(["summary", "file", "archive"]);
    const gone = stepPlaceOf({ kind: "edge", source: "gone", target: "each" });
    expect(applyStepEdits(draft, [{ kind: "insert", step: "x", at: gone, fields }])).toBe(draft);
  });

  it("spells a new step's id from its name, never one the Workflow has, and keeps it on rename", () => {
    expect(stepIdFrom("Größe & Maß", new Set())).toBe("groesse_mass");
    expect(stepIdFrom("!!!", new Set())).toBe("step");
    expect(stepIdFrom("x".repeat(80), new Set())).toHaveLength(56);
    expect(
      stepIdFrom("Load the clients", new Set(["load_the_clients", "load_the_clients_2"]))
    ).toBe("load_the_clients_3");
    const at = stepPlaceOf({ kind: "edge", source: "clients", target: "each" });
    const next = applyStepEdits(draft, [
      { kind: "insert", step: "check_the_address", at, fields },
      { kind: "set", step: "check_the_address", fields: { name: "Prüfe die Adresse" } }
    ]);
    expect(stepIn(next, "check_the_address").name).toBe("Prüfe die Adresse");
  });

  it("names the steps that read a result before a delete, and takes a block away with what it holds", () => {
    expect(readersOf(draft, "clients").map((step) => step.id)).toEqual(["each", "result"]);
    expect(readersOf(draft, "each")).toEqual([]);
    expect(heldIds(stepIn(draft, "each"))).toEqual(["each", "summary", "file"]);
    const next = applyStepEdits(draft, [{ kind: "delete", step: "each" }]);
    expect(idsOf(next.steps)).toEqual(["start", "clients", "check", "result"]);
    expect(JSON.stringify(next)).not.toContain("summary");
  });

  it("moves a loop with the steps it holds, never a block into itself", () => {
    const at = stepPlaceOf({ kind: "exit", nodeId: "check", exitId: "then" });
    const next = applyStepEdits(draft, [{ kind: "move", step: "each", at }]);
    expect(idsOf(next.steps)).toEqual(["start", "clients", "check", "result"]);
    const then = listOf(stepIn(next, "check").then)[0];
    expect(then?.id).toBe("each");
    expect(idsOf(then?.steps)).toEqual(["summary", "file"]);
    const inside = stepPlaceOf({ kind: "edge", source: "summary", target: "file" });
    expect(applyStepEdits(draft, [{ kind: "move", step: "each", at: inside }])).toBe(draft);
  });

  it("drops an add or a move whose place the agent deleted meanwhile", () => {
    const latest = applyStepEdits(draft, [{ kind: "delete", step: "check" }]);
    const edits: StepEdit[] = [
      {
        kind: "insert",
        step: "address",
        at: { kind: "first", block: "check", path: "then" },
        fields
      },
      { kind: "move", step: "file", at: { kind: "after", step: "notice" } },
      { kind: "move", step: "summary", at: { kind: "after", step: "clients" } }
    ];
    const rebased = rebaseStepEdits({ base: draft, latest, edits });
    expect(rebased.dropped).toEqual(["address", "file"]);
    expect(rebased.edits).toEqual([edits[2]]);
  });

  it("offers no place beside or inside the step that moves", () => {
    const graph = workflowGraph(workflowSteps(draft), en);
    const { shows } = editPlaces(graph, draft, "each", en.t);
    expect(shows?.({ kind: "edge", source: "clients", target: "each" })).toBe(false);
    expect(shows?.({ kind: "edge", source: "each", target: "check" })).toBe(false);
    expect(shows?.({ kind: "edge", source: "summary", target: "file" })).toBe(false);
    expect(shows?.({ kind: "end", groupId: "each" })).toBe(false);
    expect(shows?.({ kind: "exit", nodeId: "check", exitId: "then" })).toBe(true);
    expect(
      editPlaces(graph, draft, undefined, en.t).shows?.({ kind: "end", groupId: "each" })
    ).toBe(true);
  });

  it("offers in the palette the step types this release runs, and makes each a type the definition takes", () => {
    const operations: CallableOperationOption[] = [
      {
        name: "crm.list",
        title: "List the clients",
        effect: "reading",
        source: { kind: "connection", title: "CRM" },
        available: true
      },
      {
        name: "mail.send",
        title: "Send mail",
        effect: "changing",
        source: { kind: "other", title: "Example office" },
        available: true
      }
    ];
    const values = paletteGroups(operations, en.t).flatMap((group) =>
      group.options.map((option) => option.value)
    );
    expect(values).toEqual([
      "operation:crm.list",
      "agent",
      "python",
      "javascript",
      "loop",
      "workflow",
      "notify",
      "operation:mail.send"
    ]);
    expect(required(newStepOf("python", operations, en.t)).fields("pruefe")).toMatchObject({
      type: "code",
      file: "pruefe.py"
    });
    expect(required(newStepOf("operation:crm.list", operations, en.t)).fields("x")).toEqual({
      type: "operation",
      name: "List the clients",
      operation: "crm.list",
      input: {}
    });
    // MAIL-3b: a mail from the palette sends as the instance's own sender.
    expect(required(newStepOf("operation:mail.send", operations, en.t)).fields("m")).toMatchObject({
      operation: "mail.send",
      input: { sender: { value: "system" } }
    });
    expect(newStepOf("condition", operations, en.t)).toBeUndefined();
  });
});

// WF-EDIT-2: the answer of an AI step or a script as a list of fields in the subset of JSON
// Schema every model binding takes; the schema of a picked value; a script as a field.
describe("the fields Settings edit (WF-EDIT-2, WF-EDIT-5c)", () => {
  const every = {
    type: "object",
    properties: {
      summary: { type: "string", description: "One line." },
      score: { type: "number" },
      count: { type: "integer", title: "How many" },
      urgent: { type: "boolean" },
      status: { type: "string", enum: ["open", "done"] },
      tags: { type: "array", items: { type: "string" } },
      client: {
        type: "object",
        properties: { name: { type: "string" }, since: { type: "integer" } },
        required: ["name"]
      },
      lines: {
        type: "array",
        items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
      }
    },
    required: ["summary", "status"]
  };

  it("reads every kind of field and writes the same schema back", () => {
    const fields = schemaFields(every);
    expect(fields?.map((field) => [field.name, field.kind, field.required])).toEqual([
      ["summary", "text", true],
      ["score", "number", false],
      ["count", "integer", false],
      ["urgent", "boolean", false],
      ["status", "choice", true],
      ["tags", "list", false],
      ["client", "record", false],
      ["lines", "records", false]
    ]);
    expect(fieldsSchema(fields ?? [], every)).toEqual(every);
    expect(schemaFields(undefined)).toEqual([]);
    expect(
      fieldsSchema([
        { id: "a", name: "summary", kind: "text", required: true },
        { id: "b", name: " ", kind: "number", required: false }
      ])
    ).toEqual({
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"]
    });
  });

  it("refuses a schema outside the subset, and names what holds a save back", () => {
    expect(
      schemaFields({
        type: "object",
        properties: {
          client: {
            type: "object",
            properties: { address: { type: "object", properties: { city: { type: "string" } } } }
          }
        }
      })
    ).toBeUndefined();
    expect(schemaFields({ type: "object", properties: { next: { $ref: "#" } } })).toBeUndefined();
    expect(schemaFields({ type: "array", items: { type: "string" } })).toBeUndefined();
    expect(
      fieldListProblems([
        { id: "a", name: "", title: " ", kind: "text", required: false },
        { id: "b", name: "x", title: "X", kind: "text", required: false },
        { id: "c", name: "x", title: "Y", kind: "choice", required: false, choices: [" "] }
      ])
    ).toEqual({ a: { title: "missing" }, c: { name: "taken", choices: "missing" } });
  });

  it("keys a new field from its title, keeps a saved field's key when its title changes, and makes keys unique", () => {
    const saved = {
      type: "object",
      properties: {
        month: { type: "string", title: "Month" },
        client: { type: "object", properties: { name: { type: "string" } } }
      }
    };
    const fresh = { id: "new", name: "", kind: "text" as const, required: false };
    expect(
      withKeys([{ ...fresh, name: "monat", title: "Größe des Büros" }], undefined)[0]?.name
    ).toBe("groesse_des_bueros");
    expect(withKeys([{ ...fresh, title: "2026" }], undefined)[0]?.name).toBe("field");
    const renamed = (schemaFields(saved) ?? []).map((field) =>
      field.name === "month" ? { ...field, title: "Billing month" } : field
    );
    const keyed = withKeys([...renamed, { ...fresh, title: "Month" }], saved);
    expect(keyed.map((field) => field.name)).toEqual(["month", "client", "month_2"]);
    expect(fieldsSchema(keyed, saved).properties).toEqual({
      month: { type: "string", title: "Billing month" },
      client: { type: "object", properties: { name: { type: "string" } } },
      month_2: { type: "string", title: "Month" }
    });
  });

  const manifest = {
    id: "notes",
    name: "Notes",
    inputs: { type: "object", properties: { region: { type: "string", title: "Region" } } },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "clients",
        name: "Load the clients",
        type: "operation",
        operation: "crm.list",
        input: {}
      },
      {
        id: "each",
        name: "For each client",
        type: "loop",
        items: { step: "clients", path: "rows" },
        steps: [{ id: "compute", name: "Count", type: "code", file: "compute.py", input: {} }]
      }
    ]
  };

  it("gives a picked value the schema of its field, and keeps an unchosen pick as one that holds the save back", () => {
    const facts = {
      clients: {
        outputSchema: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: { type: "object", properties: { since: { type: "integer", title: "Since" } } }
            }
          }
        }
      }
    };
    expect(pickedSchema(manifest, facts, { step: "start", path: "input.region" })).toEqual({
      type: "string",
      title: "Region"
    });
    expect(pickedSchema(manifest, facts, { step: "each", path: "since" })).toEqual({
      type: "integer",
      title: "Since"
    });
    expect(pickedSchema(manifest, facts, { step: "clients", path: "gone" })).toBeUndefined();
    const pending = draftValueOf({ kind: "picked", option: "" });
    const rows = rowsOf({ count: pending });
    expect(rows).toEqual([{ name: "count", value: { kind: "picked", option: "" } }]);
    expect(mappingOf(rows ?? [])).toBeUndefined();
  });

  it("writes a script to the step's file, never into the manifest, and names the agent's script on a conflict", () => {
    const files = [{ path: "steps/compute.py", content: "print(1)" }];
    const edit = { kind: "set" as const, step: "compute", fields: { [SCRIPT_FIELD]: "print(2)" } };
    expect(applyStepEdits(manifest, [edit])).toEqual(manifest);
    expect(applyFileEdits(manifest, files, [edit])).toEqual([
      { path: "steps/compute.py", content: "print(2)" }
    ]);
    expect(applyFileEdits(manifest, [], [edit])).toEqual([
      { path: "steps/compute.py", content: "print(2)" }
    ]);
    expect(stepValue(manifest, files, "compute", SCRIPT_FIELD)).toBe("print(1)");
    const rebase = (latestFiles: typeof files) =>
      rebaseStepEdits({
        base: manifest,
        latest: manifest,
        edits: [edit],
        baseFiles: files,
        latestFiles
      }).conflicts;
    expect(rebase([{ path: "steps/compute.py", content: "print(3)" }])).toEqual([
      { step: "compute", field: SCRIPT_FIELD, theirs: "print(3)" }
    ]);
    expect(rebase(files)).toEqual([]);
  });
});

describe("the start form of a Workflow", () => {
  const inputs = {
    type: "object",
    properties: {
      month: { type: "string", format: "date", title: "Month", description: "The first day." },
      client_id: { type: "string", minLength: 3, maxLength: 8, pattern: "^K[0-9]+$" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      share: { type: ["number", "null"], exclusiveMinimum: 0, exclusiveMaximum: 1 },
      region: { type: "string", enum: ["north", "south"], default: "south" },
      notify: { type: "boolean" },
      contact: { type: "string", format: "email" }
    },
    // Not the order of `properties`: an instance stores those in an order of its own.
    required: ["client_id", "month", "region"]
  };

  it("has one field per input, the required ones first, with its rules and its default", () => {
    const form = startFormOf(inputs);
    expect(form.unsupported).toEqual([]);
    expect(form.fields.map((field) => [field.name, field.control, field.required])).toEqual([
      ["client_id", "text", true],
      ["month", "date", true],
      ["region", "choice", true],
      ["limit", "number", false],
      ["share", "number", false],
      ["notify", "yesNo", false],
      ["contact", "email", false]
    ]);
    expect(form.fields[0]).toMatchObject({ minLength: 3, maxLength: 8, pattern: "^K[0-9]+$" });
    expect(form.fields[2]).toMatchObject({ initial: "south", options: ["north", "south"] });
    expect(form.fields[3]).toMatchObject({
      initial: "10",
      integer: true,
      minimum: 1,
      maximum: 100
    });
    for (const none of [undefined, "inputs", { type: "object" }, { properties: [] }]) {
      expect(startFormOf(none)).toEqual({ fields: [], unsupported: [] });
    }
  });

  it("names the inputs it has no field for, and which of them a start needs", () => {
    const form = startFormOf({
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        either: { type: ["string", "number"] },
        broken: "not a schema",
        note: { type: "string", pattern: "([" }
      },
      required: ["ids", 7]
    });
    expect(form.unsupported).toEqual([
      { name: "ids", required: true },
      { name: "either", required: false },
      { name: "broken", required: false }
    ]);
    // A pattern the browser cannot read is the instance's to check, not the form's.
    expect(form.fields).toEqual([
      { name: "note", label: "Note", control: "text", required: false, initial: "" }
    ]);
  });

  it("makes the run's input from what was entered, and refuses what the inputs refuse", () => {
    const form = startFormOf(inputs);
    expect(
      checkStartForm(form, {
        month: "2026-09-01",
        client_id: "K123",
        limit: "25",
        share: "",
        region: "north",
        notify: true,
        contact: ""
      })
    ).toEqual({
      ok: true,
      input: { month: "2026-09-01", client_id: "K123", limit: 25, region: "north", notify: true }
    });
    const problems = (values: Record<string, string | boolean>) => {
      const check = checkStartForm(form, values);
      return check.ok ? {} : Object.fromEntries(check.problems);
    };
    expect(Object.keys(problems({})).sort()).toEqual(["client_id", "month", "region"]);
    const filled = { month: "2026-09-01", client_id: "K123", region: "north" };
    expect(problems({ ...filled, client_id: "K1" })).toEqual({
      client_id: { key: "workflows.startForm.tooShort", values: { limit: 3 } }
    });
    expect(Object.keys(problems({ ...filled, client_id: "X1234" }))).toEqual(["client_id"]);
    expect(Object.keys(problems({ ...filled, limit: "2.5" }))).toEqual(["limit"]);
    expect(Object.keys(problems({ ...filled, share: "1" }))).toEqual(["share"]);
    expect(Object.keys(problems({ ...filled, region: "west" }))).toEqual(["region"]);
    expect(Object.keys(problems({ ...filled, contact: "nobody" }))).toEqual(["contact"]);
    expect(Object.keys(problems({ ...filled, client_id: "   " }))).toEqual(["client_id"]);
  });

  it("keeps an input named like a property of every object as a field of its own", () => {
    const form = startFormOf(
      JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}},"required":["__proto__","constructor"]}'
      )
    );
    expect(form.fields.map((field) => field.name)).toEqual(["__proto__", "constructor"]);
    const missing = checkStartForm(form, {});
    expect(missing.ok ? [] : [...missing.problems.keys()]).toEqual(["__proto__", "constructor"]);
    const values: Record<string, string> = Object.fromEntries([
      ["__proto__", "a"],
      ["constructor", "b"]
    ]);
    const check = checkStartForm(form, values);
    expect(check.ok && JSON.stringify(check.input)).toBe('{"__proto__":"a","constructor":"b"}');
    expect(check.ok && Object.getPrototypeOf(check.input)).toBe(Object.prototype);
  });

  it("puts each value the instance refused under its field and keeps the rest for the form", () => {
    const { fields, rest } = startRefusalByField(startFormOf(inputs), [
      { path: ["limit"], message: "must be <= 100" },
      { path: ["limit"], message: "must be integer" },
      { path: [], message: "must have required property 'month'" },
      { path: ["unknown"], message: "must NOT have additional properties" }
    ]);
    expect(Object.fromEntries(fields)).toEqual({ limit: "must be <= 100" });
    expect(rest).toEqual([
      "must be integer",
      "must have required property 'month'",
      "must NOT have additional properties"
    ]);
  });
});

// LOWS-C 5: a run names the account it acted as, as its own; the samples answer through the
// instance's mapping, so every sample run carries that account.
it("gives every sample run, listed, read or started, the account it ran as", async () => {
  const source = createSampleSource("en");
  const runs = required(source.runs);
  const workflows = await source.listWorkflows("cw_1", { limit: 50, cursor: undefined }, signal);
  expect(workflows.items.length).toBeGreaterThan(0);
  const accounts: (string | undefined)[] = [];
  for (const workflow of workflows.items) {
    expect((await source.getWorkflow("cw_1", workflow.id, signal)).runsAs).toBe("Workflow runner");
    const listed = await runs.listRuns(workflow.id, { limit: 50, cursor: undefined }, signal);
    for (const run of listed.items) {
      accounts.push(run.runsAs, (await runs.getRun(run.id, signal)).runsAs);
    }
  }
  expect(accounts.length).toBeGreaterThan(0);
  expect(new Set(accounts)).toEqual(new Set(["Workflow runner"]));
  const started = await runs.start("monthly-booking-check", {});
  expect((await runs.getRun(started.id, signal)).runsAs).toBe("Workflow runner");
});

// EW-10: pinned step outputs: the calls the instance's source makes for the reader's pins, and
// what a step's panel offers for each state of a pin.
describe("pinned step outputs (EW-10)", () => {
  const draft = toWorkflow(
    {
      name: "notify-clients",
      config: {
        id: "notify-clients",
        name: "Notify clients",
        steps: [
          { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
          { id: "clients", name: "Load", type: "operation", operation: "connection.crm.list" },
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      },
      publishedRevision: undefined
    },
    { mayStart: false },
    { draftRevision: 3 }
  );
  const testRun = (input: Partial<Parameters<typeof toWorkflowRun>[0]> = {}) => ({
    id: "wr_second",
    workflow: "notify-clients",
    trigger: "manual" as const,
    mode: "test" as const,
    status: "done" as const,
    startedBy: { id: "user_kai", label: "Kai" },
    createdAt: "2026-10-30T09:00:00.000Z",
    ...input
  });

  it("reads the reader's pins, pins a step's output of a run and drops a pin", async () => {
    const pin = { step: "clients", runId: "wr_first", pinnedAt: "2026-10-30T09:00:00.000Z" };
    const { client, calls } = recordedApiClient(({ operation: called }) =>
      called === "workflows.list_pins"
        ? { items: [pin] }
        : called === "workflows.pin_step"
          ? pin
          : { removed: true }
    );
    const source = createInstanceSource(client, "k");
    expect(await source.drafts?.listPins?.("notify-clients", signal)).toEqual([pin]);
    await source.drafts?.pinStep?.("notify-clients", "clients", "wr_first");
    await source.drafts?.unpinStep?.("notify-clients", "clients");
    expect(calls.map((call) => call.operation)).toEqual([
      "workflows.list_pins",
      "workflows.pin_step",
      "workflows.unpin_step"
    ]);
    expect(calls[1]).toMatchObject({ params: { workflow: "notify-clients", step: "clients" } });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ runId: "wr_first" });
    expect(calls[2]).toMatchObject({ params: { workflow: "notify-clients", step: "clients" } });
    expect(
      toWorkflowRun(testRun({ pinnedSteps: [{ step: "clients", sourceRunId: "wr_first" }] }))
        .pinnedSteps
    ).toEqual([{ step: "clients", sourceRunId: "wr_first" }]);
    expect(toWorkflowRun(testRun({ pinnedSteps: [] })).pinnedSteps).toBeUndefined();
  });

  it("offers Pin, Unpin and the way to the source run by the state of the pin", () => {
    const control = (input: Partial<StepPinControl> = {}): StepPinControl => ({
      fromThisRun: false,
      pinnable: true,
      busy: false,
      pin: noop,
      unpin: noop,
      openRun: noop,
      ...input
    });
    const panel = (options: { pin?: StepPinControl; pinnedFrom?: string; run?: boolean }) => {
      const step = required(placedSteps(draft.steps).get("clients")).step;
      const part = required(workflowGraph(draft.steps, en).nodes.find((n) => n.id === "clients"));
      return renderToStaticMarkup(
        createElement(TranslationProvider, {
          locale: "en",
          children: createElement(StepPanel, {
            step,
            part,
            run:
              options.run === false
                ? undefined
                : {
                    stepRun: toWorkflowStepRun({
                      id: "sr_clients",
                      stepId: "clients",
                      stepType: "operation",
                      status: "done",
                      attempt: 1,
                      createdAt: "2026-10-30T09:00:01.000Z",
                      outputPreview: { text: '{"clients":[]}', truncated: false }
                    }),
                    counts: undefined,
                    now,
                    ...(options.pinnedFrom === undefined
                      ? {}
                      : { pinnedFrom: { runId: options.pinnedFrom, open: noop } })
                  },
            tab: options.run === false ? "what" : "run",
            onTabChange: noop,
            entries: null,
            onClose: noop,
            ...(options.pin === undefined ? {} : { pin: options.pin })
          })
        })
      );
    };
    const has = (markup: string, key: Parameters<typeof en.t>[0]) =>
      markup.includes(`>${en.t(key)}</`);
    const off = panel({ pin: control() });
    expect(off).toContain('data-step-pin="off"');
    expect([has(off, "workflows.pin.button"), has(off, "workflows.pin.unpin")]).toEqual([
      true,
      false
    ]);
    expect(panel({})).not.toContain("data-step-pin");

    const mine = panel({
      pin: control({
        fromThisRun: true,
        pinned: { runId: "wr_second", pinnedAt: "2026-10-30T09:05:00.000Z" }
      })
    });
    expect(mine).toContain('data-step-pin="this-run"');
    expect([has(mine, "workflows.pin.unpin"), has(mine, "workflows.pin.openRun")]).toEqual([
      true,
      false
    ]);

    const elsewhere = { pinned: { runId: "wr_first", pinnedAt: "2026-10-30T08:00:00.000Z" } };
    const other = panel({ pin: control(elsewhere) });
    expect(other).toContain('data-step-pin="other-run"');
    expect(
      (["workflows.pin.instead", "workflows.pin.openRun", "workflows.pin.unpin"] as const).map(
        (key) => has(other, key)
      )
    ).toEqual([true, true, true]);

    // A step the test run took from a pin leads to that run once, and offers no re-pin.
    const same = panel({ pinnedFrom: "wr_first", pin: control(elsewhere) });
    expect(same).toContain('data-pinned-from="wr_first"');
    expect(same.split(`>${en.t("workflows.pin.openRun")}</`)).toHaveLength(2);
    expect(has(same, "workflows.pin.instead")).toBe(false);

    // On the Workflow's page a pinned step offers Unpin, never "instead".
    const page = panel({ run: false, pin: control({ pinnable: false, ...elsewhere }) });
    expect([has(page, "workflows.pin.unpin"), has(page, "workflows.pin.instead")]).toEqual([
      true,
      false
    ]);
  });
});

// ACCEPT-1c C9: a Notify step names who it reaches by the names the reader may read; whoever
// the reader cannot name is counted, and no id of a person or a workspace reaches the screen.
describe("the recipients of a Notify step (ACCEPT-1c C9)", () => {
  const workflow = toWorkflow({
    name: "weekly-reminder",
    config: {
      id: "weekly-reminder",
      name: "Weekly reminder",
      runAs: "runner",
      inputs: OBJECT,
      outputs: OBJECT,
      steps: [
        { id: "start", type: "trigger", name: "Start", triggers: [{ kind: "manual" }] },
        {
          id: "tell",
          type: "notify",
          name: "Tell the team",
          to: { users: ["usr_mara", "usr_unknown"], workspaces: ["ws_finance"] },
          channels: ["inbox", "mail"],
          title: "Upload",
          text: "Upload this week's documents"
        },
        {
          id: "tell-hidden",
          type: "notify",
          name: "Tell others",
          to: { users: ["usr_a", "usr_b"], workspaces: ["ws_hidden"] },
          channels: ["inbox"],
          title: "Hi",
          text: "Hi"
        }
      ]
    },
    publishedRevision: 1
  });
  const names = {
    people: new Map([["usr_mara", "Mara Lindqvist"]]),
    workspaces: new Map([["ws_finance", "Team Finance"]])
  };
  const host: WorkflowsHost = {
    rights: resolveWorkflowRights(undefined, undefined),
    viewerId: "usr_mara",
    workspace: { id: "ws_finance", name: "Team Finance" },
    showRoute: noop,
    recipients: names
  };
  const summary = (id: string, withNames = true) =>
    workflowGraph(workflow.steps, en, undefined, withNames ? names : undefined).nodes.find(
      (node) => node.id === id
    )?.summary;
  const stepPanel = (id: string) => {
    const step = required(workflow.steps.find((entry) => entry.id === id));
    const part = required(
      workflowGraph(workflow.steps, en, undefined, names).nodes.find((node) => node.id === id)
    );
    return createElement(StepPanel, {
      step,
      part,
      run: undefined,
      tab: "what",
      onTabChange: noop,
      entries: null,
      onClose: noop
    });
  };
  const english = (node: ReactNode) =>
    renderToStaticMarkup(createElement(TranslationProvider, { locale: "en", children: node }));

  it("names the recipients the reader may name, counts the rest, and never shows an id", () => {
    expect(summary("tell")).toBe("Mara Lindqvist, Team Finance, and 1 other person");
    expect(summary("tell-hidden")).toBe("2 people and 1 workspace");
    expect(summary("tell", false)).toBe("2 people and 1 workspace");
    for (const id of ["tell", "tell-hidden"]) {
      const html = english(
        createElement(WorkflowsHostProvider, { value: host, children: stepPanel(id) })
      );
      for (const hidden of [
        "usr_mara",
        "usr_unknown",
        "ws_finance",
        "usr_a",
        "usr_b",
        "ws_hidden"
      ]) {
        expect(html).not.toContain(hidden);
      }
    }
  });

  it("reads the instance's people only on one Workflow's or run's page, for a reader who manages people", () => {
    const ws = { collaborationWorkspaceId: "cw_1" };
    expect(readsRecipientPeople({ kind: "workflow", workflow: "w", ...ws }, true)).toBe(true);
    expect(
      readsRecipientPeople({ kind: "workflow-run", workflow: "w", run: "r", ...ws }, true)
    ).toBe(true);
    expect(readsRecipientPeople({ kind: "workflow", workflow: "w", ...ws }, false)).toBe(false);
    for (const route of [
      { kind: "inbox" as const },
      { kind: "settings" as const, group: "instance", page: "users" },
      { kind: "app-edit" as const, app: "a", ...ws },
      { kind: "workflows" as const, ...ws }
    ]) {
      expect(readsRecipientPeople(route, true), route.kind).toBe(false);
    }
  });

  it("uses cached directory names only while the reader may read people", () => {
    const queryClient = new QueryClient();
    const api = {
      apiBaseUrl: "https://chat.example.com",
      authScope: "reader",
      client: createApiClient({ baseUrl: "https://chat.example.com" })
    };
    queryClient.setQueryData(workspaceQueryKeys.superadminUsers(api.apiBaseUrl, api.authScope), [
      { id: "usr_unknown", displayLabel: "Previously readable person" }
    ]);
    const render = (readsPeople: boolean) =>
      english(
        createElement(QueryClientProvider, {
          client: queryClient,
          children: createElement(WorkflowsHostWithRecipients, {
            value: host,
            api,
            viewer: { id: "usr_mara", name: "Mara Lindqvist" },
            workspaces: [{ id: "ws_finance", name: "Team Finance" }],
            readsPeople,
            children: stepPanel("tell")
          })
        })
      );
    expect(render(true)).toContain("Previously readable person");
    expect(render(false)).not.toContain("Previously readable person");
    queryClient.clear();
  });
});

// MAIL-3: a step on `mail.send` names the sender and never the transport; its panel shows the
// mail as sent only to a reader given the step run's input; Settings write `to`, `subject` and
// `body` in the forms `mail.send` takes.
describe("a Send email step (MAIL-3)", () => {
  const mailFact = {
    effect: "changing" as const,
    available: true,
    source: { kind: "mail_sender" as const, title: "Example office", service: "system-mail" },
    mailSender: {
      sender: "system",
      title: "Example office",
      icon: "system-mail",
      address: "office@example.test",
      recipientDomains: ["example.test"]
    }
  };
  const workflow = toWorkflow(
    {
      name: "monthly-check",
      config: {
        id: "monthly-check",
        name: "Monthly check",
        inputs: { type: "object", properties: { month: { type: "string", title: "Month" } } },
        steps: [
          { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
          {
            id: "load",
            name: "Load the bookings",
            type: "operation",
            operation: "x.load",
            input: {}
          },
          {
            id: "send",
            name: "Send the result",
            type: "operation",
            operation: "mail.send",
            input: {
              sender: { value: "system" },
              to: { value: [{ user: "usr_mara" }, { address: "anna@example.test" }] },
              subject: { text: ["Check result ", { ref: { step: "start", path: "input.month" } }] },
              body: { text: ["Good morning,\n\n", { ref: { step: "load", path: "findings" } }] }
            }
          }
        ]
      },
      publishedRevision: 1
    },
    {},
    { stepFacts: { send: mailFact } }
  );
  const names = { people: new Map([["usr_mara", "Mara Lindqvist"]]), workspaces: new Map() };
  const host: WorkflowsHost = {
    rights: { instance: { read: true, write: true, publish: false, delete: false } },
    viewerId: "usr_mara",
    workspace: { id: "ws_finance", name: "Team Finance" },
    showRoute: noop,
    recipients: names,
    brand: { name: "Example office" }
  };
  const sentInput = JSON.stringify({
    sender: "system",
    to: [{ user: "usr_mara" }, { address: "anna@example.test" }],
    cc: ["otto@example.test"],
    subject: "Check result September",
    body: "Good morning,\n\n- Invoice 114 has no receipt"
  });
  const sent = {
    sentAt: "2026-10-12T07:42:01.000Z",
    recipients: { to: 2, cc: 1, bcc: 0 },
    skipped: 0
  };
  const sentOutput = JSON.stringify(sent);
  const mailRun = (input: Partial<StepRunResource>) =>
    stepRun({ id: "sr_send", stepId: "send", ...input });
  const panel = (run: StepRunResource) => {
    const step = required(workflow.steps.find((entry) => entry.id === "send"));
    const part = required(
      workflowGraph(workflow.steps, en, undefined, names).nodes.find((node) => node.id === "send")
    );
    return renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(WorkflowsHostProvider, {
          value: host,
          children: createElement(StepPanel, {
            step,
            part,
            run: { stepRun: toWorkflowStepRun(run), counts: undefined, now: new Date() },
            tab: "run",
            onTabChange: noop,
            entries: null,
            onClose: noop
          })
        })
      })
    );
  };

  it("shows the sender's icon and never the transport's", () => {
    const graph = workflowGraph(workflow.steps, en, undefined, names);
    expect(graph.nodes.find((entry) => entry.id === "send")).toMatchObject({
      icon: "system-mail",
      chip: { label: "Example office", icon: "system-mail", iconFallback: "mail" }
    });
    expect(JSON.stringify(graph)).not.toMatch(/mailjet/iu);
  });

  it("shows the mail as sent only to a reader given the step run's input, and beside a refused send", () => {
    const shown = panel(
      mailRun({
        inputPreview: { text: sentInput, truncated: false },
        outputPreview: { text: sentOutput, truncated: false }
      })
    );
    expect(shown).toContain('data-mail-preview="rendered"');
    expect(shown).toContain("Invoice 114 has no receipt");
    expect(shown).toContain("otto@example.test");
    const hidden = panel(mailRun({ outputPreview: { text: sentOutput, truncated: false } }));
    expect(hidden).toContain('data-mail-no-content=""');
    expect(hidden).not.toContain("Invoice 114");
    const refused = panel(
      mailRun({
        status: "failed",
        inputPreview: { text: sentInput, truncated: false },
        error: { code: "VALIDATION_FAILED", message: "The mail was refused" }
      })
    );
    expect(refused).toContain('data-mail-preview="rendered"');
    // A simulated mail whose rendered body was cut is drawn from the input's text instead.
    const simulated = panel(
      mailRun({
        target: "dry_run",
        inputPreview: { text: sentInput, truncated: false },
        outputPreview: {
          text: JSON.stringify({ simulated: true, preview: { html: "<p>cut", text: "x" } }).slice(
            0,
            40
          ),
          truncated: true
        }
      })
    );
    expect(simulated).toContain('data-mail-preview="simulated"');
    expect(simulated).not.toContain("<iframe");
    expect(simulated).toContain("Invoice 114 has no receipt");
  });

  it("reads a cut input as far as it goes, and a sent or simulated answer", () => {
    const cut = sentInput.slice(0, sentInput.indexOf("Good morning") + 6);
    expect(readCutJson(cut)).toMatchObject({ subject: "Check result September", body: "Good m" });
    expect(mailRunOf({ text: cut, truncated: true })).toMatchObject({
      to: [
        { kind: "user", id: "usr_mara" },
        { kind: "address", address: "anna@example.test" }
      ],
      cc: [{ kind: "address", address: "otto@example.test" }],
      shortened: true
    });
    expect(mailAnswerOf({ text: sentOutput, truncated: false })).toEqual({
      kind: "sent",
      sentAt: "2026-10-12T07:42:01.000Z",
      count: 3,
      test: false,
      skipped: 0
    });
    expect(mailAnswerOf({ text: '{"simulated":true}', truncated: false })).toEqual({
      kind: "simulated"
    });
  });

  it("writes recipients and texts with chips in the forms mail.send takes", () => {
    expect(
      recipientsInput([
        { kind: "person", value: "usr_mara", label: "Mara" },
        { kind: "workspace", value: "ws_finance", label: "Finance" },
        { kind: "address", value: "anna@example.test", label: "anna@example.test" }
      ])
    ).toEqual({
      value: [{ user: "usr_mara" }, { workspace: "ws_finance" }, { address: "anna@example.test" }]
    });
    expect(recipientsInput([{ kind: "picked", value: "load#emails", label: "A" }])).toEqual({
      ref: { step: "load", path: "emails" }
    });
    expect(recipientsInput([])).toBeUndefined();
    const parts = [
      "Check result ",
      { option: "start#input.month" },
      " for ",
      { option: "load#client" }
    ];
    const saved = textInput(parts);
    expect(saved).toEqual({
      text: [
        "Check result ",
        { ref: { step: "start", path: "input.month" } },
        " for ",
        { ref: { step: "load", path: "client" } }
      ]
    });
    const resolve = () => ({ from: { from: "run_input" as const }, field: "x" });
    expect(textParts(saved, resolve)).toEqual(parts);
    expect(textInput(["Hello"])).toEqual({ value: "Hello" });
    expect(textInput([])).toBeUndefined();
    expect(sampleMarkdown([{ invoice: "114", note: "no receipt" }])).toBe(
      "\n| invoice | note |\n| --- | --- |\n| 114 | no receipt |\n"
    );
  });
});
