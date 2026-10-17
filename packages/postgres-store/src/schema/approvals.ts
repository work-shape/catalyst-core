import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ApprovalRequest, JsonObject } from "@work-shape/catalyst-core";

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").$type<JsonObject>().notNull(),
    requestedBy: jsonb("requested_by").$type<ApprovalRequest["requestedBy"]>().notNull(),
    // The one person a confirmation in the Inbox is addressed to (OP-4b). Null for a request
    // the holders of its kind's right decide.
    addresseeUserId: text("addressee_user_id"),
    origin: jsonb("origin").$type<ApprovalRequest["origin"]>(),
    status: text("status").$type<ApprovalRequest["status"]>().notNull(),
    // Reversion metadata shares the decision JSON; the public request exposes it separately.
    decision: jsonb("decision").$type<
      ApprovalRequest["decision"] & { reversion?: ApprovalRequest["reversion"] }
    >(),
    checks: jsonb("checks").$type<ApprovalRequest["checks"]>().notNull().default([]),
    applyResult: jsonb("apply_result").$type<JsonObject>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("approval_requests_client_status_idx").on(
      table.clientInstanceId,
      table.status,
      table.createdAt.desc()
    ),
    index("approval_requests_client_conversation_idx").on(
      table.clientInstanceId,
      sql`(${table.origin}->>'conversationId')`
    ),
    // A person's own requests, newest first: the Inbox list "My requests" and its counts.
    index("approval_requests_client_requester_idx").on(
      table.clientInstanceId,
      sql`(${table.requestedBy}->>'id')`,
      table.createdAt.desc()
    ),
    // The requests addressed to one person: their To decide list and its count.
    index("approval_requests_client_addressee_idx")
      .on(table.clientInstanceId, table.addresseeUserId, table.status)
      .where(sql`${table.addresseeUserId} is not null`)
  ]
);
