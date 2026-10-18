import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import { z } from "zod";
import { compileJsonSchema } from "@work-shape/catalyst-connections";
import {
  AppError,
  KNOWLEDGE_BUILTIN_PROCESSORS,
  type KnowledgeBuiltinProcessor,
  parseKnowledgeProcessorOutput,
  type KnowledgeProcessorOutput,
  type KnowledgeDocumentFormat
} from "@work-shape/catalyst-core";

/** Built-in revisions change only when their output changes. No customer processor runs here. */
const KNOWLEDGE_PROCESSOR_VERSIONS = { text: 1, tables: 1 } as const;
const pattern = z.array(z.string().min(1)).min(1);
const fieldsSchema = z
  .record(z.string(), z.json())
  .refine((schema) => compileJsonSchema(schema).ok, {
    message:
      "documentTypes[].schema must be a valid, bounded JSON Schema with local references only"
  });
export const knowledgeDocumentTypesSchema = z
  .array(
    z.strictObject({
      id: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{0,62}$/u)
        .refine((id) => id !== "default", "default is the fallback type"),
      match: z
        .strictObject({
          path: pattern.optional(),
          name: pattern.optional(),
          mime: pattern.optional()
        })
        .refine((match) => Object.keys(match).length > 0, "A document type needs a match rule"),
      processor: z
        .enum(KNOWLEDGE_BUILTIN_PROCESSORS, {
          error:
            "documentTypes[].processor must be text or tables. ocr arrives with KB-9; use a data Workflow for other processing."
        })
        .default("text"),
      workflow: z
        .never({
          error:
            "documentTypes[].workflow is refused. A data Workflow names the Knowledge Base and type in its pending step."
        })
        .optional(),
      chunking: z.enum(["page", "heading", "sheet_rows", "sections", "whole"]).optional(),
      // The CLI resolves schema paths into this revision's JSON; the server never reads host paths.
      schema: fieldsSchema.optional()
    })
  )
  .refine(
    (types) => new Set(types.map((type) => type.id)).size === types.length,
    "A document type id is named once"
  );
type KnowledgeDocumentType = z.infer<typeof knowledgeDocumentTypesSchema>[number];
export type KnowledgeChunkingStrategy = NonNullable<KnowledgeDocumentType["chunking"]>;
export interface KnowledgeProcessing {
  type: string;
  processor: KnowledgeBuiltinProcessor;
  processorRevision: string;
  chunking: KnowledgeChunkingStrategy;
  schema?: KnowledgeDocumentType["schema"];
  key: string;
}

/** First matching rule wins; patterns within a field are OR, named fields are AND. */
export function knowledgeProcessingOf(
  types: readonly KnowledgeDocumentType[] | undefined,
  item: { path: string; name: string; mime: string; format: KnowledgeDocumentFormat }
): KnowledgeProcessing {
  const type = types?.find(({ match }) =>
    (["path", "name", "mime"] as const).every(
      (field) =>
        !match[field] ||
        match[field].some(
          (pattern) =>
            matchesGlob(item[field], pattern) ||
            (field === "path" && matchesGlob(item.path.replace(/^\//u, ""), pattern))
        )
    )
  );
  const processor = type?.processor ?? "text";
  const processing = {
    type: type?.id ?? "default",
    processor,
    processorRevision: `${processor}@${KNOWLEDGE_PROCESSOR_VERSIONS[processor]}`,
    chunking: type?.chunking ?? (item.format === "markdown" ? "heading" : "page"),
    ...(type?.schema === undefined ? {} : { schema: type.schema })
  };
  return {
    ...processing,
    key: createHash("sha256").update(JSON.stringify(processing)).digest("hex")
  };
}

/** The same frozen output validator as put_processed, then the type's fields and instance page limit. */
export function validateKnowledgeProcessingOutput(
  output: unknown,
  processing: KnowledgeProcessing,
  maxPages: number
): KnowledgeProcessorOutput {
  const parsed = parseKnowledgeProcessorOutput(output, { maxPages });
  if (processing.schema && Object.keys(parsed.fields).length > 0) {
    // Field extraction comes with PROC-2. Check supplied fields now, without requiring fields
    // that a text/table processor has not extracted yet.
    const compiled = compileJsonSchema({ ...processing.schema, required: [] });
    if (!compiled.ok || compiled.validate(parsed.fields).length)
      throw new AppError(
        "VALIDATION_FAILED",
        "The processor fields do not fit documentTypes[].schema",
        { reason: "knowledge_processor_output_invalid" }
      );
  }
  return parsed;
}
