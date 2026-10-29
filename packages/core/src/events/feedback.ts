import type { PlatformEventDefinition } from "./definition";
import type { JsonObject } from "../json";

// The ids a feedback event carries: the comment, what it is about (the agent of an answer, the
// App, or the Workflow and its run) and the workspace it was sent in.
const FEEDBACK_IDS_PAYLOAD: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["feedbackId", "subjectKind"],
  properties: {
    feedbackId: { type: "string" },
    subjectKind: { type: "string", enum: ["message", "app", "workflow_run"] },
    agentName: { type: "string" },
    agentAssetId: { type: "string" },
    appName: { type: "string" },
    workflowName: { type: "string" },
    workflowRunId: { type: "string" },
    assetId: { type: "string" },
    workspaceId: { type: "string" }
  }
};

export const feedbackEvents = {
  // Written feedback on agent messages (LU-4). Ids only: the comment and the copy of the
  // exchange stay in the feedback record and the reviewer's item, never in an event.
  "feedback.received": {
    name: "feedback.received",
    subject: "feedback",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: FEEDBACK_IDS_PAYLOAD
  },
  "feedback.handled": {
    name: "feedback.handled",
    subject: "feedback",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: FEEDBACK_IDS_PAYLOAD
  },
  "feedback.pruned": {
    name: "feedback.pruned",
    subject: "feedback",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["count", "retentionDays"],
      properties: {
        count: { type: "integer", minimum: 0 },
        retentionDays: { type: "integer", minimum: 1 }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
