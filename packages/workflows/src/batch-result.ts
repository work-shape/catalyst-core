import { operationBatchResultSchema, type JsonValue } from "@work-shape/catalyst-core";

/** Partial item failures are success; a malformed aggregate is not. Extra operation counts fit. */
export function batchResultError(output: JsonValue) {
  const batch = operationBatchResultSchema.strip().safeParse(output);
  if (!batch.success || batch.data.failed !== batch.data.failures.rowCount)
    return {
      code: "batch_result_invalid",
      message:
        "The batch result needs done, failed and a failures dataset with one row per failed item"
    };
  return undefined;
}
