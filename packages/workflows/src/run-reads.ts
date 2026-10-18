import type {
  ClientInstanceId,
  PlatformStores,
  StorePage,
  WorkflowRunKeyFilter,
  WorkflowStepRunFilter
} from "@work-shape/catalyst-core";
import { datasetReferences } from "./dataset-schema";
import { datasetMetadata, withEveryBodyStep } from "./run-view";
import type { WorkflowDefinitionSource } from "./definition-source";

/** Read projections keep values out of list rows and page step data independently. */
export function createRunReads(options: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  definitions: WorkflowDefinitionSource;
  stepSlots: number;
}) {
  const { clientInstanceId, stores, definitions, stepSlots } = options;
  return {
    async readRun(runId: string) {
      const run = await stores.workflowRuns.readRunView({ clientInstanceId, id: runId });
      if (!run) return undefined;
      const output = await stores.workflowRuns.readRunOutput({ clientInstanceId, id: run.id });
      const rows = await stores.workflowRunDatasets.getMany({
        clientInstanceId,
        ids: output ? datasetReferences(output.value).map((ref) => ref.$dataset) : []
      });
      return { ...run, ...(rows.length ? { datasets: rows.map(datasetMetadata) } : {}) };
    },

    listRuns: ({
      workflow,
      key,
      page
    }: {
      workflow: string;
      key?: WorkflowRunKeyFilter;
      page?: StorePage;
    }) =>
      stores.workflowRuns.listRuns({
        clientInstanceId,
        workflow,
        ...(key ? { key } : {}),
        ...(page ? { page } : {})
      }),

    async listStepRuns({
      runId,
      filter,
      page
    }: {
      runId: string;
      filter?: WorkflowStepRunFilter;
      page?: StorePage;
    }) {
      const run = await stores.workflowRuns.readRun({ clientInstanceId, id: runId });
      if (!run) return [];
      let stepRuns = await stores.workflowRuns.listStepRuns({
        clientInstanceId,
        runId: run.id,
        ...(filter ? { filter } : {}),
        ...(page ? { page } : {})
      });
      const rows = await stores.workflowRunDatasets.listForSteps({
        clientInstanceId,
        stepRunIds: stepRuns.map((step) => step.id)
      });
      stepRuns = stepRuns.map((step) => {
        const datasets = rows.filter((row) => row.stepRunId === step.id).map(datasetMetadata);
        return datasets.length ? { ...step, datasets } : step;
      });
      if (!stepRuns.some((stepRun) => stepRun.bodyCounts)) return stepRuns;
      const definition = await stores.workflowRuns.readRunDefinition({
        clientInstanceId,
        id: run.id
      });
      // What a loop ran with is bounded by the slots of the Workflow, and those of a process.
      const slots = Math.min(stepSlots, run.limits.concurrency?.slots ?? stepSlots);
      // Pruned snapshots cannot reconstruct unreached body steps or concurrency. Return
      // the reached steps and their stored counts; never fall back to a newer definition.
      return definition ? withEveryBodyStep(stepRuns, definition, slots) : stepRuns;
    },

    async listWorkflows(page?: StorePage) {
      const summaries = await definitions.list(page);
      const last = await stores.workflowRuns.listLastRuns({
        clientInstanceId,
        workflows: summaries.map((summary) => summary.id)
      });
      return summaries.map((summary) => {
        const lastRun = last.get(summary.id);
        return { ...summary, kind: summary.kind ?? "process", ...(lastRun ? { lastRun } : {}) };
      });
    }
  };
}
