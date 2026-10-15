import type { WorkflowLoopCounts } from "@work-shape/catalyst-core";
import type { WorkflowRunResource, WorkflowStepRunResource } from "../workflow-mapping";

// Sample runs in the shape of the run view of the contract: one per state a run page shows.
// A loop over 600 clients is its counts; the step runs of its items are made when a reader
// asks for a page of them.

const MINUTE = 60_000;

const VIEWER = { id: "sample-viewer", label: "Dana Weber" };
const SCHEDULE = { id: "workflow-runner", label: "workflow-runner" };

/** The person the samples page looks through. */
export const SAMPLE_VIEWER_ID = VIEWER.id;

export interface SampleRun {
  run: WorkflowRunResource;
  /** The step runs outside every item of a loop. */
  frame: readonly WorkflowStepRunResource[];
  /** The loops of the run whose items can be listed, by the id of the loop's step run. */
  loops: Readonly<Record<string, SampleLoop>>;
}

interface SampleLoop {
  counts: WorkflowLoopCounts;
  /** The steps of the loop, in their order. */
  steps: readonly { id: string; type: string }[];
}

const CLIENTS = [
  "Aurich & Sohn GmbH",
  "Bäckerei Thomsen",
  "Clausen Immobilien KG",
  "Dreyer Logistik GmbH",
  "Elbwerk Studios",
  "Friesen Bau AG",
  "Gartencenter Holm",
  "Hansa Dental MVZ",
  "Ihlow Metallbau",
  "Jacobsen Yachtservice"
];

/** The name of the client at a place of the list. */
function sampleClient(index: number): string {
  const name = CLIENTS[index % CLIENTS.length] ?? "Client";
  return index < CLIENTS.length
    ? name
    : `${name} ${String(Math.floor(index / CLIENTS.length) + 1)}`;
}

const LOOP_STEPS = [
  { id: "bookings", type: "operation" },
  { id: "check", type: "code" },
  { id: "save", type: "operation" }
];

/** Which items of a loop failed: spread over the ones that are through. */
function failedItems(counts: WorkflowLoopCounts): readonly number[] {
  const through = counts.done + counts.failed;
  return Array.from({ length: counts.failed }, (_, place) =>
    Math.floor(((place + 1) * through) / (counts.failed + 1))
  );
}

interface Clock {
  /** An ISO time so many minutes before the samples were built. */
  ago(minutes: number): string;
}

function stepRun(
  runId: string,
  stepId: string,
  stepType: string,
  rest: Partial<WorkflowStepRunResource> & Pick<WorkflowStepRunResource, "status" | "createdAt">
): WorkflowStepRunResource {
  return { id: `${runId}:${stepId}`, stepId, stepType, attempt: 1, ...rest };
}

/** The revision of every sample Workflow that is published now. */
export const SAMPLE_REVISION = "revision-2";

function monthly(
  id: string,
  rest: Partial<WorkflowRunResource> & Pick<WorkflowRunResource, "status" | "createdAt">
): WorkflowRunResource {
  return {
    id,
    workflow: "monthly-booking-check",
    trigger: "schedule",
    startedBy: SCHEDULE,
    rootRunId: id,
    depth: 0,
    definitionRevisionId: SAMPLE_REVISION,
    ...rest
  };
}

const READS = { effect: "reading" as const, source: "Bookings" };

function running(clock: Clock): SampleRun {
  const id = "run-running";
  const counts = { total: 600, done: 209, failed: 3, running: 8 };
  return {
    run: monthly(id, { status: "running", createdAt: clock.ago(4), startedAt: clock.ago(4) }),
    frame: [
      stepRun(id, "start", "trigger", {
        status: "done",
        createdAt: clock.ago(4),
        startedAt: clock.ago(4),
        finishedAt: clock.ago(4)
      }),
      stepRun(id, "clients", "operation", {
        status: "done",
        createdAt: clock.ago(4),
        startedAt: clock.ago(4),
        finishedAt: clock.ago(3.9),
        ...READS,
        outputPreview: {
          text: '{\n  "items": [\n    { "number": "10001", "name": "Aurich & Sohn GmbH" },\n    { "number": "10002", "name": "Bäckerei Thomsen" }',
          truncated: true
        }
      }),
      stepRun(id, "each_client", "loop", {
        status: "running",
        createdAt: clock.ago(3.9),
        startedAt: clock.ago(3.9),
        loop: counts,
        bodyCounts: {
          bookings: { total: 600, done: 218, failed: 1, running: 2 },
          check: { total: 600, done: 214, failed: 0, running: 4 },
          save: { total: 600, done: 209, failed: 2, running: 2 }
        }
      })
    ],
    loops: { [`${id}:each_client`]: { counts, steps: LOOP_STEPS } }
  };
}

function failed(clock: Clock): SampleRun {
  const id = "run-failed";
  const error = {
    code: "FORBIDDEN",
    message: "workflow-runner may not call connection.bookings.list_clients.",
    action: "connection.use"
  };
  return {
    run: monthly(id, {
      status: "failed",
      createdAt: clock.ago(62),
      startedAt: clock.ago(62),
      finishedAt: clock.ago(61.9),
      error
    }),
    frame: [
      stepRun(id, "start", "trigger", {
        status: "done",
        createdAt: clock.ago(62),
        startedAt: clock.ago(62),
        finishedAt: clock.ago(62)
      }),
      stepRun(id, "clients", "operation", {
        status: "failed",
        createdAt: clock.ago(62),
        startedAt: clock.ago(62),
        finishedAt: clock.ago(61.9),
        ...READS,
        error
      })
    ],
    loops: {}
  };
}

/** The start of a list of 600 clients, cut where a preview ends: in the middle of a record. */
const CLIENTS_PREVIEW = {
  text:
    '{"items":[' +
    [
      ["10432", "Nordlicht GmbH", 2019],
      ["10433", "Bäckerei Thomsen", 2021],
      ["10436", "Brandt & Partner", 2016],
      ["10441", "Elbwerk Studios UG", 2023],
      ["10977", "Weber & Söhne KG", 2012],
      ["11003", "Hafenkontor AG", 2018]
    ]
      .map(
        ([number, name, since]) => `{"number":"${number}","name":"${name}","client_since":${since}}`
      )
      .join(",") +
    ',{"number":"11004","na',
  truncated: true
};

function done(clock: Clock): SampleRun {
  const id = "run-done";
  const counts = { total: 600, done: 597, failed: 3, running: 0 };
  const result = {
    text: '{\n  "summary": "597 of 600 clients checked. 41 findings in 28 clients."\n}',
    truncated: false
  };
  return {
    run: monthly(id, {
      status: "done",
      trigger: "manual",
      startedBy: VIEWER,
      createdAt: clock.ago(1500),
      startedAt: clock.ago(1500),
      finishedAt: clock.ago(1488),
      outputPreview: result
    }),
    frame: [
      stepRun(id, "start", "trigger", {
        status: "done",
        createdAt: clock.ago(1500),
        startedAt: clock.ago(1500),
        finishedAt: clock.ago(1500)
      }),
      stepRun(id, "clients", "operation", {
        status: "done",
        createdAt: clock.ago(1500),
        startedAt: clock.ago(1500),
        finishedAt: clock.ago(1499.9),
        ...READS,
        outputPreview: CLIENTS_PREVIEW
      }),
      stepRun(id, "each_client", "loop", {
        status: "done",
        createdAt: clock.ago(1499.9),
        startedAt: clock.ago(1499.9),
        finishedAt: clock.ago(1489),
        loop: counts,
        bodyCounts: {
          bookings: { total: 600, done: 599, failed: 1, running: 0 },
          check: { total: 600, done: 599, failed: 0, running: 0 },
          save: { total: 600, done: 597, failed: 2, running: 0 }
        }
      }),
      stepRun(id, "summary", "agent", {
        status: "done",
        createdAt: clock.ago(1489),
        startedAt: clock.ago(1489),
        finishedAt: clock.ago(1488.2)
      }),
      stepRun(id, "result", "output", {
        status: "done",
        createdAt: clock.ago(1488.2),
        startedAt: clock.ago(1488.2),
        finishedAt: clock.ago(1488),
        outputPreview: result
      })
    ],
    loops: { [`${id}:each_client`]: { counts, steps: LOOP_STEPS } }
  };
}

/** A run that stopped after its first steps, in the state given. */
function stopped(
  clock: Clock,
  id: string,
  minutes: number,
  status: "queued" | "waiting" | "cancelled" | "limit_reached"
): SampleRun {
  const begun = status !== "queued";
  const ended = status === "cancelled" || status === "limit_reached";
  const counts = { total: 600, done: 96, failed: 0, running: 0 };
  return {
    run: monthly(id, {
      status,
      // The run that hit its limit started before the Workflow was last published.
      ...(status === "limit_reached" ? { definitionRevisionId: "revision-1" } : {}),
      createdAt: clock.ago(minutes),
      ...(begun ? { startedAt: clock.ago(minutes) } : {}),
      ...(ended ? { finishedAt: clock.ago(minutes - 2) } : {}),
      ...(status === "limit_reached"
        ? { error: { code: "duration_limit", message: "The run reached its duration limit." } }
        : {})
    }),
    frame: !begun
      ? []
      : [
          stepRun(id, "start", "trigger", {
            status: "done",
            createdAt: clock.ago(minutes),
            startedAt: clock.ago(minutes),
            finishedAt: clock.ago(minutes)
          }),
          ...(status === "waiting"
            ? [
                stepRun(id, "clients", "operation", {
                  status: "waiting" as const,
                  createdAt: clock.ago(minutes),
                  startedAt: clock.ago(minutes),
                  ...READS
                })
              ]
            : [
                stepRun(id, "clients", "operation", {
                  status: "done" as const,
                  createdAt: clock.ago(minutes),
                  startedAt: clock.ago(minutes),
                  finishedAt: clock.ago(minutes - 0.1),
                  ...READS
                }),
                stepRun(id, "each_client", "loop", {
                  status: "cancelled" as const,
                  createdAt: clock.ago(minutes - 0.1),
                  startedAt: clock.ago(minutes - 0.1),
                  finishedAt: clock.ago(minutes - 2),
                  loop: counts,
                  bodyCounts: {
                    bookings: { total: 600, done: 96, failed: 0, running: 0 },
                    check: { total: 600, done: 96, failed: 0, running: 0 },
                    save: { total: 600, done: 96, failed: 0, running: 0 }
                  }
                })
              ])
        ],
    loops: ended ? { [`${id}:each_client`]: { counts, steps: LOOP_STEPS } } : {}
  };
}

/** A run of "Quarter close": every structure with a state, and a child run at work. */
function quarter(clock: Clock): readonly SampleRun[] {
  const id = "run-quarter";
  const childId = "run-reminders";
  const counts = { total: 2400, done: 2388, failed: 12, running: 0 };
  const inBlock = { containerStepRunId: `${id}:at_once` };
  return [
    {
      run: {
        id,
        workflow: "quarter-close",
        trigger: "schedule",
        startedBy: SCHEDULE,
        status: "running",
        rootRunId: id,
        depth: 0,
        createdAt: clock.ago(38),
        startedAt: clock.ago(38)
      },
      frame: [
        stepRun(id, "start", "trigger", {
          status: "done",
          createdAt: clock.ago(38),
          startedAt: clock.ago(38),
          finishedAt: clock.ago(38)
        }),
        stepRun(id, "clients", "operation", {
          status: "done",
          createdAt: clock.ago(38),
          startedAt: clock.ago(38),
          finishedAt: clock.ago(37.9),
          ...READS
        }),
        stepRun(id, "each_client", "loop", {
          status: "done",
          createdAt: clock.ago(37.9),
          startedAt: clock.ago(37.9),
          finishedAt: clock.ago(3),
          loop: counts,
          bodyCounts: {
            bookings: { total: 2400, done: 2395, failed: 5, running: 0 },
            check: { total: 2400, done: 2395, failed: 0, running: 0 },
            save: { total: 2400, done: 2388, failed: 7, running: 0 }
          }
        }),
        stepRun(id, "any_findings", "condition", {
          status: "done",
          createdAt: clock.ago(3),
          startedAt: clock.ago(3),
          finishedAt: clock.ago(3),
          taken: "then"
        }),
        stepRun(id, "at_once", "parallel", {
          status: "running",
          createdAt: clock.ago(3),
          startedAt: clock.ago(3),
          containerStepRunId: `${id}:any_findings`,
          branch: "then"
        }),
        stepRun(id, "tell_team", "notify", {
          status: "done",
          createdAt: clock.ago(3),
          startedAt: clock.ago(3),
          finishedAt: clock.ago(2.9),
          ...inBlock,
          branch: "team"
        }),
        stepRun(id, "remind", "workflow", {
          status: "running",
          createdAt: clock.ago(3),
          startedAt: clock.ago(3),
          ...inBlock,
          branch: "clients",
          childRunId: childId
        })
      ],
      loops: { [`${id}:each_client`]: { counts, steps: LOOP_STEPS } }
    },
    {
      run: {
        id: childId,
        workflow: "send-reminders",
        trigger: "parent",
        startedBy: SCHEDULE,
        status: "running",
        parentRunId: id,
        parentStepRunId: `${id}:remind`,
        parentWorkflow: "quarter-close",
        rootRunId: id,
        depth: 1,
        createdAt: clock.ago(3),
        startedAt: clock.ago(3)
      },
      frame: [
        stepRun(childId, "start", "trigger", {
          status: "done",
          createdAt: clock.ago(3),
          startedAt: clock.ago(3),
          finishedAt: clock.ago(3)
        }),
        stepRun(childId, "open_findings", "operation", {
          status: "done",
          createdAt: clock.ago(3),
          startedAt: clock.ago(3),
          finishedAt: clock.ago(2.8),
          effect: "reading",
          source: "Findings"
        }),
        stepRun(childId, "mail", "notify", {
          status: "running",
          createdAt: clock.ago(2.8),
          startedAt: clock.ago(2.8)
        })
      ],
      loops: {}
    }
  ];
}

/** The sample runs, newest first within each Workflow. */
export function sampleRuns(now: number): readonly SampleRun[] {
  const clock: Clock = { ago: (minutes) => new Date(now - minutes * MINUTE).toISOString() };
  return [
    running(clock),
    stopped(clock, "run-queued", 1, "queued"),
    stopped(clock, "run-waiting", 26, "waiting"),
    failed(clock),
    stopped(clock, "run-cancelled", 300, "cancelled"),
    stopped(clock, "run-limit", 900, "limit_reached"),
    done(clock),
    ...quarter(clock)
  ];
}

const ITEM_ERROR = {
  code: "operation_input_invalid",
  message: "The booking period of the client is not closed."
};

/**
 * The step runs of the items of a loop in one state, a page at a time. An item that is
 * through has a step run per step of the loop; a failed one ends at the step it failed at.
 */
export function sampleEntryStepRuns(
  sample: SampleRun,
  containerStepRunId: string,
  query: {
    status: WorkflowStepRunResource["status"] | undefined;
    limit: number;
    cursor: string | undefined;
  }
): { items: WorkflowStepRunResource[]; nextCursor: string | undefined } {
  const loop = sample.loops[containerStepRunId];
  if (loop === undefined) {
    return { items: [], nextCursor: undefined };
  }
  const through = loop.counts.done + loop.counts.failed;
  const failures = new Set(failedItems(loop.counts));
  const indexes =
    query.status === "failed"
      ? [...failures]
      : query.status === "running"
        ? Array.from({ length: loop.counts.running }, (_, place) => through + place)
        : query.status === undefined
          ? Array.from({ length: through + loop.counts.running }, (_, index) => index)
          : [];
  const from = query.cursor === undefined ? 0 : Number(query.cursor);
  const page = indexes.slice(from, from + query.limit);
  const next = from + query.limit;
  const at = sample.run.startedAt ?? sample.run.createdAt;
  const firstFailure = failedItems(loop.counts)[0];
  const items = page.flatMap((index) => {
    const iteration = { index, label: sampleClient(index) };
    const state = failures.has(index) ? "failed" : index >= through ? "running" : "done";
    // The first failed item fails at its first step, every other one at its last.
    const steps =
      state === "done" || (state === "failed" && index !== firstFailure)
        ? loop.steps
        : loop.steps.slice(0, state === "failed" ? 1 : 2);
    return steps
      .map((step, place): WorkflowStepRunResource => {
        const last = place === steps.length - 1;
        const status = last && state !== "done" ? state : "done";
        return {
          id: `${containerStepRunId}:${String(index)}:${step.id}`,
          stepId: step.id,
          stepType: step.type,
          attempt: 1,
          status,
          containerStepRunId,
          iteration,
          createdAt: at,
          startedAt: at,
          ...(status === "running" ? {} : { finishedAt: at }),
          ...(status === "failed" ? { error: ITEM_ERROR } : {})
        };
      })
      .filter((row) => query.status === undefined || row.status === query.status);
  });
  return { items, nextCursor: next < indexes.length ? String(next) : undefined };
}
