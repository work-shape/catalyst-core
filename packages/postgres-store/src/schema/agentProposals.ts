import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type { AgentProposalSource, ClientInstanceId, JsonObject } from "@work-shape/catalyst-core";
import { configAssets } from "./configAssets";

/**
 * The pending change proposal of an agent, one per agent and source (TRY-1a). The source is a
 * Build conversation or a person, by id: a conversation's proposals are removed with the
 * conversation's other data when it is deleted, so no key ties them to the conversation row,
 * which outlives its deletion. Removing the agent's asset removes its proposals. The row of a
 * source outlives an Apply or a Discard, which remove its revisions, and counts the revisions
 * on: a source's proposal is pending while its row's revision is stored.
 */
export const agentProposals = pgTable(
  "agent_change_proposals",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => configAssets.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<AgentProposalSource["kind"]>().notNull(),
    sourceId: text("source_id").notNull(),
    baseRevision: integer("base_revision").notNull(),
    /** The newest revision: the pending proposal's, which Apply writes, or the last one's. */
    revision: integer("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("agent_change_proposals_source_idx").on(
      table.agentId,
      table.sourceKind,
      table.sourceId
    ),
    // The proposals of a source, which a conversation's deletion removes.
    index("agent_change_proposals_of_source_idx").on(
      table.clientInstanceId,
      table.sourceKind,
      table.sourceId
    ),
    check(
      "agent_change_proposals_source_kind_check",
      sql`${table.sourceKind} in ('conversation', 'person')`
    )
  ]
);

/** Every revision of a proposal: the whole definition each save of it wrote. */
export const agentProposalRevisions = pgTable(
  "agent_change_proposal_revisions",
  {
    proposalId: text("proposal_id")
      .notNull()
      .references(() => agentProposals.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    config: jsonb("config").$type<JsonObject>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "agent_change_proposal_revisions_pk",
      columns: [table.proposalId, table.revision]
    })
  ]
);
