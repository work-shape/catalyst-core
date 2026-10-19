import { ApiError, type LocaleCode } from "@work-shape/catalyst-api-client";
import { startFormOf } from "../start-form";
import { toWorkflow, toWorkflowRun, toWorkflowStepRun } from "../workflow-mapping";
import type { WorkflowRunsSource, WorkflowsSource } from "../source-shapes";
import {
  SAMPLE_PRINCIPAL,
  SAMPLE_REVISION,
  SAMPLE_VIEWER_ID,
  sampleEntryStepRuns,
  sampleRuns,
  type SampleRun
} from "./sample-runs";
import { sampleWorkflows, type SampleWorkflow } from "./sample-workflows";

// A source of Workflows and runs that reads the samples and keeps what a reader starts or
// cancels in memory. It answers through the mapping the instance's source uses, so the samples
// page shows what a screen makes of the contract's shapes.

function missing(what: string): ApiError {
  return new ApiError(404, `${what} was not found.`, { code: "NOT_FOUND" });
}

/** The definition as the read answers it: the file, and on a step what the read says of it. */
function withReadings(sample: SampleWorkflow) {
  const read = (steps: readonly unknown[]): unknown[] =>
    steps.map((step) => {
      if (typeof step !== "object" || step === null) {
        return step;
      }
      const record: Record<string, unknown> = { ...step };
      const id = typeof record.id === "string" ? record.id : "";
      for (const list of ["steps", "then", "else"]) {
        const nested = record[list];
        if (Array.isArray(nested)) {
          record[list] = read(nested);
        }
      }
      if (Array.isArray(record.branches)) {
        record.branches = record.branches.map((branch: unknown) =>
          typeof branch === "object" &&
          branch !== null &&
          "steps" in branch &&
          Array.isArray(branch.steps)
            ? { ...branch, steps: read(branch.steps) }
            : branch
        );
      }
      return { ...record, ...sample.readings[id] };
    });
  return { ...sample.manifest, steps: read(sample.manifest.steps) };
}

/** The samples as a source, in one language. `now` is the moment the sample runs count from. */
export function createSampleSource(
  locale: LocaleCode,
  /** The reader holds the right to start the samples. Off for the view of one who only reads. */
  mayStart = true,
  now = Date.now()
): WorkflowsSource {
  const workflows = sampleWorkflows(locale);
  const held: SampleRun[] = [...sampleRuns(now)];
  let started = 0;

  const find = (runId: string): SampleRun => {
    const sample = held.find((entry) => entry.run.id === runId);
    if (sample === undefined) {
      throw missing("The run");
    }
    return sample;
  };
  const lastRun = (workflow: string) => held.find((entry) => entry.run.workflow === workflow)?.run;

  const runs: WorkflowRunsSource = {
    listRuns: (workflow, query) => {
      const { keyPrefix } = query;
      const rows = held.filter(
        (entry) =>
          entry.run.workflow === workflow &&
          (keyPrefix === undefined || (entry.run.runKey?.startsWith(keyPrefix) ?? false))
      );
      const from = query.cursor === undefined ? 0 : Number(query.cursor);
      const next = from + query.limit;
      return Promise.resolve({
        items: rows.slice(from, next).map((entry) => toWorkflowRun(entry.run)),
        nextCursor: next < rows.length ? String(next) : undefined
      });
    },
    getRun: async (runId) => Promise.resolve(toWorkflowRun(find(runId).run)),
    listFrameStepRuns: async (runId) =>
      Promise.resolve({
        stepRuns: find(runId).frame.map(toWorkflowStepRun),
        entryLoops: [],
        nextCursor: undefined
      }),
    listEntryStepRuns: async (runId, query) => {
      const page = sampleEntryStepRuns(find(runId), query.containerStepRunId, query);
      return Promise.resolve({
        items: page.items.map(toWorkflowStepRun),
        nextCursor: page.nextCursor
      });
    },
    start: async (workflow) => {
      started += 1;
      const id = `run-started-${String(started)}`;
      const at = new Date().toISOString();
      const sample: SampleRun = {
        run: {
          id,
          workflow,
          trigger: "manual",
          startedBy: { id: SAMPLE_VIEWER_ID, label: "Dana Weber" },
          principal: SAMPLE_PRINCIPAL,
          status: "running",
          rootRunId: id,
          depth: 0,
          createdAt: at,
          startedAt: at
        },
        frame: [
          {
            id: `${id}:start`,
            stepId: "start",
            stepType: "trigger",
            attempt: 1,
            status: "done",
            createdAt: at,
            startedAt: at,
            finishedAt: at
          }
        ],
        loops: {}
      };
      held.unshift(sample);
      return Promise.resolve(toWorkflowRun(sample.run));
    },
    cancel: async (runId) => {
      const sample = find(runId);
      const at = new Date().toISOString();
      const cancelled: SampleRun = {
        ...sample,
        run: { ...sample.run, status: "cancelled", finishedAt: at },
        frame: sample.frame.map((stepRun) =>
          stepRun.status === "running" ||
          stepRun.status === "waiting" ||
          stepRun.status === "queued"
            ? { ...stepRun, status: "cancelled", finishedAt: at }
            : stepRun
        )
      };
      held.splice(held.indexOf(sample), 1, cancelled);
      return Promise.resolve(toWorkflowRun(cancelled.run));
    }
  };

  return {
    key: `samples:${locale}`,
    listWorkflows: async () =>
      Promise.resolve({
        items: workflows.map(({ manifest }) => {
          const last = lastRun(manifest.id);
          return {
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            published: true,
            kind: "process" as const,
            startsByHand: true,
            refusedFor: [],
            mayStart,
            startForm: startFormOf(manifest.inputs),
            updatedAt: new Date(now - 86_400_000).toISOString(),
            ...(last === undefined
              ? {}
              : {
                  lastRun: {
                    id: last.id,
                    status: last.status,
                    ...(last.startedAt === undefined ? {} : { startedAt: last.startedAt }),
                    failedDescendantCount: 0,
                    failedItemCount: 0
                  }
                })
          };
        }),
        nextCursor: undefined
      }),
    getWorkflow: async (_workspaceId, workflow) => {
      const sample = workflows.find((entry) => entry.manifest.id === workflow);
      if (sample === undefined) {
        throw missing("The Workflow");
      }
      return Promise.resolve(
        toWorkflow(
          { name: sample.manifest.id, config: withReadings(sample), publishedRevision: 2 },
          {
            revisionId: SAMPLE_REVISION,
            mayStart,
            startForm: startFormOf(sample.manifest.inputs),
            runsAs: SAMPLE_PRINCIPAL.displayLabel
          }
        )
      );
    },
    runs
  };
}
