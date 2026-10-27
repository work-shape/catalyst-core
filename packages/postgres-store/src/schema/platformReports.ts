import { foreignKey, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { productUsers } from "./users";

/**
 * Who reported which failed run to the operator (PLATFORM-REPORT), so that a person reports one
 * run once and a few runs an hour. It holds no text: the person's note went into the mail and
 * is kept nowhere. The run is a reference only, so a report outlives its conversation for the
 * limits; deleting the author deletes it, and the daily prune removes it after 90 days.
 */
export const platformReports = pgTable(
  "platform_reports",
  {
    id: text("id").primaryKey(),
    clientInstanceId: text("client_instance_id").notNull(),
    agentRunId: text("agent_run_id").notNull(),
    authorUserId: text("author_user_id").notNull(),
    errorCode: text("error_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull()
  },
  (table) => [
    // One report per person per run.
    uniqueIndex("platform_reports_run_author_idx").on(
      table.clientInstanceId,
      table.agentRunId,
      table.authorUserId
    ),
    // The author's reports of the last hour.
    index("platform_reports_author_created_idx").on(
      table.clientInstanceId,
      table.authorUserId,
      table.createdAt
    ),
    // The retention sweep, oldest first.
    index("platform_reports_created_idx").on(table.clientInstanceId, table.createdAt),
    foreignKey({
      name: "platform_reports_author_fk",
      columns: [table.clientInstanceId, table.authorUserId],
      foreignColumns: [productUsers.clientInstanceId, productUsers.id]
    }).onDelete("cascade")
  ]
);
