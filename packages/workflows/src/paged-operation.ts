import {
  AppError,
  WORKFLOW_PAGING_DEFAULTS,
  WORKFLOW_STEP_JOB_LEASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
  CONNECTION_TRANSIENT_CALL_REASONS,
  JobDeferredError,
  operationPagingSchema,
  type JsonObject,
  type JsonValue,
  type OperationCallRuntime,
  type OperationPaging,
  type WorkflowManifest,
  type WorkflowStep,
  type OperationRunId,
  type OperationRunStore,
  type WorkflowRun,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { datasetReferences } from "./dataset-schema";
import { rowSchemaOf, schemaAt } from "./dataset-schema";
import { datasetReference, type WorkflowDatasets } from "./datasets";
import { jsonObjectSchema } from "./json";
import { WORKFLOW_STEP_DATA_MAX_BYTES, WORKFLOW_STEP_JOB_MAX_ATTEMPTS } from "./limits";
import { WorkflowStepFailure } from "./step-failure";

type OperationStep = Extract<WorkflowStep, { type: "operation" }>;

const checkpointSchema = z.object({
  next: jsonObjectSchema,
  first: jsonObjectSchema.optional(),
  pages: z.number().int().nonnegative(),
  done: z.boolean(),
  pageAddress: z.string().optional()
});

function at(value: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const part of path.split(".")) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, part)
    )
      return undefined;
    current = current[part];
  }
  return current;
}
function replace(value: JsonObject, path: string, replacement: JsonValue): JsonObject {
  const [head, ...rest] = path.split(".");
  if (!head || ["__proto__", "constructor", "prototype"].includes(head))
    throw new WorkflowStepFailure("dataset_path_invalid", "The dataset path names no list");
  return {
    ...value,
    [head]: rest.length
      ? replace(jsonObjectSchema.parse(value[head]), rest.join("."), replacement)
      : replacement
  };
}
function limit(name: string): never {
  throw new WorkflowStepFailure("dataset_limit", `The dataset reached '${name}'`);
}

/** One page in memory, one durable part per answer, one authorized Operation Run. */
export async function pagedOperation(input: {
  datasets: WorkflowDatasets;
  operationRuns: OperationRunStore;
  pagedStepMinutes: number;
  paging: OperationPaging;
  progressTimeoutMs: number;
  step: OperationStep;
  outputSchema: JsonObject;
  run: WorkflowRun;
  stepRun: WorkflowStepRun;
  manifest: WorkflowManifest;
  args: JsonObject;
  signal: AbortSignal;
  now(): Date;
  noteOperationRun(id: OperationRunId): Promise<void>;
}): Promise<Pick<OperationCallRuntime, "readPages" | "pageCounts" | "resumeReadingRunId">> {
  const { datasets, step, paging } = input;
  if (!step.dataset) throw new WorkflowStepFailure("paging_invalid", "paginate needs dataset.at");
  const field = step.dataset.at;
  const list = schemaAt(input.outputSchema, field);
  const rowSchema = rowSchemaOf(
    jsonObjectSchema.parse(list?.items ?? { type: "object" }),
    input.manifest.types
  );
  const saved = await datasets.writing(input.stepRun, field);
  const last = saved?.parts.at(-1)?.checkpoint;
  const checkpoint = last ? checkpointSchema.parse(last) : undefined;
  let next: JsonObject = checkpoint?.next ?? { ...input.args };
  if (!checkpoint && (paging.by === "page" || paging.by === "offset")) {
    next[paging.param] = paging.start ?? (paging.by === "page" ? 1 : 0);
    next[paging.sizeParam] = paging.size;
  }
  let first = saved?.parts[0]?.checkpoint
    ? checkpointSchema.parse(saved.parts[0].checkpoint).first
    : undefined;
  let done = checkpoint?.done ?? false;
  let pageAddress = checkpoint?.pageAddress;
  const counts = {
    pages: checkpoint?.pages ?? 0,
    rows: saved?.rowCount ?? 0,
    bytes: (saved?.bytes ?? 0) - (saved?.pendingPart?.bytes ?? 0)
  };
  const configured = jsonObjectSchema.safeParse(jsonObjectSchema.parse(input.manifest).limits).data;
  if (
    typeof configured?.pagedStepMinutes === "number" &&
    configured.pagedStepMinutes > input.pagedStepMinutes
  )
    throw new WorkflowStepFailure(
      "paging_invalid",
      "pagedStepMinutes exceeds the operator ceiling"
    );
  const minutes = Math.min(
    input.pagedStepMinutes,
    typeof configured?.pagedStepMinutes === "number"
      ? configured.pagedStepMinutes
      : WORKFLOW_PAGING_DEFAULTS.pagedStepMinutes
  );
  // startedAt survives a lost lease and a deferred page, but excludes the slot queue.
  const deadline =
    Date.parse(input.stepRun.startedAt ?? input.now().toISOString()) + minutes * 60_000;
  // Leave time for lease recovery before the sweep ends an abandoned paged read.
  const progressTimeoutMs = Math.max(input.progressTimeoutMs, 2 * WORKFLOW_STEP_JOB_LEASE_MS);
  const check = () => {
    input.signal.throwIfAborted();
    if (input.now().getTime() >= deadline) limit("pagedStepMinutes");
  };
  // A sweep may already have interrupted a deferred call at this deadline. Report
  // the step's own limit before trying to resume that call.
  if (!done) check();
  return {
    pageCounts: counts,
    ...(input.stepRun.operationRunId ? { resumeReadingRunId: input.stepRun.operationRunId } : {}),
    async readPages(page, runId) {
      await input.noteOperationRun(runId);
      const previous = await input.operationRuns.get({
        clientInstanceId: input.run.clientInstanceId,
        id: runId
      });
      const progress = jsonObjectSchema.safeParse(previous?.output?.value).data;
      let pageAttempts =
        progress?.pages === counts.pages && typeof progress.pageAttempts === "number"
          ? progress.pageAttempts
          : 0;
      const recordProgress = async (deferMs = 0) => {
        input.signal.throwIfAborted();
        if (
          !(await input.operationRuns.checkpointReading({
            clientInstanceId: input.run.clientInstanceId,
            id: runId,
            ...counts,
            pageAttempts,
            deadlineAt: new Date(deadline).toISOString(),
            recoverAfter: new Date(
              Math.min(deadline, input.now().getTime() + deferMs + progressTimeoutMs)
            ).toISOString()
          }))
        )
          throw new WorkflowStepFailure(
            "operation_interrupted",
            "The paged operation is no longer running"
          );
      };
      if (!done) await recordProgress();
      while (!done) {
        check();
        if (counts.pages >= (datasets.limits.pages ?? WORKFLOW_PAGING_DEFAULTS.pages))
          limit("pages");
        let answer: unknown;
        for (;;) {
          if (pageAttempts >= WORKFLOW_STEP_JOB_MAX_ATTEMPTS)
            throw new WorkflowStepFailure(
              "operation_page_failed",
              "The page failed after three attempts"
            );
          try {
            const signal = AbortSignal.timeout(Math.max(1, deadline - input.now().getTime()));
            answer = await page(
              next,
              paging.by === "next_link" && counts.pages > 0
                ? String(next[paging.param])
                : undefined,
              signal,
              {
                ...(pageAddress ? { previous: pageAddress } : {}),
                resolved: (address) => {
                  pageAddress = address;
                }
              }
            );
            break;
          } catch (error) {
            check();
            const details =
              error instanceof AppError
                ? jsonObjectSchema.safeParse(error.details).data
                : undefined;
            const transient =
              error instanceof AppError &&
              (error.code === "RATE_LIMITED" ||
                error.code === "TIMEOUT" ||
                error.code === "INTERNAL" ||
                [...CONNECTION_TRANSIENT_CALL_REASONS].some(
                  (reason) => reason === details?.reason
                ));
            if (
              transient &&
              (error.code === "RATE_LIMITED" || typeof details?.retryAfterSeconds === "number")
            ) {
              const delayMs = Math.min(
                deadline - input.now().getTime(),
                typeof details?.retryAfterSeconds === "number"
                  ? details.retryAfterSeconds * 1000
                  : WORKFLOW_STEP_JOB_BACKOFF_BASE_MS
              );
              await recordProgress(delayMs);
              throw new JobDeferredError(delayMs);
            }
            if (transient) {
              pageAttempts += 1;
              const delayMs = Math.min(
                WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
                WORKFLOW_STEP_JOB_BACKOFF_BASE_MS * 2 ** (pageAttempts - 1),
                deadline - input.now().getTime()
              );
              await recordProgress(delayMs);
              if (pageAttempts < WORKFLOW_STEP_JOB_MAX_ATTEMPTS)
                throw new JobDeferredError(delayMs);
              continue;
            }
            throw error;
          }
        }
        check();
        if (
          Buffer.byteLength(JSON.stringify(answer) ?? "") >
          (datasets.limits.pageBytes ?? WORKFLOW_PAGING_DEFAULTS.pageBytes)
        )
          limit("pageBytes");
        const object = jsonObjectSchema.parse(answer);
        for (const ref of datasetReferences(object))
          await datasets.reader({ id: ref.$dataset, runId: input.run.id });
        const rows = at(object, field);
        if (!Array.isArray(rows))
          throw new WorkflowStepFailure("dataset_path_invalid", "The dataset path names no list");
        first ??= replace(object, field, null);
        if (Buffer.byteLength(JSON.stringify(first)) > WORKFLOW_STEP_DATA_MAX_BYTES)
          throw new WorkflowStepFailure(
            "step_data_too_large",
            "The first page's metadata exceeds the step data limit"
          );
        if (paging.by === "page" || paging.by === "offset") {
          done = rows.length < paging.size;
          const position = next[paging.param];
          if (typeof position !== "number" || !Number.isSafeInteger(position))
            throw new WorkflowStepFailure("paging_invalid", "The page position is not an integer");
          next = { ...next, [paging.param]: position + (paging.by === "page" ? 1 : rows.length) };
        } else if ("cursor" in paging) {
          const cursor = at(object, paging.cursor);
          done = cursor === undefined || cursor === null || cursor === "";
          if (!done && typeof cursor !== "string" && typeof cursor !== "number")
            throw new WorkflowStepFailure(
              "paging_invalid",
              "The page continuation must be a string or number"
            );
          if (!done && cursor === next[paging.param])
            throw new WorkflowStepFailure(
              "paging_repeated_cursor",
              "The page continuation did not advance"
            );
          if (!done) next = { ...next, [paging.param]: cursor ?? null };
        }
        // First-page metadata may contain a continuation. It stays in the dataset record only.
        const reference = await datasets.write({
          run: input.run,
          stepRun: input.stepRun,
          field,
          rowSchema,
          rows: (async function* () {
            yield* rows;
          })(),
          signal: input.signal,
          ...(typeof configured?.datasetBytes === "number"
            ? { maxBytes: configured.datasetBytes }
            : {}),
          page: {
            next,
            ...(counts.pages === 0 ? { first } : {}),
            pages: counts.pages + 1,
            done,
            ...(pageAddress ? { pageAddress } : {})
          }
        });
        counts.pages += 1;
        counts.rows = reference.rowCount;
        counts.bytes = reference.bytes;
        pageAttempts = 0;
        await recordProgress();
      }
      const record = await datasets.writing(input.stepRun, field);
      if (!record || !first)
        throw new WorkflowStepFailure("dataset_expired", "The dataset has expired");
      return replace(first, field, { ...datasetReference(record) });
    }
  };
}

export function resolvedPaging(
  base: OperationPaging | undefined,
  override: OperationStep["paginate"]
): OperationPaging {
  const by = override === true ? base?.by : (override?.by ?? base?.by);
  const compatibleBase =
    base && "cursor" in base === (by === "cursor" || by === "next_link")
      ? base
      : base
        ? { by, param: base.param }
        : {};
  return operationPagingSchema.parse({ ...compatibleBase, ...(override === true ? {} : override) });
}
