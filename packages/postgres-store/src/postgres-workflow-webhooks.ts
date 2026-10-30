import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import type { WorkflowWebhookStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { workflowWebhookDeliveries } from "./schema/workflowWebhooks";

const MINUTE_MS = 60_000;

/** The accepted nonces of Workflows' webhook triggers (EW-4). */
export function createPostgresWorkflowWebhookStore(db: PostgresConnection): WorkflowWebhookStore {
  return {
    async admit({ clientInstanceId, workflowAssetId, nonce, receivedAt, perMinute, forgetBefore }) {
      const ofWorkflow = eq(workflowWebhookDeliveries.workflowAssetId, workflowAssetId);
      // Requests of one Workflow are admitted one after the other, so two at the same moment
      // cannot both take the last place of the minute.
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`workflow_webhook:${workflowAssetId}`}, 0))`
      );
      await db
        .delete(workflowWebhookDeliveries)
        .where(and(ofWorkflow, lt(workflowWebhookDeliveries.receivedAt, new Date(forgetBefore))));
      const [seen] = await db
        .select({ nonce: workflowWebhookDeliveries.nonce })
        .from(workflowWebhookDeliveries)
        .where(and(ofWorkflow, eq(workflowWebhookDeliveries.nonce, nonce)));
      if (seen) return "replayed";
      const at = new Date(receivedAt);
      const [recent] = await db
        .select({ count: count() })
        .from(workflowWebhookDeliveries)
        .where(
          and(
            ofWorkflow,
            gte(workflowWebhookDeliveries.receivedAt, new Date(at.getTime() - MINUTE_MS))
          )
        );
      if ((recent?.count ?? 0) >= perMinute) return "rate_limited";
      await db
        .insert(workflowWebhookDeliveries)
        .values({ clientInstanceId, workflowAssetId, nonce, receivedAt: at });
      return "admitted";
    }
  };
}
