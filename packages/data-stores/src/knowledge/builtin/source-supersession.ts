import { z } from "zod";
import type { KnowledgeSyncJobPayload, PlatformStores } from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import type { DataStoreRuntime } from "../../runtime";

/** A waiting confirmation is replaceable, while an ordinary active pass is joined.
 * Hold the run before the request; Inbox decisions never acquire the owned store.
 * If the owned commit is lost, a retry also settles an already superseded request. */
export async function supersedeWaitingSource(
  sql: PostgresChangeStatements,
  stores: PlatformStores,
  runtime: DataStoreRuntime,
  payload: KnowledgeSyncJobPayload
): Promise<KnowledgeSyncJobPayload | undefined> {
  const [run] = z
    .array(
      z.object({ id: z.string(), operation_run_id: z.string(), approval_request_id: z.string() })
    )
    .parse(
      await sql.run(
        "select id,operation_run_id,approval_request_id from catalyst_kb.sync_runs where source_id=$1::text and state='running' and approval_request_id is not null for update",
        [payload.sourceId]
      )
    );
  if (!run || run.id === payload.syncRunId) return undefined;
  const request = await stores.approvals.getApprovalRequest({
    clientInstanceId: runtime.clientInstanceId,
    requestId: run.approval_request_id
  });
  if (request?.status === "pending")
    await stores.approvals.transitionPendingApprovalRequest({
      clientInstanceId: runtime.clientInstanceId,
      requestId: request.id,
      resolve: async () => ({ status: "superseded", applyResult: { reason: "later_source_pass" } })
    });
  else if (request?.status !== "superseded") return undefined;
  return { ...payload, syncRunId: run.id, operationRunId: run.operation_run_id };
}
