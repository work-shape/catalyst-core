import type { ClientInstanceId, ConversationId, UserId } from "./ids";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";

// The pending change proposal of an agent (TRY-1a): what an agent's save of an existing agent
// writes in place of a live revision. A person applies it, which is their own save of the
// agent, or discards it. A proposal is based on the agent's live revision at the time; once
// the agent has another live revision the proposal is stale and is not applied. Its revisions
// are its own and never show in the agent's history.

/**
 * Who a proposal is of: one Build conversation, or one person (a workspace agent's draft,
 * WS-PUB-1a). One pending proposal per agent and source.
 */
export type AgentProposalSource =
  { kind: "conversation"; conversationId: ConversationId } | { kind: "person"; userId: UserId };

/** One pending proposal, at its newest revision. */
export interface AgentProposal {
  id: string;
  /** The agent, by the id of its asset. */
  agentId: string;
  source: AgentProposalSource;
  /** The agent's live revision the proposal is based on. Apply writes on it and on no other. */
  baseRevision: number;
  /**
   * The proposal's newest revision, which Apply writes. Counted per agent and source, on across
   * an Apply or a Discard, so that a revision names the content of one proposal only.
   */
  revision: number;
  /** The definition of the agent as proposed: the whole config. */
  config: JsonObject;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

interface AgentProposalAddress {
  clientInstanceId: ClientInstanceId;
  agentId: string;
  source: AgentProposalSource;
}

export interface AgentProposalStore {
  /** The pending proposal of one agent and source, or nothing. */
  get(input: AgentProposalAddress): Promise<AgentProposal | undefined>;
  /**
   * Writes the next revision of the proposal of one agent and source, based on `baseRevision`.
   * `expectedRevision` is `null` for a source without a pending proposal, which starts one at
   * the revision after the source's last, and otherwise the pending proposal's newest
   * revision, which the write advances by one. A base
   * that changed since moves with the write. Answers nothing where the proposal is not at
   * `expectedRevision`: another write came first, and nothing was written.
   */
  save(
    input: AgentProposalAddress & {
      baseRevision: number;
      expectedRevision: number | null;
      config: JsonObject;
      savedAt: ISODateString;
    }
  ): Promise<AgentProposal | undefined>;
  /**
   * Removes the pending proposal of one agent and source; with `revision`, only where that is
   * still its newest revision. Answers whether it removed one. The count of the source's
   * revisions stays.
   */
  remove(input: AgentProposalAddress & { revision?: number }): Promise<boolean>;
  /** Removes every proposal of the conversations, with its revisions. */
  removeOfConversations(input: {
    clientInstanceId: ClientInstanceId;
    conversationIds: readonly ConversationId[];
  }): Promise<void>;
}
