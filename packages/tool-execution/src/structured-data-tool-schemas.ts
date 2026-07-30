import { z } from "zod";

const keySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u);
const labelSchema = z.string().min(1).max(120);
const valueSchema = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null()
]);
const sourceSchema = z
  .object({
    attachmentId: z.string().min(1).describe("Sent conversation attachment id."),
    page: z.number().int().positive().optional()
  })
  .strict();
const sourcesSchema = z
  .array(sourceSchema)
  .max(8)
  .describe("Optional source references to sent conversation attachments.");

const replaceFieldSchema = z
  .object({
    key: keySchema.describe("Stable field key to reuse in later patches."),
    label: labelSchema,
    value: valueSchema,
    sources: sourcesSchema.optional()
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
    sources: sourcesSchema.optional()
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

export const structuredDataPublishInputSchema = z.discriminatedUnion("operation", [
  replaceInputSchema,
  patchInputSchema
]);

export const structuredDataPublishOutputSchema = z.object({
  resourceKey: z.string(),
  revision: z.number().int().positive(),
  operation: z.enum(["replace", "patch"]),
  message: z.string()
});
