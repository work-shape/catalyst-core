import type {
  JsonValue,
  OperationRegistry,
  WorkflowManifest,
  WorkflowRun,
  WorkflowStepRun
} from "@work-shape/catalyst-core";
import { jsonObjectSchema } from "./json";
import { rowSchemaOf, schemaAt } from "./dataset-schema";
import { datasetId, type WorkflowDatasets } from "./datasets";
import { WorkflowStepFailure } from "./step-failure";

/** Replaces only the named list, so bulk rows reach no step or Operation Run record. */
export async function operationDatasetCapture(input: {
  datasets: WorkflowDatasets;
  registry: OperationRegistry;
  operation: string;
  at: string;
  run: WorkflowRun;
  stepRun: WorkflowStepRun;
  manifest: WorkflowManifest;
  signal: AbortSignal;
}) {
  const definition = await input.registry.resolve(input.operation);
  const schema = schemaAt(jsonObjectSchema.parse(definition?.outputJsonSchema ?? {}), input.at);
  const rowSchema = rowSchemaOf(
    jsonObjectSchema.parse(schema?.items ?? { type: "object" }),
    input.manifest.types
  );
  const configured = jsonObjectSchema.safeParse(input.manifest).data?.limits;
  const workflowLimits = jsonObjectSchema.safeParse(configured).data;
  return async (answer: unknown): Promise<JsonValue> => {
    if (answer === null || typeof answer !== "object" || Array.isArray(answer))
      throw new WorkflowStepFailure("dataset_path_invalid", "The dataset path names no list");
    const output: Record<string, unknown> = { ...answer };
    let object = output;
    const parts = input.at.split(".");
    for (const [index, part] of parts.entries()) {
      const field = object[part];
      if (index === parts.length - 1) {
        // An idempotently replayed changing call already carries its reference.
        if (
          field &&
          !Array.isArray(field) &&
          typeof field === "object" &&
          "$dataset" in field &&
          field.$dataset === datasetId(input.stepRun.id, input.at)
        )
          return jsonObjectSchema.parse(output);
        if (!Array.isArray(field))
          throw new WorkflowStepFailure("dataset_path_invalid", "The dataset path names no list");
        async function* rows() {
          yield* Array.isArray(field) ? field : [];
        }
        object[part] = {
          ...(await input.datasets.write({
            run: input.run,
            stepRun: input.stepRun,
            field: input.at,
            rowSchema,
            rows: rows(),
            signal: input.signal,
            // EW-LIM owns the field; the writer only lowers the operator ceiling.
            ...(typeof workflowLimits?.datasetBytes === "number"
              ? { maxBytes: workflowLimits.datasetBytes }
              : {})
          }))
        };
      } else {
        if (
          field === null ||
          typeof field !== "object" ||
          Array.isArray(field) ||
          part === "__proto__" ||
          part === "constructor" ||
          part === "prototype"
        )
          throw new WorkflowStepFailure("dataset_path_invalid", "The dataset path names no list");
        const copy: Record<string, unknown> = { ...field };
        object[part] = copy;
        object = copy;
      }
    }
    return jsonObjectSchema.parse(output);
  };
}
