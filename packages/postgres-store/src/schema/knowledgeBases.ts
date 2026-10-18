import type {
  ClientInstanceId,
  KeptKnowledgeStatus,
  KnowledgeTableCheck
} from "@work-shape/catalyst-core";
import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The last check of each Knowledge Base: whether every table it describes could be read, for
 * the revision that was checked. The asset id is no foreign key: the row is removed with the
 * asset by the kind. It holds no row value. `stores/knowledge-bases.ts` holds the only code
 * that reads or writes it.
 */
export const knowledgeBaseStates = pgTable(
  "knowledge_base_states",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    assetId: text("asset_id").notNull(),
    revision: integer("revision").notNull(),
    status: text("status").$type<KeptKnowledgeStatus>().notNull(),
    tables: jsonb("tables").$type<KnowledgeTableCheck[]>().notNull(),
    problem: text("problem"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.clientInstanceId, table.assetId] }),
    check("knowledge_base_states_status_check", sql`${table.status} in ('ok', 'needs_attention')`)
  ]
);

/** A publish invalidates unknown ancestry atomically with its published pointer. */
export const knowledgeSourceBoundaryChanges = pgTable(
  "knowledge_source_boundary_changes",
  {
    clientInstanceId: text("client_instance_id").$type<ClientInstanceId>().notNull(),
    assetId: text("asset_id").notNull(),
    sourceId: text("source_id").notNull()
  },
  (table) => [primaryKey({ columns: [table.clientInstanceId, table.assetId, table.sourceId] })]
);
