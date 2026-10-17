import type { ClientInstanceId, ConversationId, UserId } from "./ids";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";

/** Retained only for the source columns of the proposal-store transition. */
export type AgentProposalSource =
  { kind: "conversation"; conversationId: ConversationId } | { kind: "person"; userId: UserId };

/** The last writer of the shared draft. No foreign keys: deleting its author leaves it. */
export interface AgentDraftAuthor {
  userId?: UserId;
  conversationId?: ConversationId;
  release: boolean;
}

/** One pending agent draft. Its revisions never enter live history or repeat a number. */
export interface AgentProposal {
  id: string;
  agentId: string;
  source: AgentProposalSource;
  author: AgentDraftAuthor;
  baseRevision: number;
  revision: number;
  config: JsonObject;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

interface AgentProposalAddress {
  clientInstanceId: ClientInstanceId;
  agentId: string;
  /** Legacy callers may supply a source; it never partitions drafts. */
  source?: AgentProposalSource;
}

export interface AgentProposalStore {
  summaries(input: {
    clientInstanceId: ClientInstanceId;
    agentIds: readonly string[];
  }): Promise<
    Map<string, Pick<AgentProposal, "revision" | "baseRevision" | "author" | "updatedAt">>
  >;
  get(input: AgentProposalAddress): Promise<AgentProposal | undefined>;
  /** A missing pending head is null, independently of the live revision. */
  save(
    input: AgentProposalAddress & {
      author?: AgentDraftAuthor;
      baseRevision: number;
      expectedDraftRevision: number | null;
      config: JsonObject;
      savedAt: ISODateString;
    }
  ): Promise<AgentProposal | undefined>;
  /** Removes the content, retaining the monotonic counter. */
  remove(input: AgentProposalAddress & { revision?: number }): Promise<boolean>;
}
