import { countWorkflowFailures } from "./postgres-workflow-failure-counts";
import { and, desc, eq, sql, sum } from "drizzle-orm";
import { NOTICE_KIND, asUserId, type WorkflowNoticesStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import {
  workflowRevisionPublishers as publishers,
  workflowFailureNotices as notices,
  approvalRequests,
  configAssetPublications,
  configAssetRevisions
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
    async publishedByCredential(input) {
      const [row] = await db
        .select({ actor: configAssetPublications.actor })
        .from(configAssetPublications)
        .innerJoin(
          configAssetRevisions,
          and(
            eq(configAssetRevisions.assetId, configAssetPublications.assetId),
            eq(configAssetRevisions.revision, configAssetPublications.revision)
          )
        )
        .where(
          and(
            eq(configAssetRevisions.id, input.revisionId),
            eq(configAssetPublications.clientInstanceId, input.clientInstanceId)
          )
        )
        .orderBy(desc(configAssetPublications.number))
        .limit(1);
      const actor = row?.actor;
      return (
        actor !== null &&
        actor !== undefined &&
        (actor.principalKind === "service" ||
          actor.credentialId !== undefined ||
          actor.delegatedActor?.kind === "api_key")
      );
    },
    async failureCount(input) {
      const counts = await countWorkflowFailures(db, {
        clientInstanceId: input.clientInstanceId,
        runIds: [input.rootRunId],
        includeRoot: true
      });
      return counts.get(input.rootRunId) ?? 0;
    },
    async markNotified(input) {
      const rows = await db
        .insert(notices)
        .values(input)
        .onConflictDoNothing()
        .returning({ id: notices.rootRunId });
      return rows.length === 1;
    },
    async openFailureNotice(input) {
      const key = JSON.stringify([
        "workflow-failure-notice",
        input.clientInstanceId,
        input.workflowId,
        input.userId
      ]);
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      // Only a notice a failure marker names is a failure notice: a notify step's notice to the
      // same person about the same Workflow is never reworded.
      const [open] = await db
        .select({ noticeId: approvalRequests.id, payload: approvalRequests.payload })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.clientInstanceId, input.clientInstanceId),
            eq(approvalRequests.addresseeUserId, input.userId),
            eq(approvalRequests.status, "pending"),
            eq(approvalRequests.kind, NOTICE_KIND),
            sql`${approvalRequests.payload}->'link'->>'workflowId' = ${input.workflowId}`,
            sql`exists (select 1 from ${notices} where ${notices.noticeId} = ${approvalRequests.id})`
          )
        )
        .orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id))
        .limit(1)
        .for("update");
      if (!open) return undefined;
      const [counted] = await db
        .select({ failures: sum(notices.failures).mapWith(Number) })
        .from(notices)
        .where(
          and(
            eq(notices.clientInstanceId, input.clientInstanceId),
            eq(notices.noticeId, open.noticeId)
          )
        );
      return { ...open, failures: counted?.failures ?? 0 };
    },
    async updateFailureNotice(input) {
      const at = new Date(input.at);
      const rows = await db
        .update(approvalRequests)
        .set({ summary: input.summary, payload: input.payload, createdAt: at, updatedAt: at })
        .where(
          and(
            eq(approvalRequests.clientInstanceId, input.clientInstanceId),
            eq(approvalRequests.id, input.noticeId),
            eq(approvalRequests.status, "pending")
          )
        )
        .returning({ id: approvalRequests.id });
      return rows.length === 1;
    },
    async linkFailureNotice(input) {
      await db
        .update(notices)
        .set({ noticeId: input.noticeId })
        .where(
          and(
            eq(notices.clientInstanceId, input.clientInstanceId),
            eq(notices.rootRunId, input.rootRunId)
          )
        );
    }
  };
}
