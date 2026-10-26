import { WORKFLOW_RETENTION_VERSION } from "./workflow-retention-version";
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  lt,
  notExists,
  or,
  isNull,
  sql,
  type SQL
} from "drizzle-orm";
import { WORKFLOW_ENDED_STATUSES, type WorkflowRunsStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { runIs } from "./postgres-workflow-run-mapping";
import {
  conversationAttachments,
  conversations,
  managedArtifacts,
  managedFiles,
  messages,
  agentRunObservations,
  agentRuns,
  modelProviderContinuations,
  modelProviderTurnContinuations
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
  // Names of the App, its revision and its action: governance, not a value of the run.
  startedFrom: true,
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
                inArray(managedArtifacts.conversationId, threads),
                eq(managedArtifacts.status, "deleted")
              )
            );
          const copies = await tx
            .delete(conversationAttachments)
            .where(
              and(
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
                    .where(eq(conversationAttachments.fileId, managedFiles.id))
                ),
                notExists(
                  tx
                    .select({ id: managedArtifacts.id })
                    .from(managedArtifacts)
                    .where(eq(managedArtifacts.sourceFileId, managedFiles.id))
                )
              )
            );
        }
        return marked.length > 0;
      });
    }
  };
}
