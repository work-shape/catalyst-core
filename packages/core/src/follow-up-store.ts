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
  /** Locks the conversation and reads its contiguous, equally authorized author/selection group. */
  getPendingTurn(input: FollowUpScope): Promise<ConversationFollowUp[]>;
  get(input: FollowUpScope & { followUpId: string }): Promise<ConversationFollowUp | undefined>;
  findByIdempotencyKey(
    input: FollowUpScope & { authorUserId: string; idempotencyKey: string }
  ): Promise<ConversationFollowUp | undefined>;
  /** Server-only authorization accepted with this message; never part of a snapshot or observation. */
  getAuthorization(
    input: FollowUpScope & { followUpId: string }
  ): Promise<AgentRunAuthorization | undefined>;
  listAttachments(input: FollowUpScope & { followUpId: string }): Promise<ConversationAttachment[]>;
  /**
   * Hands the author's queued message to their own running turn, as a steer (FU-2), under the
   * conversation lock. CONFLICT where it could not have been sent as one; it stays queued.
   */
  steer(
    input: FollowUpScope & { followUpId: string; authorUserId: string }
  ): Promise<ConversationFollowUp>;
  /**
   * Cancels under the conversation lock. With an author, refuses another person's item. Its
   * files are deleted, or with `keepAttachments` go back to the composer as drafts.
   */
  cancel(
    input: FollowUpScope & { followUpId: string; authorUserId?: string; keepAttachments?: boolean }
  ): Promise<ConversationFollowUp>;
}
