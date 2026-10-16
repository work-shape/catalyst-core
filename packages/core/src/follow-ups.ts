import type { ClientInstanceId, ConversationId, AgentRunId } from "./ids";
import type { ISODateString } from "./time";
import type {
  FOLLOW_UP_MODES,
  FOLLOW_UP_STATUSES,
  ReasoningEffortConfig
} from "@work-shape/catalyst-asset-schemas";

/** A message accepted behind an active run; it is not yet part of the transcript. */
export interface ConversationFollowUp {
  id: string;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  authorUserId: string;
  text: string;
  mode: (typeof FOLLOW_UP_MODES)[number];
  status: (typeof FOLLOW_UP_STATUSES)[number];
  position: number;
  agentName: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffortConfig;
  idempotencyKey?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  dispatchedRunId?: AgentRunId;
}
