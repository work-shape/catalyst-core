import type { WorkflowRunsStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";

/** The runs and step runs of Workflows. It holds nothing until the engine has its tables. */
export function createPostgresWorkflowRunsStore(_db: PostgresConnection): WorkflowRunsStore {
  return {};
}
