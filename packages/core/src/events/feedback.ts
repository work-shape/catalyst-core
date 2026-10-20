import type { PlatformEventDefinition } from "./definition";
import type { JsonObject } from "../json";

// The ids a feedback event carries: the comment, the agent and the workspace of the conversation.
const FEEDBACK_IDS_PAYLOAD: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["feedbackId", "agentName"],
  properties: {
    feedbackId: { type: "string" },
    agentName: { type: "string" },
    agentAssetId: { type: "string" },
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
