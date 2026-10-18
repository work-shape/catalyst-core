import { z } from "zod";
import { outsideSchemaChecker } from "@work-shape/catalyst-connections";
import {
  AppError,
  asManagedFileId,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_WRITE_OPERATIONS,
  knowledgeExtractionKey,
  knowledgeExtractionResultSchema,
  readObjectBytes,
  type JsonObject,
  type JsonValue,
  type KnowledgeDocumentStore,
  type KnowledgeFieldDocument,
  type OperationDefinition,
  type OperationResource
} from "@work-shape/catalyst-core";
import { recordEvidence } from "@work-shape/catalyst-core";
import type { KnowledgeRuntime } from "./runtime";
import { knowledgeExtractionBudgetSchema, type KnowledgeBaseDefinition } from "./definition";

// A timed out call retains its reservation; larger documents get time proportional to their input.
const FIELD_EXTRACTION_BASE_TIMEOUT_MS = 60_000;
const FIELD_EXTRACTION_PER_1000_TOKENS_MS = 15_000;
// Estimate German and English text without treating UTF-8 bytes as tokens; never truncate evidence.
const FIELD_INPUT_BYTES_PER_TOKEN = 4;
const answerSchema = z.strictObject({
  date: z.iso.date().nullable().optional(),
  values: z.record(z.string(), z.json()),
  evidence: z.array(
    z.strictObject({
      name: z.string(),
      page: z.number().int().positive(),
      quote: z.string().min(1)
    })
  )
});

function failure(reason: string, details: JsonObject = {}): AppError {
  return new AppError("CONFLICT", "Field extraction could not complete", { reason, ...details });
}

/** Local references keep pointing at the customer's value schema after adding the evidence envelope. */
function rebaseReferences(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(rebaseReferences);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === "$ref" && typeof child === "string" && child.startsWith("#")
          ? `#/properties/values${child.slice(1)}`
          : rebaseReferences(child)
      ])
    );
  return value;
}
function answerFormat(schema: JsonObject): JsonObject {
  return {
    type: "object",
    required: ["values", "evidence"],
    additionalProperties: false,
    properties: {
      date: {
        type: ["string", "null"],
        format: "date",
        description:
          "The document’s own date, if stated, as YYYY-MM-DD; otherwise null. Never use its file modification or ingestion date."
      },
      values: rebaseReferences(schema),
      evidence: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "page", "quote"],
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            page: { type: "integer", minimum: 1 },
            quote: { type: "string", minLength: 1 }
          }
        }
      }
    }
  };
}

async function documentPages(
  runtime: KnowledgeRuntime,
  assetId: string,
  doc: KnowledgeFieldDocument
) {
  if (!runtime.files) throw failure("knowledge_field_text_unavailable");
  try {
    const bytes = await readObjectBytes(
      runtime.files.objects,
      knowledgeExtractionKey(assetId, doc.contentHash)
    );
    const result = knowledgeExtractionResultSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes))
    );
    if (result.success && result.data.status === "extracted") return result.data.pages;
  } catch {
    /* A manually added text file can have no retained extraction yet. */
  }
  if (doc.format !== "txt" && doc.format !== "markdown")
    throw failure("knowledge_field_text_unavailable");
  const file = await runtime.stores.files.getManagedFile({
    clientInstanceId: runtime.clientInstanceId,
    fileId: asManagedFileId(doc.fileId)
  });
  if (
    file?.owner?.kind !== "knowledge_base" ||
    file.owner.id !== assetId ||
    file.status !== "available"
  )
    throw failure("knowledge_field_text_unavailable");
  try {
    return [
      {
        page: 1,
        text: new TextDecoder("utf-8", { fatal: true }).decode(
          await readObjectBytes(runtime.files.objects, file.objectKey)
        )
      }
    ];
  } catch {
    throw failure("knowledge_field_text_unavailable");
  }
}

export function extractFieldsOperation(
  runtime: KnowledgeRuntime,
  target: {
    name: string;
    assetId: string;
    definition: KnowledgeBaseDefinition;
    resource: OperationResource;
    store: KnowledgeDocumentStore;
  }
): OperationDefinition {
  const contract = KNOWLEDGE_WRITE_OPERATIONS.extract_fields;
  return {
    name: `knowledge.${target.name}.extract_fields`,
    effect: "reading",
    action: KNOWLEDGE_BASE_ACTIONS.read,
    scope: "data_store_rows:read",
    auth: "principal",
    module: "knowledge",
    timeoutMs:
      FIELD_EXTRACTION_BASE_TIMEOUT_MS +
      Math.ceil(
        (target.definition.extraction?.budget.maxTokensPerDocument ??
          knowledgeExtractionBudgetSchema.parse({}).maxTokensPerDocument) / 1000
      ) *
        FIELD_EXTRACTION_PER_1000_TOKENS_MS,
    // A failure can leave a run too. Never retain schema descriptions, quotes or values.
    recordsEveryCall: true,
    secret: true,
    inputWithoutSecrets: (input) => ({ documentId: contract.inputSchema.parse(input).documentId }),
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    resource: () => target.resource,
    async execute(input, context) {
      const { documentId, schema } = contract.inputSchema.parse(input);
      const { fieldExtractor: extractor } = runtime;
      const store = target.store.fieldExtraction;
      if (!extractor || !store) throw failure("knowledge_field_binding_unavailable");
      const checker = outsideSchemaChecker();
      if (await checker.refusalOf(schema)) throw failure("knowledge_field_schema_invalid");
      const signal = context.runtime.signal ?? new AbortController().signal;
      const doc = await store.document(documentId, signal);
      if (!doc) throw failure("knowledge_document_unavailable");
      const pages = await documentPages(runtime, target.assetId, doc);
      signal.throwIfAborted();
      const maxTokens = (
        target.definition.extraction?.budget ?? knowledgeExtractionBudgetSchema.parse({})
      ).maxTokensPerDocument;
      const format = answerFormat(schema);
      const inputTokens =
        extractor.countInputTokens?.({ pages, schema: format }) ??
        Math.ceil(
          new TextEncoder().encode(
            JSON.stringify({ pages, schema: format, outputInstructions: format })
          ).byteLength / FIELD_INPUT_BYTES_PER_TOKEN
        );
      if (inputTokens >= maxTokens) {
        // Token refusal is a pause too, without changing the document's search state.
        await store.pause(
          documentId,
          { reason: "token_budget", estimatedTokens: inputTokens, maxTokensPerDocument: maxTokens },
          signal
        );
        throw failure("knowledge_field_token_budget_reached", {
          estimatedTokens: inputTokens,
          maxTokensPerDocument: maxTokens
        });
      }
      const month = runtime.now().toISOString().slice(0, 7);
      const reserved = extractor.reserveCost(maxTokens);
      if (
        !(await store.reserve(
          {
            documentId,
            month,
            currency: extractor.currency,
            cost: reserved,
            limit: target.definition.extraction?.budget.perMonth
          },
          signal
        ))
      )
        throw failure("knowledge_field_budget_reached");
      let answer;
      let called = false;
      const settle = (cost: number) =>
        store.settle({
          documentId,
          contentHash: doc.contentHash,
          month,
          currency: extractor.currency,
          reserved,
          cost
        });
      try {
        // Re-read after loading text and admission: withdrawn/changed evidence never reaches the provider.
        if ((await store.document(documentId, signal))?.contentHash !== doc.contentHash)
          throw failure("knowledge_document_unavailable");
        called = true;
        answer = await extractor.extract({
          pages,
          schema: format,
          maxTokens: maxTokens - inputTokens,
          reservedCost: reserved,
          correlationId: context.correlationId,
          signal,
          deadline: new Date(
            Math.min(
              context.runtime.deadline?.getTime() ?? Infinity,
              runtime.now().getTime() +
                FIELD_EXTRACTION_BASE_TIMEOUT_MS +
                Math.ceil(inputTokens / 1000) * FIELD_EXTRACTION_PER_1000_TOKENS_MS
            )
          )
        });
      } catch {
        // Admission can be invalidated before the provider is called: no charge was possible.
        if (!called) await settle(0);
        throw failure("knowledge_field_extraction_failed");
      }
      // Account for a reported cost even if parsing or schema validation below fails.
      const active = await settle(answer.cost);
      if (!active) throw failure("knowledge_document_unavailable");
      let parsed;
      try {
        parsed = answerSchema.safeParse(JSON.parse(answer.text));
      } catch {
        throw failure("knowledge_field_output_invalid");
      }
      if (!parsed.success) throw failure("knowledge_field_output_invalid");
      const properties = schema.properties;
      const supported =
        properties !== null && typeof properties === "object" && !Array.isArray(properties)
          ? properties
          : undefined;
      const values = Object.fromEntries(
        Object.entries(parsed.data.values).filter(
          ([name]) =>
            !supported ||
            schema.patternProperties !== undefined ||
            (schema.additionalProperties !== undefined && schema.additionalProperties !== false) ||
            Object.hasOwn(supported, name)
        )
      );
      const droppedFields = Object.keys(parsed.data.values).length - Object.keys(values).length;
      if ((await checker.check(schema, JSON.stringify(values))).length)
        throw failure("knowledge_field_output_invalid");
      const fields = new Map<string, z.infer<typeof contract.outputSchema>["fields"][string]>();
      const pageText = new Map(pages.map((page) => [page.page, page.text]));
      const evidence = new Map<string, typeof parsed.data.evidence>();
      for (const citation of parsed.data.evidence) {
        const existing = evidence.get(citation.name);
        if (existing) existing.push(citation);
        else evidence.set(citation.name, [citation]);
      }
      let failedFields = 0;
      for (const [name, value] of Object.entries(values)) {
        const citations = evidence.get(name) ?? [];
        // The frozen value/page/quote shape travels unchanged to records.propose for its recheck.
        // Missing or duplicate citations get an empty normalized quote, which always fails there.
        const citation = citations.length === 1 ? citations[0] : undefined;
        const field = { value, page: citation?.page ?? 1, quote: citation?.quote ?? " " };
        if (
          recordEvidence(value, field.quote, pageText.get(field.page), runtime.defaultLocale)
            .status !== "passed"
        )
          failedFields += 1;
        fields.set(name, field);
      }
      return {
        path: doc.path,
        date:
          parsed.data.date &&
          pages.some(
            (page) =>
              recordEvidence(parsed.data.date ?? null, page.text, page.text, runtime.defaultLocale)
                .status === "passed"
          )
            ? parsed.data.date
            : null,
        type: doc.type,
        fields: Object.fromEntries(fields),
        droppedFields,
        failedFields
      };
    }
  };
}
