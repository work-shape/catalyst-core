import type { WorkflowDatasetState } from "@work-shape/catalyst-asset-schemas";
import type { ClientInstanceId, WorkflowRunId, WorkflowStepRunId } from "./ids";
import type { JsonObject } from "./json";

/** Operator ceilings; a Workflow may lower them. Bytes count uncompressed JSON Lines. */
export interface WorkflowDatasetLimits {
  rows: number;
  bytes: number;
  rowBytes: number;
  runBytes: number;
  instanceBytes: number;
  pageBytes?: number;
  pages?: number;
}

export interface WorkflowDatasetPart {
  key: string;
  rows: number;
  bytes: number;
  hash: string;
  /** Position after this complete page. Stored atomically with the part. */
  checkpoint?: JsonObject;
}

export interface WorkflowRunDataset {
  id: string;
  clientInstanceId: ClientInstanceId;
  runId: WorkflowRunId;
  stepRunId: WorkflowStepRunId;
  field: string;
  rowSchema: JsonObject;
  rowCount: number;
  bytes: number;
  parts: WorkflowDatasetPart[];
  pendingPart?: WorkflowDatasetPart;
  state: WorkflowDatasetState;
  expiresAt?: string;
  deletedAt?: string;
  cleanedAt?: string;
}

export interface WorkflowDatasetRef {
  clientInstanceId: ClientInstanceId;
  id: string;
}

/** Transaction-bound methods share the step/run end's transaction. No customer rows here. */
export interface WorkflowRunDatasetsStore {
  create(
    input: Pick<
      WorkflowRunDataset,
      "id" | "clientInstanceId" | "runId" | "stepRunId" | "field" | "rowSchema"
    >
  ): Promise<WorkflowRunDataset>;
  listForSteps(input: {
    clientInstanceId: ClientInstanceId;
    stepRunIds: WorkflowStepRunId[];
  }): Promise<WorkflowRunDataset[]>;
  getMany(input: {
    clientInstanceId: ClientInstanceId;
    ids: string[];
  }): Promise<WorkflowRunDataset[]>;
  lock(ref: WorkflowDatasetRef): Promise<WorkflowRunDataset | undefined>;
  get(ref: WorkflowDatasetRef): Promise<WorkflowRunDataset | undefined>;
  listForRun(input: {
    clientInstanceId: ClientInstanceId;
    runId: WorkflowRunId;
    after?: string;
    limit: number;
  }): Promise<WorkflowRunDataset[]>;
  /**
   * Reserves before uploading. Page checkpoints may replace an uncommitted reservation;
   * other writers must replay the same part. Replacement adjusts the reserved bytes once.
   */
  reservePart(
    input: WorkflowDatasetRef & {
      index: number;
      part: WorkflowDatasetPart;
      limits: WorkflowDatasetLimits;
    }
  ): Promise<void>;
  commitPart(input: WorkflowDatasetRef & { index: number }): Promise<void>;
  completeStep(input: {
    clientInstanceId: ClientInstanceId;
    stepRunId: WorkflowStepRunId;
  }): Promise<WorkflowRunDataset[]>;
  allowRun(input: WorkflowDatasetRef & { runId: WorkflowRunId }): Promise<void>;
  canRead(input: WorkflowDatasetRef & { runId: WorkflowRunId }): Promise<boolean>;
  /** A hold lasts while its reader is open, or until the reader's recorded expiry. */
  finishRun(input: {
    clientInstanceId: ClientInstanceId;
    runId: WorkflowRunId;
    keep: string[];
    expiresAt: string;
    resume: boolean;
    test: boolean;
  }): Promise<void>;
  claimExpired(input: {
    clientInstanceId: ClientInstanceId;
    now: string;
    limit: number;
  }): Promise<WorkflowRunDataset[]>;
  claimRun(input: { clientInstanceId: ClientInstanceId; runId: WorkflowRunId }): Promise<void>;
  claimWorkflow(input: { clientInstanceId: ClientInstanceId; workflow: string }): Promise<void>;
  markCleaned(ref: WorkflowDatasetRef & { at: string }): Promise<void>;
}

/** Defaults for operator paging ceilings, shared by release parsing and the engine. */
export const WORKFLOW_PAGING_DEFAULTS = {
  pageBytes: 8 * 1024 ** 2,
  pages: 10_000,
  pagedStepMinutes: 60
};
