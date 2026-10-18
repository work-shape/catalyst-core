import {
  unknownToJsonValue,
  type JsonValue,
  type AuditRecorder,
  type OperationRunId
} from "@work-shape/catalyst-core";

/** Kept operation output is bounded independently of dataset rows. */
const OPERATION_RUN_OUTPUT_MAX_BYTES = 256 * 1_024;

/** The answer as the run keeps it, or nothing when it is larger than a run may hold. */
export function retainedOutput(output: unknown): { value: JsonValue } | undefined {
  const value = unknownToJsonValue(output);
  return Buffer.byteLength(JSON.stringify(value)) <= OPERATION_RUN_OUTPUT_MAX_BYTES
    ? { value }
    : undefined;
}

/** Audit rows written inside a call name its run and share its correlation id. */
export function auditForRun(
  audit: AuditRecorder,
  operationRunId: OperationRunId,
  correlationId: string
): AuditRecorder {
  return {
    record: (input) =>
      audit.record({
        ...input,
        correlationId,
        metadata: { ...input.metadata, operationRunId }
      })
  };
}
