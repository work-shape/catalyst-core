import { countWorkflowFailures } from "./postgres-workflow-failure-counts";
import { and, desc, eq } from "drizzle-orm";
import { asUserId, type WorkflowNoticesStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import {
  workflowRevisionPublishers as publishers,
  workflowFailureNotices as notices,
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
    }
  };
}
