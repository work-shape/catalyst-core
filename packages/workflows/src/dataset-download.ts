import {
  AppError,
  isAuthenticatedServicePrincipal,
  auditActorFromIdentity,
  type WorkflowDatasetDownloadFormat,
  type ActorAccess,
  type AuthenticatedIdentity,
  type JsonObject
} from "@work-shape/catalyst-core";
import { WorkflowStepFailure } from "./step-failure";
import { datasetReferences } from "./dataset-schema";
import { createWorkflowDatasets, type WorkflowDatasetsOptions } from "./datasets";

/** Result membership and rights are checked together; a dataset id is never a bearer token. */
export function createDatasetDownload(options: WorkflowDatasetsOptions) {
  const datasets = createWorkflowDatasets(options);
  return async (input: {
    runId: string;
    datasetId: string;
    format: WorkflowDatasetDownloadFormat;
    actor: AuthenticatedIdentity;
    access: ActorAccess;
    correlationId: string;
    signal?: AbortSignal;
  }) => {
    const { stores, clientInstanceId } = options;
    const run = await stores.workflowRuns.readRun({ clientInstanceId, id: input.runId });
    const output =
      run && (await stores.workflowRuns.readRunOutput({ clientInstanceId, id: run.id }));
    const references = output
      ? datasetReferences(output.value).filter((ref) => ref.$dataset === input.datasetId)
      : [];
    if (!run || !output || references.length === 0)
      throw new AppError("NOT_FOUND", "There is no such result dataset");
    const starter =
      run.startedBy.kind ===
        (isAuthenticatedServicePrincipal(input.actor) ? "service_principal" : "user") &&
      run.startedBy.id === input.actor.id;
    const asset = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "workflow",
      name: run.workflow
    });
    if (!starter)
      input.access.require("workflow.read_run_data", {
        kind: "workflow",
        name: run.workflow,
        ...(asset ? { assetId: asset.id } : {})
      });
    // A result can carry a forged reference only if dispatch checks were missed. Keep this
    // final check even for the starter: the result grants no access the run never held.
    const reference = references.find((ref) => ref.offset === undefined);
    // A result may return several disjoint views of one parent. Download their union.
    const ranges = reference
      ? [reference]
      : references.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
    const reader = await datasets
      .reader({
        id: input.datasetId,
        runId: run.id,
        reference: ranges[0],
        ...(input.signal ? { signal: input.signal } : {})
      })
      .catch((error: unknown) => {
        if (error instanceof WorkflowStepFailure)
          throw new AppError(
            error.code === "FORBIDDEN" ? "FORBIDDEN" : "NOT_FOUND",
            error.message,
            { reason: error.code }
          );
        throw error;
      });
    const record = await stores.workflowRunDatasets.get({ clientInstanceId, id: input.datasetId });
    if (!record)
      throw new AppError("NOT_FOUND", "The dataset has expired", { reason: "dataset_expired" });
    const metadata = {
      runId: run.id,
      stepRunId: record.stepRunId,
      datasetId: record.id,
      rowCount: record.rowCount,
      bytes: record.bytes
    };
    const runId = run.id;
    async function* resultRows() {
      let end = 0;
      for (const reference of ranges) {
        const start = reference.offset ?? 0;
        const skip = Math.max(0, end - start);
        const next = await datasets.reader({
          id: input.datasetId,
          runId,
          reference,
          offset: skip,
          ...(input.signal ? { signal: input.signal } : {})
        });
        for await (const row of next.rows) yield row;
        end = Math.max(end, start + reference.rowCount);
      }
    }
    async function* body() {
      let columns: string[] | undefined;
      let rowCount = 0,
        bytes = 0;
      for await (const row of resultRows()) {
        input.signal?.throwIfAborted();
        rowCount++;
        bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (input.format === "jsonl") yield `${JSON.stringify(row)}\n`;
        else {
          if (!columns) {
            const properties = reader.rowSchema.properties;
            columns = [
              ...new Set([
                ...(properties && typeof properties === "object" && !Array.isArray(properties)
                  ? Object.keys(properties)
                  : []),
                ...Object.keys(row)
              ])
            ];
            yield columns.map(csvCell).join(",") + "\r\n";
          }
          const fields = columns;
          if (Object.keys(row).some((key) => !fields.includes(key)))
            throw new AppError(
              "VALIDATION_FAILED",
              "CSV rows have different fields; download JSON Lines to preserve every field"
            );
          yield columns.map((column) => csvCell(csvValue(row[column]))).join(",") + "\r\n";
        }
      }
      await stores.audit.appendAuditEvent({
        clientInstanceId,
        type: "workflow_run.dataset_downloaded",
        status: "success",
        actor: auditActorFromIdentity(input.actor),
        subject: input.datasetId,
        correlationId: input.correlationId,
        metadata: { ...metadata, rowCount, bytes }
      });
    }
    return {
      filename: `${input.datasetId}.${input.format}`,
      contentType: input.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
      body: body()
    };
  };
}
function csvValue(value: JsonObject[string] | undefined): string {
  return value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}
function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
