import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";
import type { JsonObject } from "../json";

const WORKFLOW_DATASET_AUDIT = {
  subject: "workflow_run",
  legacy: false,
  audited: true,
  phases: ["after"] as const,
  payload: {
    type: "object",
    additionalProperties: false,
    required: ["runId", "stepRunId", "datasetId", "rowCount", "bytes"],
    properties: {
      runId: { type: "string" },
      stepRunId: { type: "string" },
      datasetId: { type: "string" },
      rowCount: { type: "integer", minimum: 0 },
      bytes: { type: "integer", minimum: 0 },
      pages: { type: "integer", minimum: 0 },
      table: { type: "string" }
    }
  } satisfies JsonObject
};

const WORKFLOW_DATASET_EVENTS = {
  "workflow_run.dataset_downloaded": {
    ...WORKFLOW_DATASET_AUDIT,
    name: "workflow_run.dataset_downloaded"
  },
  "workflow_run.dataset_loaded": {
    ...WORKFLOW_DATASET_AUDIT,
    name: "workflow_run.dataset_loaded",
    payload: {
      ...WORKFLOW_DATASET_AUDIT.payload,
      properties: {
        ...WORKFLOW_DATASET_AUDIT.payload.properties,
        inserted: { type: "integer", minimum: 0 },
        updated: { type: "integer", minimum: 0 },
        skipped: { type: "integer", minimum: 0 },
        deleted: { type: "integer", minimum: 0 }
      }
    }
  },
  "workflow_run.dataset_created": {
    ...WORKFLOW_DATASET_AUDIT,
    name: "workflow_run.dataset_created",
    subject: "workflow_run"
  },
  "workflow_run.dataset_deleted": {
    ...WORKFLOW_DATASET_AUDIT,
    name: "workflow_run.dataset_deleted",
    subject: "workflow_run"
  }
};

export const workflowRunEvents = {
  ...WORKFLOW_DATASET_EVENTS,
  "workflow_run.cancelled": {
    ...LEGACY_AUDIT,
    name: "workflow_run.cancelled",
    subject: "workflow_run"
  },
  "workflow_run.ended": { ...LEGACY_AUDIT, name: "workflow_run.ended", subject: "workflow_run" },
  "workflow_run.started": {
    ...LEGACY_AUDIT,
    name: "workflow_run.started",
    subject: "workflow_run"
  },
  // A due time of a schedule that started no run. The subject is the Workflow.
  "workflow_run.tick_skipped": {
    ...LEGACY_AUDIT,
    name: "workflow_run.tick_skipped",
    subject: "workflow"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
