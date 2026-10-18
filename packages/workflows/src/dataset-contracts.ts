import {
  AppError,
  type JsonObject,
  type OperationRegistry,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import { resolvedPaging } from "./paged-operation";
import type { WorkflowDefinitionSource } from "./definition-source";
import { indexWorkflowSteps } from "./definition";
import { jsonObjectSchema } from "./json";
import { rowSchemaOf, schemaAt, schemaFits } from "./dataset-schema";

/** Structural dataset compatibility, using the same contracts at save, publish and start. */
export async function checkDatasetContracts(
  manifest: WorkflowManifest,
  definitions: Pick<WorkflowDefinitionSource, "read">,
  registry?: Pick<OperationRegistry, "resolve">
): Promise<void> {
  const outputs = new Map<string, JsonObject>();
  const inputs = new Map<string, JsonObject>();
  function expanded(schema: JsonObject, types: WorkflowManifest["types"]): JsonObject {
    if (schema.type === "dataset")
      return { ...schema, row: rowSchemaOf(jsonObjectSchema.parse(schema.row), types) };
    const properties = jsonObjectSchema.safeParse(schema.properties).data;
    return properties
      ? {
          ...schema,
          properties: Object.fromEntries(
            Object.entries(properties).map(([key, value]) => [
              key,
              expanded(jsonObjectSchema.parse(value), types)
            ])
          )
        }
      : schema;
  }
  function replace(schema: JsonObject, at: string, row: JsonObject): JsonObject {
    const [head, ...rest] = at.split(".");
    if (!head) return { type: "dataset", row };
    const props = jsonObjectSchema.safeParse(schema.properties).data ?? {};
    const child = jsonObjectSchema.safeParse(props[head]).data ?? {};
    return {
      ...schema,
      properties: {
        ...props,
        [head]: rest.length ? replace(child, rest.join("."), row) : { type: "dataset", row }
      }
    };
  }
  for (const { step } of indexWorkflowSteps(manifest).values()) {
    if (step.type === "trigger")
      outputs.set(step.id, {
        type: "object",
        properties: { input: expanded(manifest.inputs, manifest.types) }
      });
    if (step.type === "operation" && registry) {
      const descriptor = await registry.resolve(step.operation);
      if (!descriptor) {
        if (step.paginate)
          throw new AppError("VALIDATION_FAILED", "The paged operation does not exist", {
            reason: "paging_invalid"
          });
        continue;
      }
      if (step.paginate) {
        let validPaging = false;
        try {
          resolvedPaging(descriptor.paging, step.paginate);
          validPaging = true;
        } catch {
          /* Refuse below without storing schema errors or input values. */
        }
        if (
          !descriptor.paging ||
          descriptor.effect !== "reading" ||
          !step.dataset ||
          descriptor.streams ||
          !validPaging
        )
          throw new AppError(
            "VALIDATION_FAILED",
            "paginate needs a reading operation with paging and dataset.at",
            { reason: "paging_invalid" }
          );
      }
      inputs.set(
        step.id,
        expanded(jsonObjectSchema.parse(descriptor.inputJsonSchema ?? {}), manifest.types)
      );
      let output = expanded(
        jsonObjectSchema.parse(descriptor.outputJsonSchema ?? {}),
        manifest.types
      );
      if (step.dataset) {
        const list = schemaAt(output, step.dataset.at);
        if (list && list.type !== "array")
          throw new AppError(
            "VALIDATION_FAILED",
            "dataset.at must name a list in the operation output",
            { reason: "dataset_schema_invalid" }
          );
        output = replace(
          output,
          step.dataset.at,
          jsonObjectSchema.parse(list?.items ?? { type: "object" })
        );
      }
      outputs.set(step.id, output);
    }
    if (step.type === "workflow") {
      const child = await definitions.read(step.workflow);
      if (child) {
        inputs.set(step.id, expanded(child.manifest.inputs, child.manifest.types));
        outputs.set(step.id, expanded(child.manifest.outputs, child.manifest.types));
      }
    }
    if (step.type === "code" || step.type === "agent") {
      inputs.set(step.id, expanded(step.inputSchema, manifest.types));
      outputs.set(step.id, expanded(step.outputSchema, manifest.types));
    }
    if (step.type === "output") inputs.set(step.id, expanded(manifest.outputs, manifest.types));
    if (step.type === "loop") {
      const source = outputs.get(step.items.step);
      const shape = source ? schemaAt(source, step.items.path) : undefined;
      if (shape?.type === "dataset") outputs.set(step.id, jsonObjectSchema.parse(shape.row));
      else if (shape?.type === "array")
        outputs.set(step.id, jsonObjectSchema.parse(shape.items ?? {}));
    }
    if (!("input" in step)) continue;
    for (const [field, mapping] of Object.entries(step.input)) {
      const to = schemaAt(inputs.get(step.id) ?? {}, field);
      if (!to || !mapping.ref) continue;
      const source = outputs.get(mapping.ref.step);
      const from = source ? schemaAt(source, mapping.ref.path) : undefined;
      if (
        to.type === "dataset" &&
        from &&
        (from.type !== "dataset" ||
          !schemaFits(jsonObjectSchema.parse(from.row), jsonObjectSchema.parse(to.row)))
      )
        throw new AppError("VALIDATION_FAILED", `The dataset row does not fit input '${field}'`, {
          reason: "dataset_schema_invalid"
        });
      if (from?.type === "dataset" && (step.type === "code" || step.type === "agent"))
        throw new AppError("VALIDATION_FAILED", "Datasets in code and agent inputs require EW-14", {
          reason: "not_supported_yet"
        });
    }
  }
}
