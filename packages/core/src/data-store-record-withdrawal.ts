import { z } from "zod";
import { defineJobKind } from "./jobs";

/** References only. The worker discovers target stores by this composite document identity. */
export const dataStoreRecordWithdrawalPayloadSchema = z.strictObject({
  knowledgeBaseId: z.string().min(1).max(200),
  documentId: z.string().min(1).max(200)
});
export type DataStoreRecordWithdrawal = z.infer<typeof dataStoreRecordWithdrawalPayloadSchema>;

/** Frozen handoff for REC-1b; REC-0 registers no worker and queues no jobs. */
export const dataStoreRecordWithdrawalJob = defineJobKind({
  kind: "data_store.records_withdraw",
  payloadSchema: dataStoreRecordWithdrawalPayloadSchema,
  maxAttempts: 5,
  backoff: { baseMs: 30_000, maxMs: 15 * 60_000 },
  leaseMs: 5 * 60_000,
  concurrency: { perKey: 1 },
  manualRetry: false
});

/**
 * A transaction-bound outbox in the Knowledge Base's owned store, not an immediate call
 * into a Data Store or an independently committed platform job. enqueue inserts the ids in
 * the withdrawal's OWN transaction: rollback removes both withdrawal and outbox entry.
 * After commit the relay queues dataStoreRecordWithdrawalJob, with at-least-once delivery;
 * REC-1b's consumer recomputes idempotently, even with every Workflow disabled. No path,
 * quote or value crosses this port. An acknowledged delivery alone removes the outbox row.
 */
export interface DataStoreRecordWithdrawalOutbox {
  enqueue(withdrawal: DataStoreRecordWithdrawal): Promise<void>;
}
