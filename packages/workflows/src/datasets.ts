import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import { compileJsonSchema } from "@work-shape/catalyst-connections";
import {
  AppError,
  ObjectNotFound,
  WORKFLOW_RUN_OBJECT_PREFIX,
  type ActorAccess,
  type ClientInstanceId,
  type JsonObject,
  type JsonValue,
  type ObjectStorage,
  type PlatformStores,
  type WorkflowDatasetLimits,
  type WorkflowDatasetReference,
  type WorkflowRun,
  type WorkflowRunDataset,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import { jsonObjectSchema } from "./json";
import { WorkflowStepFailure } from "./step-failure";

// A part bounds memory independently of dataset size. It is a checkpoint, not a customer cap.
const DATASET_PART_BYTES = 4 * 1024 * 1024;

export interface WorkflowDatasetsOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  objects: ObjectStorage;
  limits: WorkflowDatasetLimits;
}
export type WorkflowDatasets = ReturnType<typeof createWorkflowDatasets>;
export const datasetPrefix = (row: Pick<WorkflowRunDataset, "runId" | "id">) =>
  `${WORKFLOW_RUN_OBJECT_PREFIX}${row.runId}/${row.id}/`;
export const datasetId = (stepRunId: WorkflowStepRun["id"], field: string) =>
  `wfd_${createHash("sha256").update(`${stepRunId}:${field}`).digest("hex").slice(0, 32)}`;
export const datasetReference = (row: WorkflowRunDataset): WorkflowDatasetReference => ({
  $dataset: row.id,
  rowCount: row.rowCount,
  bytes: row.bytes
});
function datasetExpired(): WorkflowStepFailure {
  return new WorkflowStepFailure("dataset_expired", "The dataset has expired");
}

/**
 * Where in a row a schema issue lies, by position only: the place of each field among the
 * fields of its object and the place of each item in its list, counted from 1. A row's keys
 * may be data as much as its values, so an error that is stored names neither.
 */
function rowPosition(row: JsonValue, path: readonly string[]): string {
  const places: string[] = [];
  let at: JsonValue | undefined = row;
  for (const segment of path) {
    if (Array.isArray(at)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) break;
      places.push(`item ${String(index + 1)}`);
      at = at[index];
    } else if (at !== null && typeof at === "object") {
      const index = Object.keys(at).indexOf(segment);
      if (index === -1) break;
      places.push(`field ${String(index + 1)}`);
      at = at[segment];
    } else break;
  }
  return places.length ? ` at ${places.join(", ")}` : "";
}

/** The only transport of dataset rows. Buffers at most a part and one row, never a dataset. */
export function createWorkflowDatasets(options: WorkflowDatasetsOptions) {
  const { clientInstanceId, stores, objects, limits } = options;
  async function write(input: {
    run: WorkflowRun;
    stepRun: WorkflowStepRun;
    field: string;
    rowSchema: JsonObject;
    rows: AsyncIterable<unknown>;
    signal?: AbortSignal;
    maxBytes?: number;
    transaction?: PlatformStores;
    /** Append one whole page; even an empty final page advances the durable position. */
    page?: JsonObject;
  }): Promise<WorkflowDatasetReference> {
    const stores = input.transaction ?? options.stores;
    const id = datasetId(input.stepRun.id, input.field);
    let record = await stores.workflowRunDatasets.create({
      id,
      clientInstanceId,
      runId: input.run.id,
      stepRunId: input.stepRun.id,
      field: input.field,
      rowSchema: input.rowSchema
    });
    if (record.state === "complete") return datasetReference(record);
    const compiled = compileJsonSchema(record.rowSchema);
    if (!compiled.ok)
      throw new WorkflowStepFailure(
        "dataset_schema_invalid",
        "The dataset row schema cannot be checked"
      );
    let line = 0,
      index = input.page ? record.parts.length : 0,
      bytes = 0;
    let rows: Buffer[] = [];
    const checkpoint = [...record.parts];
    async function flush() {
      if (!rows.length && !input.page) return;
      const body = Buffer.concat(rows, bytes);
      const hash = createHash("sha256").update(body).digest("hex");
      const part = {
        key: `${datasetPrefix(record)}${String(index).padStart(8, "0")}.jsonl.gz`,
        rows: rows.length,
        bytes,
        hash,
        ...(input.page ? { checkpoint: input.page } : {})
      };
      const kept = checkpoint[index];
      if (kept) {
        if (kept.hash !== hash || kept.rows !== rows.length)
          throw new WorkflowStepFailure(
            "dataset_retry_changed",
            "The dataset retry differs from its complete part"
          );
      } else {
        try {
          // The upload and checkpoint hold the same dataset lock as cleanup. A late put
          // cannot recreate an object after a cancellation's prefix cleanup has completed.
          await stores.workflowRunDatasets.reservePart({
            clientInstanceId,
            id: record.id,
            index,
            part,
            limits: { ...limits, bytes: Math.min(limits.bytes, input.maxBytes ?? limits.bytes) }
          });
          await stores.transaction(async (tx) => {
            const current = await tx.workflowRunDatasets.lock({ clientInstanceId, id: record.id });
            if (
              current?.state !== "writing" ||
              current.parts.length !== index ||
              current.pendingPart?.hash !== part.hash
            )
              throw datasetExpired();
            input.signal?.throwIfAborted();
            const compressed = gzipSync(body);
            await objects.put(part.key, compressed, { contentType: "application/gzip" });
            await tx.workflowRunDatasets.commitPart({ clientInstanceId, id: record.id, index });
          });
        } catch (error) {
          if (error instanceof AppError) {
            const details = jsonObjectSchema.safeParse(error.details).data;
            if (details?.reason === "dataset_limit")
              throw new WorkflowStepFailure(
                "dataset_limit",
                `The dataset reached '${String(details.limit)}'`
              );
            if (details?.reason === "dataset_retry_changed")
              throw new WorkflowStepFailure(
                "dataset_retry_changed",
                "The dataset retry differs from its pending part"
              );
            if (details?.reason === "dataset_expired") throw datasetExpired();
          }
          throw error;
        }
      }
      index += 1;
      rows = [];
      bytes = 0;
    }
    for await (const candidate of input.rows) {
      input.signal?.throwIfAborted();
      line += 1;
      const encoded = JSON.stringify(candidate);
      if (encoded === undefined || Buffer.byteLength(encoded) + 1 > limits.rowBytes)
        throw new WorkflowStepFailure(
          "dataset_limit",
          `The dataset reached 'rowBytes' at line ${line}`
        );
      const row = jsonObjectSchema.safeParse(candidate);
      const issue = row.success ? compiled.validate(row.data)[0] : undefined;
      if (!row.success || issue)
        throw new WorkflowStepFailure(
          "dataset_row_invalid",
          `Dataset line ${line} does not fit its row schema${issue && row.success ? rowPosition(row.data, issue.path) : ""}`
        );
      const data = Buffer.from(`${encoded}\n`);
      if (!input.page && bytes + data.length > DATASET_PART_BYTES) await flush();
      rows.push(data);
      bytes += data.length;
    }
    await flush();
    if (index < checkpoint.length)
      throw new WorkflowStepFailure(
        "dataset_retry_changed",
        "The dataset retry ended before its complete parts"
      );
    record = (await stores.workflowRunDatasets.get({ clientInstanceId, id: record.id })) ?? record;
    return datasetReference(record);
  }

  async function metadata(id: string): Promise<WorkflowRunDataset> {
    const row = await stores.workflowRunDatasets.get({ clientInstanceId, id });
    if (!row || row.state !== "complete") throw datasetExpired();
    return row;
  }

  /** The caller receives a reader bound to exactly one authorized dataset. No bearer id lookup. */
  async function reader(input: {
    id: string;
    runId?: string;
    access?: ActorAccess;
    offset?: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{ rowSchema: JsonObject; rows: AsyncIterable<JsonObject> }> {
    const row = await metadata(input.id);
    if (input.runId) {
      const readerRun = await stores.workflowRuns.readRun({ clientInstanceId, id: input.runId });
      if (!readerRun)
        throw new WorkflowStepFailure("FORBIDDEN", "This run cannot read the dataset", {
          systemic: true
        });
      if (
        !(await stores.workflowRunDatasets.canRead({
          clientInstanceId,
          id: row.id,
          runId: readerRun.id
        }))
      )
        throw new WorkflowStepFailure("FORBIDDEN", "This run cannot read the dataset", {
          systemic: true
        });
    } else {
      if (!input.access)
        throw new AppError("FORBIDDEN", "Dataset rows need workflow.read_run_data");
      const run = await stores.workflowRuns.readRun({ clientInstanceId, id: row.runId });
      if (!run) throw datasetExpired();
      const asset = await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "workflow",
        name: run.workflow
      });
      input.access.require("workflow.read_run_data", {
        kind: "workflow",
        name: run.workflow,
        ...(asset ? { assetId: asset.id } : {})
      });
    }
    async function* rows(): AsyncIterable<JsonObject> {
      let skip = input.offset ?? 0,
        left = input.limit ?? Infinity;
      for (const part of row.parts) {
        input.signal?.throwIfAborted();
        if (left <= 0) return;
        if (skip >= part.rows) {
          skip -= part.rows;
          continue;
        }
        // Recheck on every part: cancelling/deleting a run revokes an already-created reader.
        const current = await metadata(row.id);
        if (current.state !== "complete") throw datasetExpired();
        try {
          const object = await objects.get(part.key);
          const source = Readable.from(object.body);
          const stream = source.pipe(createGunzip());
          let pending = Buffer.alloc(0),
            count = 0,
            size = 0;
          const hash = createHash("sha256");
          try {
            const chunks: AsyncIterable<unknown> = stream;
            for await (const chunk of chunks) {
              input.signal?.throwIfAborted();
              if (!(chunk instanceof Uint8Array)) throw datasetExpired();
              const data = Buffer.from(chunk);
              hash.update(data);
              size += data.length;
              if (size > part.bytes) throw datasetExpired();
              pending = Buffer.concat([pending, data]);
              let end = pending.indexOf(10);
              while (end !== -1) {
                if (end + 1 > limits.rowBytes) throw datasetExpired();
                const value: unknown = JSON.parse(pending.subarray(0, end).toString("utf8"));
                const parsed = jsonObjectSchema.safeParse(value);
                if (!parsed.success) throw datasetExpired();
                count += 1;
                if (skip > 0) skip -= 1;
                else {
                  left -= 1;
                  yield parsed.data;
                  if (left <= 0) return;
                }
                pending = pending.subarray(end + 1);
                end = pending.indexOf(10);
              }
              if (pending.length > limits.rowBytes) throw datasetExpired();
            }
            if (
              pending.length ||
              count !== part.rows ||
              size !== part.bytes ||
              hash.digest("hex") !== part.hash
            )
              throw datasetExpired();
          } finally {
            stream.destroy();
            source.destroy();
          }
        } catch (error) {
          if (error instanceof ObjectNotFound || error instanceof SyntaxError)
            throw datasetExpired();
          throw error;
        }
      }
    }
    return { rowSchema: row.rowSchema, rows: rows() };
  }
  async function writing(stepRun: WorkflowStepRun, field: string) {
    return stores.workflowRunDatasets.get({ clientInstanceId, id: datasetId(stepRun.id, field) });
  }
  return { write, reader, metadata, writing, limits };
}
