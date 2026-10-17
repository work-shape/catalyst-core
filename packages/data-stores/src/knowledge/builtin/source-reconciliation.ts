import { sourceBoundaryKey } from "../source-boundary";
import { SOURCE_WITHDRAWAL_APPROVAL } from "../source-withdrawal-approval";
import { z } from "zod";
import { asUserId, type KnowledgeSyncJobPayload, type JobControl } from "@work-shape/catalyst-core";
import { sourceTransaction, type SourceProgress } from "./source-store";
import { sourceTarget, type SourceJobRuntime } from "./source-runtime";

// Each purge payload and owned transaction holds at most this many ids.
const SOURCE_WITHDRAWAL_BATCH = 100;

/** Only a complete listing may infer deletion. The source's running-row lock keeps
 * this candidate set stable while its publisher decides. No deletion is applied early. */
export async function reconcileSource(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  control: JobControl,
  progress: SourceProgress
): Promise<boolean> {
  const allowed = await sourceTransaction(runtime.data, payload, control, async (store, stores) =>
    store.change(async (sql) => {
      const [run] = z
        .array(
          z.object({
            approval_request_id: z.string().nullable(),
            state: z.string(),
            definition_key: z.string().nullable()
          })
        )
        .parse(
          await sql.run(
            "select approval_request_id,state,definition_key from catalyst_kb.sync_runs where id=$1::text for update",
            [payload.syncRunId]
          )
        );
      if (!run || run.state !== "running") return false;
      const found = await sourceTarget(runtime, payload, stores, "share");
      if (!found || run.definition_key !== sourceBoundaryKey(found.source)) {
        await store.finish(payload, "knowledge_source_refused");
        return false;
      }
      async function approvalAllows(status: string | undefined) {
        if (status === undefined || status === "pending") return false;
        if (status === "approved") return true;
        await store.finish(payload, "knowledge_source_refused");
        return false;
      }
      // Once a confirmation exists, its decision owns the pass even if retries
      // authoritatively withdraw some candidates and reduce the remaining share.
      if (run.approval_request_id) {
        const request = await stores.approvals.getApprovalRequest({
          clientInstanceId: runtime.data.clientInstanceId,
          requestId: run.approval_request_id
        });
        return approvalAllows(request?.status);
      }
      const [counts] = z
        .array(z.object({ total: z.coerce.number(), missing: z.coerce.number() }))
        .parse(
          await sql.run(
            "select count(*) as total,count(*) filter(where seen_run_id is distinct from $2::text) as missing from catalyst_kb.source_items where source_id=$1::text and state<>'withdrawn'",
            [payload.sourceId, payload.syncRunId]
          )
        );
      if (counts && counts.missing > counts.total * (runtime.input.withdrawShareConfirm ?? 0.2)) {
        const existing = await stores.approvals.listApprovalRequests({
          clientInstanceId: runtime.data.clientInstanceId,
          kinds: [SOURCE_WITHDRAWAL_APPROVAL],
          subjectContains: { assetId: payload.knowledgeBaseId, syncRunId: payload.syncRunId },
          page: { limit: 1 }
        });
        const request =
          existing[0] ??
          (await stores.approvals.createApprovalRequest({
            clientInstanceId: runtime.data.clientInstanceId,
            kind: SOURCE_WITHDRAWAL_APPROVAL,
            summary: `Confirm withdrawal of ${counts.missing} of ${counts.total} items from ${found.name}/${payload.sourceId}`,
            requestedBy: {
              id: asUserId(payload.knowledgeBaseId),
              displayLabel: "Knowledge Base sync"
            },
            payload: {
              ...payload,
              boundaryKey: run.definition_key,
              subject: {
                kind: "knowledge_base",
                assetId: payload.knowledgeBaseId,
                syncRunId: payload.syncRunId,
                name: found.name,
                ...(found.scope.kind === "workspace"
                  ? { workspaceId: found.scope.workspaceId }
                  : {})
              },
              withdrawn: counts.missing,
              total: counts.total
            }
          }));
        await sql.run(
          "update catalyst_kb.sync_runs set approval_request_id=$2::text where id=$1::text",
          [payload.syncRunId, request.id]
        );
        return approvalAllows(request.status);
      }
      return true;
    })
  );
  if (!allowed) return false;
  let after = "";
  for (;;) {
    const next = await sourceTransaction(runtime.data, payload, control, async (store, stores) =>
      store.change(async (sql) => {
        const active = z
          .array(z.object({ definition_key: z.string().nullable() }))
          .parse(
            await sql.run(
              "select definition_key from catalyst_kb.sync_runs where id=$1::text and state='running' for update",
              [payload.syncRunId]
            )
          );
        if (!active.length) return false;
        const found = await sourceTarget(runtime, payload, stores, "share");
        if (!found || active[0]?.definition_key !== sourceBoundaryKey(found.source)) {
          await store.finish(payload, "knowledge_source_refused");
          return false;
        }
        const ids = z
          .array(z.object({ id: z.string() }))
          .parse(
            await sql.run(
              "select id from catalyst_kb.source_items where source_id=$1::text and state<>'withdrawn' and seen_run_id is distinct from $2::text and id>$4::text order by id limit $3::int",
              [payload.sourceId, payload.syncRunId, SOURCE_WITHDRAWAL_BATCH, after]
            )
          )
          .map((row) => row.id);
        if (ids.length) {
          await store.withdraw(payload, ids);
          return ids.at(-1) ?? false;
        }
        await sql.run("update catalyst_kb.sync_runs set cursor_after=$2::text where id=$1::text", [
          payload.syncRunId,
          JSON.stringify({ ...progress, reconciled: true })
        ]);
        return true;
      })
    );
    if (typeof next === "boolean") return next;
    after = next;
  }
}
