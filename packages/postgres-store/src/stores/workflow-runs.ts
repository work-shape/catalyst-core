import type { WorkflowRunDatasetsStore, WorkflowRunsStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";

/** The runs and step runs of Workflows. It holds nothing until the engine has its tables. */
export function createPostgresWorkflowRunsStore(_db: PostgresConnection): WorkflowRunsStore {
  return {};
}

/** The datasets of Workflow Runs. It holds nothing until the slice that brings datasets. */
export function createPostgresWorkflowRunDatasetsStore(
  _db: PostgresConnection
): WorkflowRunDatasetsStore {
  return {};
}
