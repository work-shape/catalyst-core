import type { WorkflowRunDatasetsStore, WorkflowRunsStore } from "@vivd-catalyst/core";
import * as operations from "../postgres-workflow-run-operations";
import type { PostgresConnection } from "../postgres-database";

export function createPostgresWorkflowRunsStore(db: PostgresConnection): WorkflowRunsStore {
  return {
    createRun: (run) => operations.createWorkflowRun(db, run),
    readScheduleState: (input) => operations.readWorkflowScheduleState(db, input),
    countLoopItemsStarted: (ref) => operations.countWorkflowLoopItemsStarted(db, ref),
    stageCodeStep: (ref) => operations.stageWorkflowCodeStep(db, ref),
    readStagedCode: (ref) => operations.readWorkflowStagedCode(db, ref),
    recordCodeOutcome: (ref) => operations.recordWorkflowCodeOutcome(db, ref),
    readCodeOutcome: (ref) => operations.readWorkflowCodeOutcome(db, ref),
    lockRun: (ref) => operations.lockWorkflowRun(db, ref),
    readRun: (input) => operations.readWorkflowRun(db, input),
    listRuns: (input) => operations.listWorkflowRuns(db, input),
    listLastRuns: (input) => operations.listLastWorkflowRuns(db, input),
    readRunInput: (ref) => operations.readWorkflowRunInput(db, ref),
    readRunDefinition: (input) => operations.readWorkflowRunDefinition(db, input),
    markRunRunning: (ref) => operations.markWorkflowRunRunning(db, ref),
    endRun: (ref) => operations.endWorkflowRun(db, ref),
    createStepRun: (stepRun) => operations.createWorkflowStepRun(db, stepRun),
    getStepRun: (ref) => operations.getWorkflowStepRun(db, ref),
    markStepRunRunning: (ref) => operations.markWorkflowStepRunRunning(db, ref),
    endStepRun: (ref) => operations.endWorkflowStepRun(db, ref),
    markLoopWaiting: (ref) => operations.markWorkflowLoopWaiting(db, ref),
    noteStepRunOperation: (ref) => operations.noteWorkflowStepRunOperation(db, ref),
    listOpenStepRuns: (ref) => operations.listOpenWorkflowStepRuns(db, ref),
    listStepRuns: (input) => operations.listWorkflowStepRuns(db, input),
    findStepOutput: (input) => operations.findWorkflowStepOutput(db, input),
    countLoopItems: (ref) => operations.countWorkflowLoopItems(db, ref),
    readLoopItem: (ref) => operations.readWorkflowLoopItem(db, ref),
    readLoopCounts: (ref) => operations.readWorkflowLoopCounts(db, ref)
  };
}

/** The datasets of Workflow Runs. It holds nothing until the slice that brings datasets. */
export function createPostgresWorkflowRunDatasetsStore(
  _db: PostgresConnection
): WorkflowRunDatasetsStore {
  return {};
}
