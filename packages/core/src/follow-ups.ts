import type { ClientInstanceId, ConversationId, AgentRunId } from "./ids";
import type { ISODateString } from "./time";
import type {
  FOLLOW_UP_MODES,
  FOLLOW_UP_STATUSES,
  ReasoningEffortConfig
} from "@work-shape/catalyst-asset-schemas";

/** What a message sent while a run goes does: wait as the next turn, or steer the run. */
export type FollowUpMode = (typeof FOLLOW_UP_MODES)[number];

/** What Enter does during a person's own run until they choose otherwise. */
export const DEFAULT_FOLLOW_UP_MODE: FollowUpMode = "steer";

/** A file a queued message carries; it goes with the message when the message starts. */
export interface ConversationFollowUpAttachment {
  fileId: string;
  filename: string;
  mimeType?: string;
  byteSize: number;
}

/** A message accepted behind an active run; it is not yet part of the transcript. */
export interface ConversationFollowUp {
  id: string;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  authorUserId: string;
  /** Read-time label of an active author with current conversation access; never stored in run events. */
  authorDisplayLabel?: string;
  text: string;
  mode: FollowUpMode;
  status: (typeof FOLLOW_UP_STATUSES)[number];
  position: number;
  agentName: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffortConfig;
  idempotencyKey?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  dispatchedRunId?: AgentRunId;
  /** The files of a pending message, so the queue shows them (T23). */
  attachments?: ConversationFollowUpAttachment[];
}
