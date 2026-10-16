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

/** The proposal of one agent and source. The unique index on the three finds it. */
const ofSource = (input: Input<"get">) =>
  and(
    eq(agentProposals.clientInstanceId, input.clientInstanceId),
    eq(agentProposals.agentId, input.agentId),
    eq(agentProposals.sourceKind, input.source.kind),
    eq(agentProposals.sourceId, sourceIdOf(input.source))
  );

function mapProposal(row: ProposalRow, config: AgentProposal["config"]): AgentProposal {
  return {
    id: row.id,
    agentId: row.agentId,
    source: sourceOf(row),
    baseRevision: row.baseRevision,
    revision: row.revision,
    config,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

async function getAgentProposal(
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
    .where(ofSource(input))
    .limit(1);
  return found ? mapProposal(found.proposal, found.config) : undefined;
}

/**
 * The row of one agent and source, locked for the write, and its pending revision: the row's
 * revision where that revision is stored, and none once Apply or Discard removed its revisions.
 */
async function lockSource(tx: PostgresTransaction, input: Input<"get">) {
  const [row] = await tx
    .select()
    .from(agentProposals)
    .where(ofSource(input))
    .for("update")
    .limit(1);
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

async function saveAgentProposal(
  db: PostgresConnection,
  input: Input<"save">
): Promise<AgentProposal | undefined> {
  const savedAt = new Date(input.savedAt);
  return db.transaction(async (tx) => {
    const { row: found, pending } = await lockSource(tx, input);
    if (pending !== input.expectedRevision) return undefined;
    // The row outlives an Apply or a Discard, so the next proposal of the source counts on from
    // the last one's revision: a revision a person read names one proposal's content only. Of
    // two first saves, the insert of one finds the other's row and writes nothing.
    const [row] = found
      ? await tx
          .update(agentProposals)
          .set({
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
            sourceKind: input.source.kind,
            sourceId: sourceIdOf(input.source),
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

async function removeAgentProposal(
  db: PostgresConnection,
  input: Input<"remove">
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { row, pending } = await lockSource(tx, input);
    if (!row || pending === null) return false;
    if (input.revision !== undefined && pending !== input.revision) return false;
    // The revisions go; the row stays and keeps the count of the source's revisions.
    await tx.delete(agentProposalRevisions).where(eq(agentProposalRevisions.proposalId, row.id));
    return true;
  });
}

async function removeAgentProposalsOfConversations(
  db: PostgresConnection,
  input: Input<"removeOfConversations">
): Promise<void> {
  if (input.conversationIds.length === 0) return;
  await db
    .delete(agentProposals)
    .where(
      and(
        eq(agentProposals.clientInstanceId, input.clientInstanceId),
        eq(agentProposals.sourceKind, "conversation"),
        inArray(agentProposals.sourceId, [...input.conversationIds])
      )
    );
}

export function createPostgresAgentProposalStore(db: PostgresConnection): AgentProposalStore {
  return {
    get: (input) => getAgentProposal(db, input),
    save: (input) => saveAgentProposal(db, input),
    remove: (input) => removeAgentProposal(db, input),
    removeOfConversations: (input) => removeAgentProposalsOfConversations(db, input)
  };
}
