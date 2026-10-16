import { STRUCTURED_DATA_REVIEW_REASONS } from "@work-shape/catalyst-core";
import { z } from "zod";

const keySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u);
const labelSchema = z.string().min(1).max(120);
const valueSchema = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
const sourceSchema = z
  .object({
    fileId: z
      .string()
      .min(1)
      .describe("Managed file id from the current conversation attachment manifest."),
    page: z.number().int().positive().optional()
  })
  .strict();
const sourcesSchema = z
  .array(sourceSchema)
  .max(8)
  .describe("Optional source references using the file ids visible to the model.");
const attentionSchema = z
  .object({
    reason: z.enum(STRUCTURED_DATA_REVIEW_REASONS),
    message: z.string().min(1).optional()
  })
  .strict();

const replaceFieldSchema = z
  .object({
    key: keySchema.describe("Stable field key to reuse in later patches."),
    label: labelSchema,
    value: valueSchema,
    sources: sourcesSchema.optional(),
    attention: attentionSchema.optional()
  })
  .strict();

function requireUniqueKeys(
  entries: readonly { key: string }[],
  ctx: z.core.$RefinementCtx,
  subject: string
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      ctx.addIssue({ code: "custom", message: `Duplicate ${subject} key "${entry.key}"` });
    }
    seen.add(entry.key);
  }
}

const replaceSectionSchema = z
  .object({
    key: keySchema.describe("Stable section key to reuse in later patches."),
    label: labelSchema,
    fields: z
      .array(replaceFieldSchema)
      .max(64)
      .superRefine((fields, ctx) => requireUniqueKeys(fields, ctx, "field"))
  })
  .strict();

const replaceInputSchema = z
  .object({
    resourceKey: keySchema.describe("Stable key identifying this conversation resource."),
    title: labelSchema.describe("Title shown for the resource."),
    operation: z.literal("replace"),
    sections: z
      .array(replaceSectionSchema)
      .max(24)
      .superRefine((sections, ctx) => requireUniqueKeys(sections, ctx, "section"))
      .describe("Complete replacement structure for the resource.")
  })
  .strict();

const patchSetSchema = z
  .object({
    sectionKey: keySchema.describe("Existing section key."),
    fieldKey: keySchema.describe("Existing or new field key."),
    value: valueSchema,
    label: labelSchema.optional(),
    sources: sourcesSchema.optional(),
    attention: attentionSchema.nullable().optional()
  })
  .strict();

const patchRemoveSchema = z
  .object({
    sectionKey: keySchema.describe("Section containing the field."),
    fieldKey: keySchema.describe("Field to remove if present.")
  })
  .strict();

const patchInputSchema = z
  .object({
    resourceKey: keySchema.describe("Key of the resource previously published with replace."),
    operation: z.literal("patch"),
    set: z
      .array(patchSetSchema)
      .describe("Named field values to update or append in existing sections.")
      .optional(),
    remove: z
      .array(patchRemoveSchema)
      .describe("Named fields to remove; missing fields are ignored.")
      .optional()
  })
  .strict();

const publishOperationSchema = z.discriminatedUnion("operation", [
  replaceInputSchema,
  patchInputSchema
]);

/**
 * What a model is shown: one object with the fields of both operations. A model provider takes
 * a tool's input schema only with an object at its root (Anthropic refuses a union there), so
 * the choice between the operations is the `operation` field, not a union of two objects.
 */
const publishFieldsSchema = z
  .object({
    operation: z
      .enum(["replace", "patch"])
      .describe(
        "replace supplies the full structure and needs title and sections. patch edits named fields with set and remove."
      ),
    resourceKey: keySchema.describe(
      "Stable key identifying this conversation resource. With patch, the key of the resource previously published with replace."
    ),
    title: replaceInputSchema.shape.title
      .describe("Title shown for the resource. Required with replace, not allowed with patch.")
      .optional(),
    sections: replaceInputSchema.shape.sections
      .describe(
        "Complete replacement structure for the resource. Required with replace, not allowed with patch."
      )
      .optional(),
    set: patchInputSchema.shape.set.describe(
      "Named field values to update or append in existing sections. Only with patch."
    ),
    remove: patchInputSchema.shape.remove.describe(
      "Named fields to remove; missing fields are ignored. Only with patch."
    )
  })
  .strict();

/**
 * The input of structured_data.publish. It is read as the one object a model is shown and then
 * as the operation it names, so each operation still takes exactly its own fields.
 */
export const structuredDataPublishInputSchema = publishFieldsSchema.pipe(publishOperationSchema);

export const structuredDataPublishOutputSchema = z.object({
  resourceKey: z.string(),
  revision: z.number().int().positive(),
  operation: z.enum(["replace", "patch"]),
  message: z.string(),
  warnings: z.array(z.string().min(1)).optional()
});

export const structuredDataReadInputSchema = z
  .object({
    resourceKey: keySchema.describe("Stable key of the current structured-data resource.")
  })
  .strict();

const modelSourceSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  page: z.number().int().positive().optional()
});

export const structuredDataReadOutputSchema = z.object({
  resourceKey: z.string(),
  title: z.string(),
  revision: z.number().int().positive(),
  sections: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      fields: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          value: valueSchema,
          sources: z.array(modelSourceSchema).optional(),
          attention: attentionSchema.optional()
        })
      )
    })
  )
});

export const structuredResultReadInputSchema = z
  .object({
    resourceKey: z.string().min(1).describe("Stable key of the current structured result.")
  })
  .strict();

export const structuredResultReadOutputSchema = z.object({
  key: z.string(),
  kind: z.string(),
  schemaVersion: z.number().int().positive(),
  title: z.string(),
  revision: z.number().int().positive(),
  data: z.record(z.string(), z.json())
});
