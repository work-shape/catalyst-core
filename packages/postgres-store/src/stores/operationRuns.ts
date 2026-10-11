import type { OperationRunStore } from "@vivd-catalyst/core";
import * as operations from "../postgres-operation-run-operations";
import type { PostgresConnection } from "../postgres-database";

export function createPostgresOperationRunsStore(db: PostgresConnection): OperationRunStore {
  return {
    create: (run) => operations.createOperationRun(db, run),
    recordEnded: (run) => operations.recordEndedOperationRun(db, run),
    finish: (input) => operations.finishOperationRun(db, input),
    findByIdempotencyKey: (input) => operations.findOperationRunByIdempotencyKey(db, input),
    get: (input) => operations.getOperationRun(db, input),
    list: (input) => operations.listOperationRuns(db, input),
    resume: (input) => operations.resumeOperationRun(db, input),
    endWaiting: (input) => operations.endWaitingOperationRun(db, input),
    markExpired: (input) => operations.markOperationRunsExpired(db, input),
    listRunningSince: (input) => operations.listOperationRunsRunningSince(db, input),
    deleteOfConversations: (input) => operations.deleteOperationRunsOfConversations(db, input),
    deleteWithoutConversationOlderThan: (input) =>
      operations.deleteOperationRunsWithoutConversationOlderThan(db, input),
    markInterrupted: (input) => operations.markOperationRunInterrupted(db, input)
  };
}
