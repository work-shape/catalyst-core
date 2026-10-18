import { configAssetRevisions } from "./configAssets";
import { workflowRuns } from "./workflowRuns";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { approvalRequests } from "./approvals";
import { productUsers } from "./users";

// Ephemeral outbox references only. Successful delivery deletes them; deleting the person or
// their Inbox notice also removes its pending mail. No title, text, address or rendered body.
export const noticeMail = pgTable(
  "notice_mail",
  {
    noticeId: text("notice_id")
      .primaryKey()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    clientInstanceId: text("client_instance_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => productUsers.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull()
  },
  (table) => [
    index("notice_mail_due_idx").on(table.clientInstanceId, table.dueAt, table.userId),
    index("notice_mail_recipient_idx").on(table.clientInstanceId, table.userId, table.dueAt)
  ]
);

// Publisher, not the draft's author. Kept with the revision across later publications.
export const workflowRevisionPublishers = pgTable("workflow_revision_publishers", {
  revisionId: text("revision_id")
    .primaryKey()
    .references(() => configAssetRevisions.id, { onDelete: "cascade" }),
  clientInstanceId: text("client_instance_id").notNull(),
  userId: text("user_id").notNull()
});

export const workflowFailureNotices = pgTable("workflow_failure_notices", {
  rootRunId: text("root_run_id")
    .primaryKey()
    .references(() => workflowRuns.id, { onDelete: "cascade" }),
  clientInstanceId: text("client_instance_id").notNull()
});
