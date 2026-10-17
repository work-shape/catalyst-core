import { and, eq, inArray } from "drizzle-orm";
import {
  asConversationId,
  asUserId,
  createPlatformId,
  type AgentProposal,
  type AgentProposalSource,
  type AgentProposalStore
} from "@work-shape/catalyst-core";
import { type PostgresConnection, type PostgresTransaction } from "./postgres-database";
import { agentProposalRevisions, agentProposals } from "./schema/agentProposals";

type Input<Method extends keyof AgentProposalStore> = Parameters<AgentProposalStore[Method]>[0];
type ProposalRow = typeof agentProposals.$inferSelect;

const sourceIdOf = (source: AgentProposalSource): string =>
  source.kind === "conversation" ? source.conversationId : source.userId;

const sourceOf = (row: ProposalRow): AgentProposalSource =>
  row.sourceKind === "conversation"
    ? { kind: "conversation", conversationId: asConversationId(row.sourceId) }
    : { kind: "person", userId: asUserId(row.sourceId) };

/** The shared draft of one agent, found by the unique agent index. */
const ofAgent = (input: Input<"get">) =>
  and(
    eq(agentProposals.clientInstanceId, input.clientInstanceId),
    eq(agentProposals.agentId, input.agentId)
  );

function mapProposal(row: ProposalRow, config: AgentProposal["config"]): AgentProposal {
  return {
    id: row.id,
    agentId: row.agentId,
    source: sourceOf(row),
    author: {
      ...(row.lastAuthorUserId ? { userId: asUserId(row.lastAuthorUserId) } : {}),
      ...(row.lastBuildConversationId
        ? { conversationId: asConversationId(row.lastBuildConversationId) }
        : {}),
      release: row.lastWriteRelease
    },
    baseRevision: row.baseRevision,
    revision: row.revision,
    config,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export async function getAgentProposal(
  db: PostgresConnection,
  input: Input<"get">
): Promise<AgentProposal | undefined> {
  const [found] = await db
    .select({ proposal: agentProposals, config: agentProposalRevisions.config })
    .from(agentProposals)
    .innerJoin(
      agentProposalRevisions,
      and(
        eq(agentProposalRevisions.proposalId, agentProposals.id),
        eq(agentProposalRevisions.revision, agentProposals.revision)
      )
    )
    .where(ofAgent(input))
    .limit(1);
  return found ? mapProposal(found.proposal, found.config) : undefined;
}

/**
 * The row of one agent, locked for the write, and its pending revision: the row's
 * revision where that revision is stored, and none once Apply or Discard removed its revisions.
 */
async function lockDraft(tx: PostgresTransaction, input: Input<"get">) {
  const [row] = await tx.select().from(agentProposals).where(ofAgent(input)).for("update").limit(1);
  if (!row) return { row: undefined, pending: null };
  const [head] = await tx
    .select({ revision: agentProposalRevisions.revision })
    .from(agentProposalRevisions)
    .where(
      and(
        eq(agentProposalRevisions.proposalId, row.id),
        eq(agentProposalRevisions.revision, row.revision)
      )
    )
    .limit(1);
  return { row, pending: head ? row.revision : null };
}

export async function saveAgentProposal(
  db: PostgresConnection,
  input: Input<"save">
): Promise<AgentProposal | undefined> {
  const savedAt = new Date(input.savedAt);
  const author = input.author ?? {
    ...(input.source?.kind === "person" ? { userId: input.source.userId } : {}),
    ...(input.source?.kind === "conversation"
      ? { conversationId: input.source.conversationId }
      : {}),
    release: false
  };
  const source =
    input.source ??
    (author.conversationId
      ? { kind: "conversation" as const, conversationId: author.conversationId }
      : { kind: "person" as const, userId: author.userId ?? asUserId("release") });
  const attribution = {
    lastAuthorUserId: author.userId ?? null,
    lastBuildConversationId: author.conversationId ?? null,
    lastWriteRelease: author.release
  };
  return db.transaction(async (tx) => {
    const { row: found, pending } = await lockDraft(tx, input);
    if (pending !== input.expectedDraftRevision) return undefined;
    // The row outlives an Apply or a Discard, so the next proposal of the agent counts on from
    // the last one's revision: a revision a person read names one proposal's content only. Of
    // two first saves, the insert of one finds the other's row and writes nothing.
    const [row] = found
      ? await tx
          .update(agentProposals)
          .set({
            ...attribution,
            baseRevision: input.baseRevision,
            revision: found.revision + 1,
            ...(pending === null ? { createdAt: savedAt } : {}),
            updatedAt: savedAt
          })
          .where(eq(agentProposals.id, found.id))
          .returning()
      : await tx
          .insert(agentProposals)
          .values({
            id: createPlatformId("acp"),
            clientInstanceId: input.clientInstanceId,
            agentId: input.agentId,
            sourceKind: source.kind,
            sourceId: sourceIdOf(source),
            ...attribution,
            baseRevision: input.baseRevision,
            revision: 1,
            createdAt: savedAt,
            updatedAt: savedAt
          })
          .onConflictDoNothing()
          .returning();
    if (!row) return undefined;
    await tx.insert(agentProposalRevisions).values({
      proposalId: row.id,
      revision: row.revision,
      config: input.config,
      createdAt: savedAt
    });
    return mapProposal(row, input.config);
  });
}

export async function removeAgentProposal(
  db: PostgresConnection,
  input: Input<"remove">
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { row, pending } = await lockDraft(tx, input);
    if (!row || pending === null) return false;
    if (input.revision !== undefined && pending !== input.revision) return false;
    // The revisions go; the row stays and keeps the count of the agent's revisions.
    await tx.delete(agentProposalRevisions).where(eq(agentProposalRevisions.proposalId, row.id));
    return true;
  });
}

export function createPostgresAgentProposalStore(db: PostgresConnection): AgentProposalStore {
  return {
    async summaries(input) {
      if (!input.agentIds.length) return new Map();
      const rows = await db
        .select({ proposal: agentProposals })
        .from(agentProposals)
        .innerJoin(
          agentProposalRevisions,
          and(
            eq(agentProposalRevisions.proposalId, agentProposals.id),
            eq(agentProposalRevisions.revision, agentProposals.revision)
          )
        )
        .where(
          and(
            eq(agentProposals.clientInstanceId, input.clientInstanceId),
            inArray(agentProposals.agentId, [...input.agentIds])
          )
        );
      return new Map(
        rows.map(({ proposal }) => {
          const { revision, baseRevision, author, updatedAt } = mapProposal(proposal, {});
          return [proposal.agentId, { revision, baseRevision, author, updatedAt }];
        })
      );
    },
    get: (input) => getAgentProposal(db, input),
    save: (input) => saveAgentProposal(db, input),
    remove: (input) => removeAgentProposal(db, input)
  };
}
