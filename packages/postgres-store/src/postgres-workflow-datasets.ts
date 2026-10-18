import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  AppError,
  type WorkflowRunDataset,
  type WorkflowRunDatasetsStore,
  type WorkflowDatasetRef
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import {
  workflowRunDatasets as datasets,
  workflowDatasetUsage as usage,
  workflowDatasetReaders as readers
} from "./schema/workflowDatasets";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";

type Row = typeof datasets.$inferSelect;
function mapped(row: Row): WorkflowRunDataset {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    runId: row.runId,
    stepRunId: row.stepRunId,
    field: row.field,
    rowSchema: row.rowSchema,
    rowCount: row.rowCount,
    bytes: row.bytes,
    parts: row.parts,
    state: row.state,
    ...(row.pendingPart ? { pendingPart: row.pendingPart } : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(row.deletedAt ? { deletedAt: row.deletedAt.toISOString() } : {}),
    ...(row.cleanedAt ? { cleanedAt: row.cleanedAt.toISOString() } : {})
  };
}
const is = (ref: WorkflowDatasetRef) =>
  and(eq(datasets.clientInstanceId, ref.clientInstanceId), eq(datasets.id, ref.id));
const expired = () =>
  new AppError("NOT_FOUND", "The dataset has expired", { reason: "dataset_expired" });
const limitError = (limit: string) =>
  new AppError("VALIDATION_FAILED", `The dataset reached '${limit}'`, {
    reason: "dataset_limit",
    limit
  });

export function createPostgresWorkflowRunDatasetsStore(
  db: PostgresConnection
): WorkflowRunDatasetsStore {
  return {
    async create(input) {
      return db.transaction(async (tx) => {
        // All writers and endings take the run, then step, then dataset, then byte counters.
        const [run] = await tx
          .select()
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.clientInstanceId, input.clientInstanceId),
              eq(workflowRuns.id, input.runId)
            )
          )
          .for("update");
        const [step] = await tx
          .select()
          .from(workflowStepRuns)
          .where(
            and(
              eq(workflowStepRuns.clientInstanceId, input.clientInstanceId),
              eq(workflowStepRuns.id, input.stepRunId),
              eq(workflowStepRuns.runId, input.runId)
            )
          )
          .for("update");
        if (
          !run ||
          !step ||
          !["queued", "running", "waiting"].includes(run.status) ||
          !["running", "waiting"].includes(step.status)
        )
          throw expired();
        await tx.insert(datasets).values(input).onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(datasets)
          .where(
            and(
              eq(datasets.clientInstanceId, input.clientInstanceId),
              eq(datasets.stepRunId, input.stepRunId),
              eq(datasets.field, input.field)
            )
          );
        if (!row || row.state === "deleted") throw expired();
        return mapped(row);
      });
    },
    async listForSteps(input) {
      return input.stepRunIds.length
        ? (
            await db
              .select()
              .from(datasets)
              .where(
                and(
                  eq(datasets.clientInstanceId, input.clientInstanceId),
                  inArray(datasets.stepRunId, input.stepRunIds)
                )
              )
          ).map(mapped)
        : [];
    },
    async getMany(input) {
      return input.ids.length
        ? (
            await db
              .select()
              .from(datasets)
              .where(
                and(
                  eq(datasets.clientInstanceId, input.clientInstanceId),
                  inArray(datasets.id, input.ids)
                )
              )
          ).map(mapped)
        : [];
    },
    async lock(ref) {
      const [row] = await db.select().from(datasets).where(is(ref)).for("update");
      return row ? mapped(row) : undefined;
    },
    async get(ref) {
      const [row] = await db.select().from(datasets).where(is(ref));
      if (!row) return undefined;
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now() && row.state !== "deleted") {
        const [hold] = await db
          .select({ runId: readers.runId })
          .from(readers)
          .where(
            and(
              eq(readers.clientInstanceId, ref.clientInstanceId),
              eq(readers.datasetId, ref.id),
              or(isNull(readers.expiresAt), gt(readers.expiresAt, new Date()))
            )
          )
          .limit(1);
        if (!hold) return { ...mapped(row), state: "deleted" };
      }
      return mapped(row);
    },
    async listForRun(input) {
      return (
        await db
          .select()
          .from(datasets)
          .where(
            and(
              eq(datasets.clientInstanceId, input.clientInstanceId),
              eq(datasets.runId, input.runId),
              input.after ? gt(datasets.id, input.after) : undefined
            )
          )
          .orderBy(asc(datasets.id))
          .limit(input.limit)
      ).map(mapped);
    },
    async reservePart(input) {
      await db.transaction(async (tx) => {
        const found = await createPostgresWorkflowRunDatasetsStore(tx).get(input);
        if (!found) throw expired();
        const [run] = await tx
          .select({ status: workflowRuns.status })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.clientInstanceId, input.clientInstanceId),
              eq(workflowRuns.id, found.runId)
            )
          )
          .for("update");
        await tx
          .select({ id: workflowStepRuns.id })
          .from(workflowStepRuns)
          .where(eq(workflowStepRuns.id, found.stepRunId))
          .for("update");
        const [row] = await tx.select().from(datasets).where(is(input)).for("update");
        if (
          !run ||
          !["queued", "running", "waiting"].includes(run.status) ||
          !row ||
          row.state !== "writing"
        )
          throw expired();
        if (input.index !== row.parts.length)
          throw new AppError("CONFLICT", "The dataset checkpoint changed");
        // A source may change between pages. Until the checkpoint commits, that page
        // can be replaced; a nonpaged stream must replay its reserved part exactly.
        const replacePendingPage =
          row.pendingPart?.checkpoint !== undefined && input.part.checkpoint !== undefined;
        if (row.pendingPart) {
          if (
            !replacePendingPage &&
            (row.pendingPart.hash !== input.part.hash || row.pendingPart.bytes !== input.part.bytes)
          )
            throw new AppError("CONFLICT", "The dataset retry differs from its checkpoint", {
              reason: "dataset_retry_changed"
            });
          if (!replacePendingPage) return;
        }
        // Bytes include the reservation; replacing a page charges only its difference.
        const byteDelta = input.part.bytes - (row.pendingPart?.bytes ?? 0);
        if (row.rowCount + input.part.rows > input.limits.rows) throw limitError("rows");
        if (row.bytes + byteDelta > input.limits.bytes) throw limitError("bytes");
        // Stable order across every writer. Only this very short reservation locks the instance.
        for (const [scope, ceiling, name] of [
          ["instance", input.limits.instanceBytes, "instanceBytes"],
          [`run:${row.runId}`, input.limits.runBytes, "runBytes"]
        ] as const) {
          await tx
            .insert(usage)
            .values({ clientInstanceId: input.clientInstanceId, scope })
            .onConflictDoNothing();
          const [counter] = await tx
            .select()
            .from(usage)
            .where(and(eq(usage.clientInstanceId, input.clientInstanceId), eq(usage.scope, scope)))
            .for("update");
          if (!counter || counter.bytes + byteDelta > ceiling) throw limitError(name);
          await tx
            .update(usage)
            .set({ bytes: sql`${usage.bytes} + ${byteDelta}` })
            .where(and(eq(usage.clientInstanceId, input.clientInstanceId), eq(usage.scope, scope)));
        }
        await tx
          .update(datasets)
          .set({ pendingPart: input.part, bytes: row.bytes + byteDelta })
          .where(is(input));
      });
    },
    async commitPart(input) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(datasets).where(is(input)).for("update");
        if (!row || row.state !== "writing") throw expired();
        if (input.index < row.parts.length) return;
        if (input.index !== row.parts.length || !row.pendingPart)
          throw new AppError("CONFLICT", "The dataset has no reserved part");
        await tx
          .update(datasets)
          .set({
            parts: [...row.parts, row.pendingPart],
            rowCount: row.rowCount + row.pendingPart.rows,
            pendingPart: null
          })
          .where(is(input));
      });
    },
    async completeStep(input) {
      // Called after ending the step, within the same transaction, while its row is locked.
      const rows = await db
        .update(datasets)
        .set({ state: "complete" })
        .where(
          and(
            eq(datasets.clientInstanceId, input.clientInstanceId),
            eq(datasets.stepRunId, input.stepRunId),
            eq(datasets.state, "writing"),
            isNull(datasets.pendingPart),
            sql`exists (select 1 from ${workflowStepRuns} where ${workflowStepRuns.clientInstanceId} = ${input.clientInstanceId} and ${workflowStepRuns.id} = ${input.stepRunId} and ${workflowStepRuns.status} = 'done')`
          )
        )
        .returning();
      return rows.map(mapped);
    },
    async allowRun(input) {
      await db.transaction(async (tx) => {
        const store = createPostgresWorkflowRunDatasetsStore(tx);
        await store.lock(input);
        const row = await store.get(input);
        if (!row || row.state !== "complete") throw expired();
        await tx
          .insert(readers)
          .values({
            clientInstanceId: input.clientInstanceId,
            datasetId: input.id,
            runId: input.runId
          })
          .onConflictDoNothing();
      });
    },
    async canRead(input) {
      const [row] = await db
        .select({ id: datasets.id })
        .from(datasets)
        .where(
          and(
            is(input),
            eq(datasets.state, "complete"),
            or(
              eq(datasets.runId, input.runId),
              sql`exists (select 1 from ${readers} where ${readers.clientInstanceId} = ${input.clientInstanceId} and ${readers.datasetId} = ${input.id} and ${readers.runId} = ${input.runId})`
            )
          )
        );
      return row !== undefined;
    },
    async finishRun(input) {
      const expiry = new Date(input.expiresAt);
      await db
        .update(readers)
        .set({ expiresAt: !input.test && input.resume ? expiry : new Date(0) })
        .where(
          and(eq(readers.clientInstanceId, input.clientInstanceId), eq(readers.runId, input.runId))
        );
      if (!input.test && input.keep.length)
        await db
          .update(readers)
          .set({ expiresAt: expiry })
          .where(
            and(
              eq(readers.clientInstanceId, input.clientInstanceId),
              eq(readers.runId, input.runId),
              inArray(readers.datasetId, input.keep)
            )
          );
      await db
        .update(datasets)
        .set({ expiresAt: input.test ? new Date(0) : input.resume ? expiry : new Date(0) })
        .where(
          and(
            eq(datasets.clientInstanceId, input.clientInstanceId),
            eq(datasets.runId, input.runId),
            sql`${datasets.state} != 'deleted'`
          )
        );
      if (!input.test && input.keep.length)
        await db
          .update(datasets)
          .set({ expiresAt: expiry })
          .where(
            and(
              eq(datasets.clientInstanceId, input.clientInstanceId),
              eq(datasets.runId, input.runId),
              sql`${datasets.id} in ${input.keep}`
            )
          );
    },
    async claimExpired(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(datasets)
          .where(
            and(
              eq(datasets.clientInstanceId, input.clientInstanceId),
              isNull(datasets.cleanedAt),
              lte(datasets.expiresAt, new Date(input.now)),
              or(
                eq(datasets.state, "deleted"),
                sql`not exists (select 1 from ${readers} where ${readers.clientInstanceId} = ${datasets.clientInstanceId} and ${readers.datasetId} = ${datasets.id} and (${readers.expiresAt} is null or ${readers.expiresAt} > ${input.now}))`
              )
            )
          )
          .orderBy(asc(datasets.expiresAt), asc(datasets.id))
          .limit(input.limit)
          .for("update");
        const claimed: WorkflowRunDataset[] = [];
        for (const row of rows) {
          if (row.state !== "deleted") {
            // A grant can have committed while this statement waited for the row lock.
            // Re-read holds in a new statement, with that lock still held.
            const [hold] = await tx
              .select({ runId: readers.runId })
              .from(readers)
              .where(
                and(
                  eq(readers.clientInstanceId, input.clientInstanceId),
                  eq(readers.datasetId, row.id),
                  or(isNull(readers.expiresAt), gt(readers.expiresAt, new Date(input.now)))
                )
              )
              .limit(1);
            if (hold) continue;
            await tx
              .update(datasets)
              .set({ state: "deleted", deletedAt: new Date(input.now) })
              .where(is({ clientInstanceId: input.clientInstanceId, id: row.id }));
          }
          claimed.push(
            mapped({ ...row, state: "deleted", deletedAt: row.deletedAt ?? new Date(input.now) })
          );
        }
        return claimed;
      });
    },
    async claimRun(input) {
      // Root deletion also takes descendants; no dataset FK may erase its cleanup record.
      await db
        .delete(readers)
        .where(
          and(
            eq(readers.clientInstanceId, input.clientInstanceId),
            or(
              eq(readers.runId, input.runId),
              sql`${readers.runId} in (select id from ${workflowRuns} where ${workflowRuns.clientInstanceId} = ${input.clientInstanceId} and ${workflowRuns.rootRunId} = ${input.runId})`
            )
          )
        );
      await db
        .update(datasets)
        .set({ state: "deleted", deletedAt: new Date(), expiresAt: new Date(0) })
        .where(
          and(
            eq(datasets.clientInstanceId, input.clientInstanceId),
            or(
              eq(datasets.runId, input.runId),
              sql`${datasets.runId} in (select id from ${workflowRuns} where ${workflowRuns.clientInstanceId} = ${input.clientInstanceId} and ${workflowRuns.rootRunId} = ${input.runId})`
            )
          )
        );
    },
    async claimWorkflow(input) {
      await db
        .delete(readers)
        .where(
          and(
            eq(readers.clientInstanceId, input.clientInstanceId),
            sql`${readers.runId} in (select id from ${workflowRuns} where ${workflowRuns.clientInstanceId} = ${input.clientInstanceId} and (${workflowRuns.workflow} = ${input.workflow} or ${workflowRuns.rootRunId} in (select id from workflow_runs where client_instance_id = ${input.clientInstanceId} and workflow = ${input.workflow})))`
          )
        );
      await db
        .update(datasets)
        .set({ state: "deleted", deletedAt: new Date(), expiresAt: new Date(0) })
        .where(
          and(
            eq(datasets.clientInstanceId, input.clientInstanceId),
            sql`${datasets.runId} in (select id from ${workflowRuns} where ${workflowRuns.clientInstanceId} = ${input.clientInstanceId} and (${workflowRuns.workflow} = ${input.workflow} or ${workflowRuns.rootRunId} in (select id from workflow_runs where client_instance_id = ${input.clientInstanceId} and workflow = ${input.workflow})))`
          )
        );
    },
    async markCleaned(ref) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(datasets).where(is(ref)).for("update");
        if (!row || row.state !== "deleted" || row.cleanedAt) return;
        for (const scope of ["instance", `run:${row.runId}`])
          await tx
            .update(usage)
            .set({ bytes: sql`${usage.bytes} - ${row.bytes}` })
            .where(and(eq(usage.clientInstanceId, ref.clientInstanceId), eq(usage.scope, scope)));
        await tx
          .delete(usage)
          .where(
            and(
              eq(usage.clientInstanceId, ref.clientInstanceId),
              eq(usage.scope, `run:${row.runId}`),
              eq(usage.bytes, 0)
            )
          );
        await tx
          .delete(readers)
          .where(
            and(eq(readers.clientInstanceId, ref.clientInstanceId), eq(readers.datasetId, ref.id))
          );
        await tx
          .update(datasets)
          .set({ cleanedAt: new Date(ref.at) })
          .where(is(ref));
      });
    }
  };
}
