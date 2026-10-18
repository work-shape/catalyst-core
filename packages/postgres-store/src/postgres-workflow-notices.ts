import { and, count, eq, inArray, sql } from "drizzle-orm";
import { asUserId, type WorkflowNoticesStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import {
  workflowRevisionPublishers as publishers,
  workflowFailureNotices as notices,
  workflowRuns
} from "./schema";

export function createPostgresWorkflowNoticesStore(db: PostgresConnection): WorkflowNoticesStore {
  return {
    async recordPublisher(input) {
      await db.insert(publishers).values(input).onConflictDoNothing();
    },
    async publisher(input) {
      const [row] = await db
        .select({ userId: publishers.userId })
        .from(publishers)
        .where(
          and(
            eq(publishers.clientInstanceId, input.clientInstanceId),
            eq(publishers.revisionId, input.revisionId)
          )
        );
      return row ? asUserId(row.userId) : undefined;
    },
    async failureCount(input) {
      const [row] = await db
        .select({ count: count() })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.clientInstanceId, input.clientInstanceId),
            sql`${workflowRuns.rootRunId} = ${input.rootRunId}`,
            inArray(workflowRuns.status, ["failed", "limit_reached"])
          )
        );
      return row?.count ?? 0;
    },
    async markNotified(input) {
      const rows = await db
        .insert(notices)
        .values(input)
        .onConflictDoNothing()
        .returning({ id: notices.rootRunId });
      return rows.length === 1;
    }
  };
}
