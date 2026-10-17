import {
  type JsonObject,
  type JsonValue,
  type WorkflowManifest,
  type WorkflowRun
} from "@work-shape/catalyst-core";
import type { WorkflowDatasets } from "./datasets";
import { rowSchemaOf, schemaFits } from "./dataset-schema";
import { jsonObjectSchema } from "./json";
import { WorkflowStepFailure } from "./step-failure";

/** Validate actual row types and ownership, rather than trusting counts in a supplied ref. */
export async function checkDatasetValues(
  value: JsonValue,
  schema: JsonObject,
  manifest: WorkflowManifest,
  runId: WorkflowRun["id"],
  datasets: WorkflowDatasets
): Promise<void> {
  await checkDatasetSchemas(value, schema, manifest, async (id) => {
    await datasets.reader({ id, runId });
    return (await datasets.metadata(id)).rowSchema;
  });
}

/** The same structural check for a start's transaction-bound metadata reads. */
export async function checkDatasetSchemas(
  value: JsonValue,
  schema: JsonObject,
  manifest: WorkflowManifest,
  rowSchemaFor: (id: string) => Promise<JsonObject>
): Promise<void> {
  if (schema.type === "dataset") {
    const reference = jsonObjectSchema.safeParse(value).data;
    if (typeof reference?.$dataset !== "string")
      throw new WorkflowStepFailure(
        "dataset_reference_invalid",
        "The input holds no dataset reference"
      );
    const rowSchema = await rowSchemaFor(reference.$dataset);
    if (!schemaFits(rowSchema, rowSchemaOf(jsonObjectSchema.parse(schema.row), manifest.types)))
      throw new WorkflowStepFailure(
        "dataset_schema_invalid",
        "The dataset row does not fit the input schema"
      );
    return;
  }
  if (Array.isArray(value)) {
    const itemSchema = jsonObjectSchema.safeParse(schema.items).data;
    if (itemSchema)
      for (const item of value) await checkDatasetSchemas(item, itemSchema, manifest, rowSchemaFor);
  } else if (value && typeof value === "object") {
    const properties = jsonObjectSchema.safeParse(schema.properties).data;
    if (properties)
      for (const [field, child] of Object.entries(value)) {
        const childSchema = jsonObjectSchema.safeParse(properties[field]).data;
        if (childSchema) await checkDatasetSchemas(child, childSchema, manifest, rowSchemaFor);
      }
  }
}

export const loopFailureRowSchema: JsonObject = {
  type: "object",
  properties: { index: { type: "integer" }, label: { type: "string" }, code: { type: "string" } },
  required: ["index", "code"]
};
