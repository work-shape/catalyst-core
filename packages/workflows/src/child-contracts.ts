import { compileJsonSchema } from "@work-shape/catalyst-connections";
import { AppError, type JsonObject, type WorkflowManifest } from "@work-shape/catalyst-core";
import { z } from "zod";
import { indexWorkflowSteps } from "./definition";
import type { WorkflowDefinitionSource } from "./definition-source";
import { jsonObjectSchema, holdsDatasetReference } from "./json";

const fieldsSchema = z.object({
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  additionalProperties: z.unknown().optional()
});

/** Read the published child's contract at save; no schema is copied into a step. */
export async function checkChildContracts(
  manifest: WorkflowManifest,
  definitions: Pick<WorkflowDefinitionSource, "read">
): Promise<void> {
  const outputs = new Map<string, JsonObject>();
  const inputs = new Map<string, JsonObject>();
  const steps = indexWorkflowSteps(manifest);
  for (const { step } of steps.values()) {
    if (step.type !== "workflow") continue;
    const child = await definitions.read(step.workflow);
    if (!child)
      throw new AppError(
        "VALIDATION_FAILED",
        `The child Workflow '${step.workflow}' has no published revision`,
        { reason: "child_unpublished" }
      );
    outputs.set(step.id, child.manifest.outputs);
    inputs.set(step.id, child.manifest.inputs);
    const fields = fieldsSchema.parse(child.manifest.inputs);
    for (const required of fields.required ?? []) {
      if (!Object.hasOwn(step.input, required))
        throw new AppError("VALIDATION_FAILED", `The child input mapping omits '${required}'`, {
          reason: "child_input_invalid"
        });
    }
    for (const [field, source] of Object.entries(step.input)) {
      if (source.value !== undefined && holdsDatasetReference(source.value))
        throw new AppError("VALIDATION_FAILED", "Child datasets are not supported yet", {
          reason: "not_supported_yet"
        });
      if (fields.additionalProperties === false && !Object.hasOwn(fields.properties ?? {}, field))
        throw new AppError("VALIDATION_FAILED", `The child input does not declare '${field}'`, {
          reason: "child_input_invalid"
        });
      const property = fields.properties?.[field];
      const schema = jsonObjectSchema.safeParse(property);
      if (source.value !== undefined && schema.success) {
        const compiled = compileJsonSchema(schema.data);
        if (!compiled.ok || compiled.validate(source.value).length)
          throw new AppError(
            "VALIDATION_FAILED",
            `The literal for '${field}' does not fit the child's inputs`,
            { reason: "child_input_invalid" }
          );
      }
    }
    if (
      !compileJsonSchema(child.manifest.inputs).ok ||
      !compileJsonSchema(child.manifest.outputs).ok
    )
      throw new AppError("VALIDATION_FAILED", "The child contract cannot be checked", {
        reason: "child_schema_invalid"
      });
  }
  for (const { step } of steps.values()) {
    if (!("input" in step)) continue;
    for (const [field, source] of Object.entries(step.input)) {
      if (!source.ref) continue;
      let schema = outputs.get(source.ref.step);
      if (!schema) continue;
      for (const part of source.ref.path.split(".").filter(Boolean)) {
        const fields = fieldsSchema.parse(schema);
        const property = fields.properties?.[part];
        if (property === undefined && fields.additionalProperties === false) {
          throw new AppError(
            "VALIDATION_FAILED",
            "The reference names no field of the child's outputs",
            { reason: "child_output_invalid" }
          );
        }
        schema = jsonObjectSchema.safeParse(property).data;
        if (!schema) break;
      }
      const target = fieldsSchema.safeParse(inputs.get(step.id)).data?.properties?.[field];
      const shape = z.object({ type: z.string() });
      const from = shape.safeParse(schema);
      const to = shape.safeParse(target);
      if (
        from.success &&
        to.success &&
        from.data.type !== to.data.type &&
        !(from.data.type === "integer" && to.data.type === "number")
      ) {
        throw new AppError(
          "VALIDATION_FAILED",
          "The child's output type does not fit the next child's input",
          { reason: "child_input_invalid" }
        );
      }
    }
  }
}

/** Follow published edges, replacing this Workflow's live revision with the candidate. */
export async function checkChildCycles(
  manifest: WorkflowManifest,
  definitions: Pick<WorkflowDefinitionSource, "read">
): Promise<void> {
  const visited = new Set<string>();
  async function visit(current: WorkflowManifest): Promise<void> {
    for (const { step } of indexWorkflowSteps(current).values()) {
      if (step.type !== "workflow") continue;
      if (step.workflow === manifest.id)
        throw new AppError(
          "VALIDATION_FAILED",
          "Publishing this Workflow would make it reach itself",
          { reason: "workflow_cycle" }
        );
      if (visited.has(step.workflow)) continue;
      visited.add(step.workflow);
      const child = await definitions.read(step.workflow);
      if (child) await visit(child.manifest);
    }
  }
  await visit(manifest);
}
