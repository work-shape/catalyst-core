import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import type {
  AgentProposalSource,
  ClientInstanceId,
  FileSetId,
  JsonObject
} from "@work-shape/catalyst-core";
import { configAssets } from "./configAssets";

/**
 * One counter row per agent, or per skill with a shared draft (SKILL-DRAFT-1); a stored head is
 * pending. Source columns remain for rollback.
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
    lastAuthorUserId: text("last_author_user_id"),
    lastBuildConversationId: text("last_build_conversation_id"),
    lastWriteRelease: boolean("last_write_release").notNull().default(false),
    baseRevision: integer("base_revision").notNull(),
    /** The newest revision: the pending proposal's, which Apply writes, or the last one's. */
    revision: integer("revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("agent_change_proposals_agent_idx").on(table.agentId),
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
    /** The file set of a skill draft's folder beside its config (SKILL-DRAFT-1). */
    fileSetId: text("file_set_id").$type<FileSetId>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "agent_change_proposal_revisions_pk",
      columns: [table.proposalId, table.revision]
    })
  ]
);
