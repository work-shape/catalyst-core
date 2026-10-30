import { WORKFLOW_RETENTION_VERSION } from "./workflow-retention-version";
import {
  and,
  asc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  lt,
  ne,
  notExists,
  notInArray,
  or,
  isNull,
  sql,
  type AnyColumn,
  type SQL
} from "drizzle-orm";
import { WORKFLOW_ENDED_STATUSES, type WorkflowRunsStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { runIs } from "./postgres-workflow-run-mapping";
import { minimizedHeldCallResult, onlyKeys } from "./postgres-pruned-run";
import {
  approvalRequests,
  conversationAttachments,
  conversations,
  managedArtifacts,
  managedFiles,
  messages,
  agentRunObservations,
  agentRuns,
  modelProviderContinuations,
  modelProviderTurnContinuations,
  operationRuns
} from "./schema";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";

// This is the only owner of values on Workflow Runs and ALL attempts of their steps.
// Dataset bytes have their own lifetime owner (dataset-lifetime); references to them here
// expire with other run values. Child and continuation IDs are governance links, not values:
// each linked run is pruned independently, without losing the names/counts of its history.
// Keys and labels hold identifiers, not content; done runs keep their keys to prevent replays.
// No script, literal, cursor or log text survives. Version zero includes pre-owner prunes.

const runValues = {
  definition: sql`null`,
  input: sql`'{}'::jsonb`,
  output: sql`null`,
  checkpoint: sql`null`,
  itemLabel: sql`null`
} satisfies Partial<Record<keyof typeof workflowRuns.$inferSelect, SQL>>;

// A loop keeps only step names and counters. Whitelist rather than subtract: a newly
// staged field cannot escape retention. Re-evaluated under the row lock, this is idempotent.
const stepValues = {
  input: sql`case when ${workflowStepRuns.stepType} <> 'loop' or ${workflowStepRuns.input} is null then null else
    jsonb_strip_nulls(jsonb_build_object(
      'last', ${workflowStepRuns.input}->'last',
      'total', case when jsonb_typeof(${workflowStepRuns.input}->'items') = 'array'
        then to_jsonb(jsonb_array_length(${workflowStepRuns.input}->'items'))
        else ${workflowStepRuns.input}->'total' end)) end`,
  output: sql`null`,
  staged: sql`null`,
  codeOutcome: sql`null`,
  log: sql`null`,
  iterationLabel: sql`null`
} satisfies Partial<Record<keyof typeof workflowStepRuns.$inferSelect, SQL>>;

// Explicitly classify EVERY other column. Both the typecheck and the schema coverage
// assertion below refuse an added column until its retention owner has been decided.
const runGovernance = {
  id: true,
  clientInstanceId: true,
  workflow: true,
  runKey: true,
  labels: true,
  definitionRevisionId: true,
  mode: true,
  trigger: true,
  status: true,
  empty: true,
  error: true,
  principalId: true,
  principalName: true,
  principalLabel: true,
  startedBy: true,
  operationRunId: true,
  // The id of the run whose call started it: lineage the reach check reads, not a value.
  starterRunId: true,
  // Names of the App, its revision and its action: governance, not a value of the run.
  startedFrom: true,
  // The pinned steps of a test run and their source runs: ids, not a value of the run.
  pinnedSteps: true,
  parentRunId: true,
  parentStepRunId: true,
  rootRunId: true,
  depth: true,
  itemIndex: true,
  failedItemCount: true,
  stepRunCount: true,
  deadlineAt: true,
  limits: true,
  waitingSince: true,
  waitedMs: true,
  correlationId: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  cancelledBy: true,
  cancelledAt: true,
  scheduledFor: true,
  continuation: true,
  dataPrunedAt: true,
  dataPruneVersion: true
} satisfies Record<Exclude<keyof typeof workflowRuns.$inferSelect, keyof typeof runValues>, true>;

const stepGovernance = {
  id: true,
  clientInstanceId: true,
  runId: true,
  stepId: true,
  stepType: true,
  key: true,
  containerStepRunId: true,
  branch: true,
  iteration: true,
  status: true,
  attempt: true,
  operationRunId: true,
  agentRunId: true,
  linkedRunId: true,
  effect: true,
  source: true,
  target: true,
  publishedWouldAsk: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true
} satisfies Record<
  Exclude<keyof typeof workflowStepRuns.$inferSelect, keyof typeof stepValues>,
  true
>;

// What a settled request of a thread keeps of its held call. Keep it the shape of
// `minimizedOperationCallPayload` (server, approvals), which every path that ends a held call
// writes and the Inbox reads; this repairs a request that ended without it.
const heldCallKeys = [
  "runId",
  "operation",
  "effect",
  "mode",
  "asset",
  "subject",
  "subjectKind",
  "origin",
  "workspaceId",
  "expiresAt"
] as const;
const minimizedHeldCall = sql`${onlyKeys(approvalRequests.payload, heldCallKeys)}
  || case when jsonb_typeof(${approvalRequests.payload}->'actor') = 'object'
    then jsonb_build_object('actor', ${onlyKeys(sql`${approvalRequests.payload}->'actor'`, ["id", "label"])})
    else '{}'::jsonb end
  || '{"inputRemoved": true}'::jsonb`;

function assertColumns(columns: object, values: object, governance: object) {
  const owned = [...Object.keys(values), ...Object.keys(governance)].sort();
  const schema = Object.keys(columns).sort();
  if (JSON.stringify(owned) !== JSON.stringify(schema))
    throw new Error("Workflow retention must classify every run and step column exactly once");
}

// Derive detection from the same assignments that clear values. Adding a field cannot
// leave it undetected on a step without an output, including a cancelled code attempt.
const hasStepValue = or(
  ...Object.entries(getTableColumns(workflowStepRuns)).flatMap(([key, column]) => {
    const reset = Object.entries(stepValues).find(([field]) => field === key)?.[1];
    return reset ? [sql`${column} is distinct from (${reset})`] : [];
  })
);

export function workflowRetention(
  db: PostgresConnection
): Pick<
  WorkflowRunsStore,
  "listRunsWithDataEndedBefore" | "pruneStepRunData" | "markRunDataPruned"
> {
  assertColumns(getTableColumns(workflowRuns), runValues, runGovernance);
  assertColumns(getTableColumns(workflowStepRuns), stepValues, stepGovernance);
  return {
    async listRunsWithDataEndedBefore(input) {
      const pending = and(
        eq(workflowRuns.clientInstanceId, input.clientInstanceId),
        sql`${workflowRuns.dataPruneVersion} < ${sql.raw(String(WORKFLOW_RETENTION_VERSION))}`,
        isNotNull(workflowRuns.finishedAt),
        inArray(workflowRuns.status, [...WORKFLOW_ENDED_STATUSES])
      );
      // Separate indexed ranges: an empty repair pass must not walk every recent run.
      // Each side reads at most one batch; merge only those bounded candidates.
      const candidates = await Promise.all(
        [
          isNotNull(workflowRuns.dataPrunedAt),
          and(
            isNull(workflowRuns.dataPrunedAt),
            lt(workflowRuns.finishedAt, new Date(input.endedBefore))
          )
        ].map((due) =>
          db
            .select({ id: workflowRuns.id, finishedAt: workflowRuns.finishedAt })
            .from(workflowRuns)
            .where(and(pending, due))
            .orderBy(asc(workflowRuns.finishedAt), asc(workflowRuns.id))
            .limit(input.limit)
        )
      );
      return candidates
        .flat()
        .sort(
          (a, b) =>
            (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0) ||
            a.id.localeCompare(b.id)
        )
        .slice(0, input.limit)
        .map((row) => row.id);
    },
    async pruneStepRunData(ref) {
      const due = db
        .select({ id: workflowStepRuns.id })
        .from(workflowStepRuns)
        .where(
          and(
            eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
            eq(workflowStepRuns.runId, ref.id),
            hasStepValue
          )
        )
        .orderBy(asc(workflowStepRuns.createdAt), asc(workflowStepRuns.id))
        .limit(ref.limit);
      const pruned = await db
        .update(workflowStepRuns)
        .set(stepValues)
        // The second predicate is checked again under the row lock if two sweeps meet.
        .where(and(inArray(workflowStepRuns.id, due), hasStepValue))
        .returning({ id: workflowStepRuns.id });
      return pruned.length;
    },
    async markRunDataPruned(ref) {
      return db.transaction(async (tx) => {
        const remaining = tx
          .select({ id: workflowStepRuns.id })
          .from(workflowStepRuns)
          .where(
            and(
              eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
              eq(workflowStepRuns.runId, ref.id),
              hasStepValue
            )
          );
        const marked = await tx
          .update(workflowRuns)
          .set({
            ...runValues,
            // Preserve when values first expired, including when repairing an older prune.
            dataPrunedAt: sql`coalesce(${workflowRuns.dataPrunedAt}, ${ref.prunedAt}::timestamptz)`,
            dataPruneVersion: WORKFLOW_RETENTION_VERSION
          })
          .where(
            and(
              runIs(ref),
              sql`${workflowRuns.dataPruneVersion} < ${sql.raw(String(WORKFLOW_RETENTION_VERSION))}`,
              inArray(workflowRuns.status, [...WORKFLOW_ENDED_STATUSES]),
              notExists(remaining)
            )
          )
          .returning({ id: workflowRuns.id });
        if (marked.length > 0) {
          const threads = tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.clientInstanceId, ref.clientInstanceId),
                eq(conversations.workflowRunId, ref.id)
              )
            );
          await tx
            .update(messages)
            .set({ text: "", metadata: {} })
            .where(inArray(messages.conversationId, threads));
          await tx
            .delete(agentRunObservations)
            .where(inArray(agentRunObservations.conversationId, threads));
          await tx
            .delete(modelProviderContinuations)
            .where(inArray(modelProviderContinuations.conversationId, threads));
          await tx
            .delete(modelProviderTurnContinuations)
            .where(inArray(modelProviderTurnContinuations.conversationId, threads));
          await tx
            .update(agentRuns)
            .set({ resumeState: null })
            .where(inArray(agentRuns.conversationId, threads));
          // The copies of the run's files its agents got: the attachment handlers removed their
          // bytes and marked their rows deleted before this, and the rows go now, with their
          // names and what was prepared from them. A row not marked still names bytes no
          // handler removed and stays, so they can be found.
          await tx
            .delete(managedArtifacts)
            .where(
              and(
                eq(managedArtifacts.clientInstanceId, ref.clientInstanceId),
                inArray(managedArtifacts.conversationId, threads),
                eq(managedArtifacts.status, "deleted")
              )
            );
          const copies = await tx
            .delete(conversationAttachments)
            .where(
              and(
                eq(conversationAttachments.clientInstanceId, ref.clientInstanceId),
                inArray(conversationAttachments.conversationId, threads),
                eq(conversationAttachments.status, "deleted")
              )
            )
            .returning({ fileId: conversationAttachments.fileId });
          if (copies.length > 0)
            await tx.delete(managedFiles).where(
              and(
                eq(managedFiles.clientInstanceId, ref.clientInstanceId),
                inArray(managedFiles.id, [...new Set(copies.map((copy) => copy.fileId))]),
                eq(managedFiles.status, "deleted"),
                isNull(managedFiles.ownerKind),
                // A file another conversation still names is not only this run's.
                notExists(
                  tx
                    .select({ id: conversationAttachments.id })
                    .from(conversationAttachments)
                    .where(
                      and(
                        eq(conversationAttachments.clientInstanceId, ref.clientInstanceId),
                        eq(conversationAttachments.fileId, managedFiles.id)
                      )
                    )
                ),
                notExists(
                  tx
                    .select({ id: managedArtifacts.id })
                    .from(managedArtifacts)
                    .where(
                      and(
                        eq(managedArtifacts.clientInstanceId, ref.clientInstanceId),
                        eq(managedArtifacts.sourceFileId, managedFiles.id)
                      )
                    )
                )
              )
            );
          // Copies no handler removed, as where none is configured: their bytes stay, named by
          // object key, size and sha256 so they can be found; their names and what was read
          // from them go.
          const otherConversation = (fileId: SQL | AnyColumn) =>
            tx
              .select({ id: conversationAttachments.id })
              .from(conversationAttachments)
              .where(
                and(
                  eq(conversationAttachments.clientInstanceId, ref.clientInstanceId),
                  eq(conversationAttachments.fileId, fileId),
                  notInArray(conversationAttachments.conversationId, threads)
                )
              );
          const kept = await tx
            .update(conversationAttachments)
            .set({
              filename: sql`${conversationAttachments.id}`,
              processingMetadata: {},
              warnings: [],
              error: onlyKeys(conversationAttachments.error, ["code"])
            })
            .where(
              and(
                eq(conversationAttachments.clientInstanceId, ref.clientInstanceId),
                inArray(conversationAttachments.conversationId, threads)
              )
            )
            .returning({ fileId: conversationAttachments.fileId });
          const prepared = await tx
            .update(managedArtifacts)
            .set({ filename: null, metadata: {} })
            .where(
              and(
                eq(managedArtifacts.clientInstanceId, ref.clientInstanceId),
                inArray(managedArtifacts.conversationId, threads)
              )
            )
            .returning({ fileId: managedArtifacts.sourceFileId });
          const keptFiles = [
            ...new Set(
              [...kept, ...prepared].flatMap((row) => (row.fileId === null ? [] : [row.fileId]))
            )
          ];
          if (keptFiles.length > 0)
            await tx
              .update(managedFiles)
              .set({ filename: sql`${managedFiles.id}` })
              .where(
                and(
                  eq(managedFiles.clientInstanceId, ref.clientInstanceId),
                  inArray(managedFiles.id, keptFiles),
                  isNull(managedFiles.ownerKind),
                  notExists(otherConversation(managedFiles.id)),
                  notExists(
                    tx
                      .select({ id: managedArtifacts.id })
                      .from(managedArtifacts)
                      .where(
                        and(
                          eq(managedArtifacts.clientInstanceId, ref.clientInstanceId),
                          eq(managedArtifacts.sourceFileId, managedFiles.id),
                          notInArray(managedArtifacts.conversationId, threads)
                        )
                      )
                  )
                )
              );
          // What the run's ended calls answered goes; a read keeps only its counts. These are the
          // calls its threads' agents made and those of its own steps (origin `workflow`). The
          // calls stay for their audit age with ids, status, hashes and sizes, and their
          // decisions and denials without a comment, a call still running included. A running
          // call keeps its output, the recovery marker of a paged read. What a call or decision
          // writes after this keeps no more (`postgres-pruned-run`).
          const ownCalls = tx
            .select({ id: operationRuns.id })
            .from(operationRuns)
            .where(
              and(
                eq(operationRuns.clientInstanceId, ref.clientInstanceId),
                eq(operationRuns.originKind, "workflow"),
                sql`${operationRuns.origin}->>'workflowRunId' = ${ref.id}`
              )
            );
          await tx
            .update(operationRuns)
            .set({
              output: sql`case when ${operationRuns.effect} = 'reading' or ${operationRuns.status} = 'running'
                then ${operationRuns.output} end`,
              decision: sql`${operationRuns.decision} - 'comment'`,
              // A declined call's denial names who declined it, not what they wrote.
              error: sql`${operationRuns.error} #- '{denial,comment}'`
            })
            .where(
              and(
                eq(operationRuns.clientInstanceId, ref.clientInstanceId),
                or(
                  and(
                    isNotNull(operationRuns.conversationId),
                    inArray(operationRuns.conversationId, threads)
                  ),
                  inArray(operationRuns.id, ownCalls)
                )
              )
            );
          // The requests of a thread, or of a call of the run's steps.
          const ofRun = and(
            eq(approvalRequests.clientInstanceId, ref.clientInstanceId),
            or(
              inArray(sql`${approvalRequests.origin}->>'conversationId'`, threads),
              inArray(sql`${approvalRequests.payload}->>'runId'`, ownCalls)
            )
          );
          // A settled request keeps who decided and when. One that held a call keeps which call
          // it was and what came of it; its input and sign-in context go. Another kind's payload,
          // such as a skill change, is the asset change it applied and stays. A request still
          // pending, or approved and not yet carried out, needs its input: the path that ends it
          // minimizes it then.
          const settled = and(
            ofRun,
            ne(approvalRequests.status, "pending"),
            sql`coalesce(${approvalRequests.applyResult}->>'execution', '') <> 'queued'`
          );
          // A held call's request names its call, whether it was the confirmation or the
          // approval that followed it.
          const heldCall = exists(
            tx
              .select({ id: operationRuns.id })
              .from(operationRuns)
              .where(
                and(
                  eq(operationRuns.clientInstanceId, ref.clientInstanceId),
                  eq(operationRuns.id, sql`${approvalRequests.payload}->>'runId'`)
                )
              )
          );
          await tx
            .update(approvalRequests)
            .set({
              payload: minimizedHeldCall,
              applyResult: minimizedHeldCallResult(approvalRequests.applyResult)
            })
            .where(and(settled, heldCall));
          // No request keeps the decider's comment, one whose call has yet to run included: the
          // call runs without it.
          await tx
            .update(approvalRequests)
            .set({ decision: sql`${approvalRequests.decision} - 'comment'` })
            .where(and(ofRun, sql`${approvalRequests.decision} ? 'comment'`));
        }
        return marked.length > 0;
      });
    }
  };
}
