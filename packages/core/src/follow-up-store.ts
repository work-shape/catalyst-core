import type { AgentRunAuthorization } from "./agent-runtime";
import type { ConversationFollowUp } from "./follow-ups";
import type { ConversationAttachment } from "./files";
import type { ClientInstanceId, ConversationId } from "./ids";

export interface FollowUpScope {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
}

export interface ConversationFollowUpStore {
  listPending(input: FollowUpScope): Promise<ConversationFollowUp[]>;
  /** Coordinates with in-flight acceptance under the conversation lock before reading. */
  getOldestPending(input: FollowUpScope): Promise<ConversationFollowUp | undefined>;
  get(input: FollowUpScope & { followUpId: string }): Promise<ConversationFollowUp | undefined>;
  findByIdempotencyKey(
    input: FollowUpScope & { authorUserId: string; idempotencyKey: string }
  ): Promise<ConversationFollowUp | undefined>;
  /** Server-only authorization accepted with this message; never part of a snapshot or observation. */
  getAuthorization(
    input: FollowUpScope & { followUpId: string }
  ): Promise<AgentRunAuthorization | undefined>;
  listAttachments(input: FollowUpScope & { followUpId: string }): Promise<ConversationAttachment[]>;
  /** Cancels under the conversation lock. With an author, refuses another person's item. */
  cancel(
    input: FollowUpScope & { followUpId: string; authorUserId?: string }
  ): Promise<ConversationFollowUp>;
}
