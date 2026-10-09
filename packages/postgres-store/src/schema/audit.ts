import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { AuditEvent } from "@vivd-catalyst/core";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    type: text("type").notNull(),
    status: text("status").$type<AuditEvent["status"]>().notNull(),
    actor: jsonb("actor").$type<AuditEvent["actor"]>(),
    subject: text("subject"),
    reason: text("reason"),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata").$type<NonNullable<AuditEvent["metadata"]>>().notNull()
  },
  (table) => [
    index("audit_events_client_created_idx").on(table.clientInstanceId, table.createdAt.desc())
  ]
);
