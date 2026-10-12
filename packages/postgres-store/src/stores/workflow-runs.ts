import type { WorkflowRunDatasetsStore, WorkflowRunsStore } from "@vivd-catalyst/core";
import * as operations from "../postgres-workflow-run-operations";
import type { PostgresConnection } from "../postgres-database";

export function createPostgresWorkflowRunsStore(db: PostgresConnection): WorkflowRunsStore {
  return {
    createRun: (run) => operations.createWorkflowRun(db, run),
    lockRun: (ref) => operations.lockWorkflowRun(db, ref),
    readRun: (input) => operations.readWorkflowRun(db, input),
    listRuns: (input) => operations.listWorkflowRuns(db, input),
    readRunInput: (ref) => operations.readWorkflowRunInput(db, ref),
    markRunRunning: (ref) => operations.markWorkflowRunRunning(db, ref),
    endRun: (ref) => operations.endWorkflowRun(db, ref),
    createStepRun: (stepRun) => operations.createWorkflowStepRun(db, stepRun),
    getStepRun: (ref) => operations.getWorkflowStepRun(db, ref),
    markStepRunRunning: (ref) => operations.markWorkflowStepRunRunning(db, ref),
    endStepRun: (ref) => operations.endWorkflowStepRun(db, ref),
    markLoopWaiting: (ref) => operations.markWorkflowLoopWaiting(db, ref),
    listOpenStepRuns: (ref) => operations.listOpenWorkflowStepRuns(db, ref),
    listStepRuns: (input) => operations.listWorkflowStepRuns(db, input),
    findStepOutput: (input) => operations.findWorkflowStepOutput(db, input),
    countLoopItems: (ref) => operations.countWorkflowLoopItems(db, ref),
    readLoopItem: (ref) => operations.readWorkflowLoopItem(db, ref),
    measureLoopResults: (ref) => operations.measureWorkflowLoopResults(db, ref),
    listLoopResults: (ref) => operations.listWorkflowLoopResults(db, ref)
  };
}

/** The datasets of Workflow Runs. It holds nothing until the slice that brings datasets. */
export function createPostgresWorkflowRunDatasetsStore(
  _db: PostgresConnection
): WorkflowRunDatasetsStore {
  return {};
}
