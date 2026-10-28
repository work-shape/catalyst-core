import { z } from "zod";
import {
  AppError,
  operationBatchFailureSchema,
  type JsonObject,
  type OperationDefinition,
  type OperationRegistry,
  type WorkflowInputText,
  type WorkflowInputValue,
  type WorkflowManifest,
  type WorkflowReference,
  type WorkflowStep
} from "@work-shape/catalyst-core";
import { resolvedPaging } from "./paged-operation";
import type { WorkflowDefinitionSource } from "./definition-source";
import { indexWorkflowSteps } from "./definition";
import { jsonObjectSchema } from "./json";
import { rowSchemaOf, schemaAt, schemaFits } from "./dataset-schema";
import { loopFailureRowSchema } from "./dataset-values";
import { WORKFLOW_TEXT_PART_INVALID, isMarkdownField, textPartSchemaIssue } from "./text-join";

/**
 * The schemas of a definition's steps: each step's input schema, and the schema of what a
 * reference from a step names. An operation is read from the registry and a child from its
 * published revision; a step whose schema is not known has none.
 */
export interface WorkflowStepSchemas {
  input(step: string): JsonObject | undefined;
  /** The schema of the field a reference names, read from the place of the step that reads. */
  reference(reader: string, reference: WorkflowReference): JsonObject | undefined;
}

/** Structural dataset compatibility, using the same contracts at save, publish and start. */
export async function checkDatasetContracts(
  manifest: WorkflowManifest,
  definitions: Pick<WorkflowDefinitionSource, "read">,
  registry?: Pick<OperationRegistry, "resolve">
): Promise<void> {
  const schemas = await workflowStepSchemas(manifest, definitions, registry);
  for (const { step } of indexWorkflowSteps(manifest).values()) {
    for (const [field, mapping] of mappedFields(step)) {
      if (mapping.text) {
        checkTextMapping(step.id, field, mapping, schemas);
        continue;
      }
      const to = schemaAt(schemas.input(step.id) ?? {}, field);
      if (!("input" in step) || !to || !mapping.ref) continue;
      const from = schemas.reference(step.id, mapping.ref);
      if (
        to?.type === "dataset" &&
        from &&
        (from.type !== "dataset" ||
          !schemaFits(jsonObjectSchema.parse(from.row), jsonObjectSchema.parse(to.row)))
      )
        throw new AppError("VALIDATION_FAILED", `The dataset row does not fit input '${field}'`, {
          reason: "dataset_schema_invalid"
        });
      if (from?.type === "dataset" && step.type === "agent")
        throw new AppError("VALIDATION_FAILED", "Datasets in agent inputs require EW-14b", {
          reason: "not_supported_yet"
        });
    }
  }
}

/** The fields of a step that take a literal, a reference or a text. */
function mappedFields(step: WorkflowStep): [string, WorkflowInputValue][] {
  if (step.type === "notify")
    return [
      ["title", step.title],
      ["text", step.text]
    ];
  return "input" in step ? Object.entries(step.input) : [];
}

/** Whether a field's schema admits a string: by its type, or by one of its alternatives. */
function takesText(schema: JsonObject): boolean {
  if (schema.type !== undefined) return [schema.type].flat().includes("string");
  const options = [schema.anyOf, schema.oneOf].find(Array.isArray);
  return options
    ? options.some((option) => {
        const read = jsonObjectSchema.safeParse(option);
        return !read.success || takesText(read.data);
      })
    : true;
}

/** Whether a reference's path names a field its source's schema declares, where it says. */
function declaresPath(source: JsonObject, path: string): boolean {
  let schema: JsonObject | undefined = source;
  for (const part of path.split(".").filter(Boolean)) {
    if (!schema) return true;
    const properties: JsonObject | undefined = jsonObjectSchema.safeParse(schema.properties).data;
    if (properties && Object.hasOwn(properties, part)) {
      schema = jsonObjectSchema.safeParse(properties[part]).data;
      continue;
    }
    // Only a schema that closes its fields says that a field is missing.
    if (schema.additionalProperties === false) return false;
    schema = undefined;
  }
  return true;
}

/**
 * The reference check of each part of a text (EW-TEXT): the field is a string, and each
 * referenced part names a declared field whose value joins as text. A refusal names the step,
 * the field and the part.
 */
function checkTextMapping(
  step: string,
  field: string,
  mapping: WorkflowInputText,
  schemas: WorkflowStepSchemas
): void {
  const refuse = (message: string, part?: number) => {
    throw new AppError("VALIDATION_FAILED", message, {
      reason: WORKFLOW_TEXT_PART_INVALID,
      step,
      field,
      ...(part === undefined ? {} : { part })
    });
  };
  const input = schemas.input(step);
  const target = input ? schemaAt(input, field) : undefined;
  if (target && !takesText(target))
    refuse(
      `Step '${step}': the field '${field}' is no text, so it takes no text joined from parts`
    );
  const markdown = isMarkdownField(target);
  mapping.text.forEach((part, position) => {
    if (typeof part === "string") return;
    const number = position + 1;
    const named = part.ref.path === "" ? part.ref.step : `${part.ref.step}.${part.ref.path}`;
    const source = schemas.reference(step, { step: part.ref.step, path: "" });
    if (source && !declaresPath(source, part.ref.path))
      refuse(
        `Step '${step}', field '${field}', part ${number}: '${named}' names no field of that step's output`,
        number
      );
    const issue = textPartSchemaIssue(schemas.reference(step, part.ref), markdown);
    if (issue) refuse(`Step '${step}', field '${field}', part ${number} ${issue}`, number);
  });
}

/**
 * An operation's input as JSON Schema: the one it was described by, else the one its
 * `inputSchema` derives, as every reader of an operation takes it. A release operation such as
 * `mail.send` carries its Zod schema alone, and the `format: markdown` of its body is what
 * makes a joined text escape its values.
 */
function inputJsonSchemaOf(
  descriptor: Pick<OperationDefinition, "inputJsonSchema" | "inputSchema">
): JsonObject {
  if (descriptor.inputJsonSchema) return jsonObjectSchema.parse(descriptor.inputJsonSchema);
  try {
    return jsonObjectSchema.parse(
      z.toJSONSchema(descriptor.inputSchema, { io: "input", unrepresentable: "any" })
    );
  } catch {
    return {};
  }
}

/** Builds the schemas of a definition's steps; refuses a paging or dataset shape that cannot hold. */
export async function workflowStepSchemas(
  manifest: WorkflowManifest,
  definitions: Pick<WorkflowDefinitionSource, "read">,
  registry?: Pick<OperationRegistry, "resolve">
): Promise<WorkflowStepSchemas> {
  const outputs = new Map<string, JsonObject>();
  const inputs = new Map<string, JsonObject>();
  const loopItems = new Map<string, JsonObject>();
  const index = indexWorkflowSteps(manifest);
  // A loop id means the current item inside its body, and counts outside it.
  function sourceOf(id: string, reader: string): JsonObject | undefined {
    let sequence = index.get(reader)?.sequence;
    while (sequence) {
      if (sequence.loop === id) return loopItems.get(id);
      sequence = sequence.parent;
    }
    return outputs.get(id);
  }
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
  async function visit(steps: readonly WorkflowStep[]): Promise<void> {
    for (const step of steps) {
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
        inputs.set(step.id, expanded(inputJsonSchemaOf(descriptor), manifest.types));
        let output = expanded(
          jsonObjectSchema.parse(descriptor.outputJsonSchema ?? {}),
          manifest.types
        );
        if (descriptor.batch && schemaAt(output, "failures")?.type !== "dataset")
          output = replace(
            output,
            "failures",
            jsonObjectSchema.parse(z.toJSONSchema(operationBatchFailureSchema))
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
        const source = sourceOf(step.items.step, step.id);
        const shape = source ? schemaAt(source, step.items.path) : undefined;
        if (step.batch !== undefined && shape && shape.type !== "dataset")
          throw new AppError("VALIDATION_FAILED", "batch on a loop needs a dataset", {
            reason: "batch_requires_dataset"
          });
        if (shape?.type === "dataset")
          loopItems.set(
            step.id,
            step.batch === undefined ? jsonObjectSchema.parse(shape.row) : shape
          );
        else if (shape?.type === "array")
          loopItems.set(step.id, jsonObjectSchema.parse(shape.items ?? {}));
        outputs.set(step.id, {
          type: "object",
          properties: {
            total: { type: "integer" },
            done: { type: "integer" },
            failed: { type: "integer" },
            ...(step.onItemFailure === "continue"
              ? { failures: { type: "dataset", row: loopFailureRowSchema } }
              : {})
          },
          required: ["total", "done", "failed"]
        });
      }
      if (step.type === "loop") await visit(step.steps);
      if (step.type === "condition") {
        await visit(step.then);
        await visit(step.else ?? []);
        const branches = [step.then, step.else ?? []].map((steps) => {
          const last = steps.at(-1);
          return last ? (outputs.get(last.id) ?? {}) : { type: "null" };
        });
        outputs.set(step.id, {
          type: "object",
          properties: {
            taken: { type: "string", enum: ["then", "else"] },
            result: { anyOf: branches }
          },
          required: ["taken", "result"]
        });
      }
      if (step.type === "parallel") {
        for (const branch of step.branches) await visit(branch.steps);
        outputs.set(step.id, {
          type: "object",
          properties: Object.fromEntries(
            step.branches.map((branch) => {
              const last = branch.steps.at(-1);
              return [branch.id, last ? (outputs.get(last.id) ?? {}) : { type: "null" }];
            })
          ),
          required: step.branches.map((branch) => branch.id),
          additionalProperties: false
        });
      }
    }
  }
  await visit(manifest.steps);
  return {
    input: (step) => inputs.get(step),
    reference: (reader, reference) => {
      const source = sourceOf(reference.step, reader);
      return source ? schemaAt(source, reference.path) : undefined;
    }
  };
}
