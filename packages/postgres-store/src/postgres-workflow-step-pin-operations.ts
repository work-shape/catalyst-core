import { and, eq, inArray } from "drizzle-orm";
import type { WorkflowStepPin, WorkflowStepPinsStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { workflowStepPins } from "./schema/workflowStepPins";

type PinRow = typeof workflowStepPins.$inferSelect;

function mapPin(row: PinRow): WorkflowStepPin {
  return {
    step: row.step,
    sourceRunId: row.sourceRunId,
    stepHash: row.stepHash,
    pinnedBy: row.pinnedBy,
    pinnedAt: row.pinnedAt.toISOString()
  };
}

/** Pinned step outputs of Workflow drafts (EW-10). */
export function createPostgresWorkflowStepPinsStore(db: PostgresConnection): WorkflowStepPinsStore {
  return {
    async put({ clientInstanceId, assetId, pin }) {
      const set = {
        sourceRunId: pin.sourceRunId,
        stepHash: pin.stepHash,
        pinnedAt: new Date(pin.pinnedAt)
      };
      await db
        .insert(workflowStepPins)
        .values({ clientInstanceId, assetId, step: pin.step, pinnedBy: pin.pinnedBy, ...set })
        .onConflictDoUpdate({
          target: [workflowStepPins.assetId, workflowStepPins.pinnedBy, workflowStepPins.step],
          set
        });
    },
    async list({ clientInstanceId, assetId, pinnedBy }) {
      const rows = await db
        .select()
        .from(workflowStepPins)
        .where(
          and(
            eq(workflowStepPins.clientInstanceId, clientInstanceId),
            eq(workflowStepPins.assetId, assetId),
            eq(workflowStepPins.pinnedBy, pinnedBy)
          )
        )
        .orderBy(workflowStepPins.step);
      return rows.map(mapPin);
    },
    async remove({ clientInstanceId, assetId, pinnedBy, steps }) {
      if (steps.length === 0) return 0;
      const removed = await db
        .delete(workflowStepPins)
        .where(
          and(
            eq(workflowStepPins.clientInstanceId, clientInstanceId),
            eq(workflowStepPins.assetId, assetId),
            eq(workflowStepPins.pinnedBy, pinnedBy),
            inArray(workflowStepPins.step, [...steps])
          )
        )
        .returning({ step: workflowStepPins.step });
      return removed.length;
    }
  };
}
