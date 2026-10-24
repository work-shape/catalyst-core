import { z } from "zod";
import { knowledgeDocumentTypesSchema } from "./document-types";
import {
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN,
  CONNECTION_NAME_RULE,
  KNOWLEDGE_SEARCH_METHODS,
  knowledgeRecordsRefusalSchema,
  type KnowledgeBaseTarget,
  type KnowledgeEmbeddingModel,
  type KnowledgeSearchMethod
} from "@work-shape/catalyst-core";
import {
  DATA_STORE_NAME_MAX_LENGTH,
  DATA_STORE_NAME_PATTERN,
  DATA_STORE_NAME_RULE
} from "../definition";

// What a Knowledge Base's definition holds: the fields of this cut, and a refusal that names
// the slice for each field the spec has and this cut does not build. The definition is the
// whole config of a revision: an editor in Build and the API write it as it is. A definition
// that names a backend describes tables of a Data Store; one without a backend keeps documents
// in a store of its own (the built-in backend).

/** The id of a Knowledge Base. It holds no dot, so an operation name reads: `knowledge.<id>.query`. */
export const KNOWLEDGE_BASE_NAME_PATTERN = DATA_STORE_NAME_PATTERN;
export const KNOWLEDGE_BASE_NAME_MAX_LENGTH = 63;
export const KNOWLEDGE_BASE_NAME_RULE =
  "A Knowledge Base id is lowercase letters and digits in words joined by '-', starting with a letter, at most 63 characters";

/** How long the name people read may be. */
const KNOWLEDGE_TITLE_MAX_CHARS = 120;
/** How long the description an agent reads to pick the Knowledge Base may be. */
const KNOWLEDGE_DESCRIPTION_MAX_CHARS = 2_000;
/** How many tables one Knowledge Base describes at most. Each is a line of the agent's tool. */
const KNOWLEDGE_TABLES_MAX_COUNT = 200;
/** How long the sentence that describes one table may be. */
const KNOWLEDGE_TABLE_DESCRIPTION_MAX_CHARS = 500;
/** How long a table name is at most: the length Postgres keeps of a name. */
const KNOWLEDGE_TABLE_NAME_MAX_CHARS = 63;

/** A field the spec has that arrives with a later slice: present, it is refused with that slice. */
const later = (field: string, slice: string) =>
  z
    .never({
      error: `'${field}' arrives with ${slice}. A Knowledge Base of this release has none.`
    })
    .optional();

const backendSchema = z.strictObject({
  /** The id of the Data Store whose tables the Knowledge Base describes. */
  dataStore: z.string().min(1),
  index: later("backend.index", "DS-8, the external index backend"),
  location: later("backend.location", "DS-9, a store on an external Postgres server"),
  database: later("backend.database", "WD-2, a Knowledge Base on a Postgres Connection")
});

/** How many synced sources one Knowledge Base has at most. */
const KNOWLEDGE_SOURCES_MAX_COUNT = 20;
/** How many folders one source's boundary names at most. */
const KNOWLEDGE_SOURCE_FOLDERS_MAX_COUNT = 100;
/** How many patterns one `include` or `exclude` holds at most, and how long one is. */
const KNOWLEDGE_SOURCE_PATTERNS_MAX_COUNT = 50;
const KNOWLEDGE_SOURCE_PATTERN_MAX_CHARS = 500;

const sourcePatternsSchema = z
  .array(z.string().trim().min(1).max(KNOWLEDGE_SOURCE_PATTERN_MAX_CHARS))
  .min(1)
  .max(KNOWLEDGE_SOURCE_PATTERNS_MAX_COUNT);

/**
 * A synced source: documents the platform keeps current from a Connection whose type declares
 * `document_source` (spec: Synced sources, "The shape"). Adding, narrowing or removing one is a
 * draft change that takes effect at publish.
 */
const sourceSchema = z.strictObject({
  /** Stable within the Knowledge Base; the operations and the CLI name the source by it. */
  id: z
    .string()
    .max(DATA_STORE_NAME_MAX_LENGTH)
    .regex(DATA_STORE_NAME_PATTERN, { error: `A source id is ${DATA_STORE_NAME_RULE}` }),
  /** The Connection the source reads through. */
  connection: z
    .string()
    .max(CONNECTION_NAME_MAX_LENGTH)
    .regex(CONNECTION_NAME_PATTERN, { error: CONNECTION_NAME_RULE }),
  /** The boundary: folder ids in the source system, never a path. */
  folders: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(KNOWLEDGE_SOURCE_FOLDERS_MAX_COUNT)
    .refine((folders) => new Set(folders).size === folders.length, {
      message: "A folder is named once"
    }),
  /** Patterns on the file name, such as `*.pdf`. Without it every file below the folders. */
  include: sourcePatternsSchema.optional(),
  /** Patterns on the path below the boundary, such as `**\/Personal/**`. */
  exclude: sourcePatternsSchema.optional()
});

const tableSchema = z.strictObject({
  /** A table or view of the schema `public` of the backend. */
  name: z.string().min(1).max(KNOWLEDGE_TABLE_NAME_MAX_CHARS),
  /** One sentence an agent reads to know what a row of it is. */
  description: z.string().trim().min(1).max(KNOWLEDGE_TABLE_DESCRIPTION_MAX_CHARS)
});

/** Every method a definition may name. Which of them a Knowledge Base answers follows its backend. */
const KNOWLEDGE_METHODS = ["structured", ...KNOWLEDGE_SEARCH_METHODS] as const;

/** The fields a definition is read with, before its backend decides what they must be. */
export const knowledgeExtractionBudgetSchema = z.strictObject({
  perMonth: z.number().nonnegative().optional(),
  maxTokensPerDocument: z.number().int().positive().default(8000)
});

const definitionFieldsSchema = z.strictObject({
  name: z.string(),
  title: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX_CHARS),
  /** What it holds, for the agent that picks among its Knowledge Bases. */
  description: z.string().trim().min(1).max(KNOWLEDGE_DESCRIPTION_MAX_CHARS),
  /** The retrieval methods. */
  methods: z
    .array(
      z.enum(KNOWLEDGE_METHODS, {
        error: `A Knowledge Base answers the methods ${KNOWLEDGE_METHODS.map((method) => `'${method}'`).join(", ")}.`
      })
    )
    .min(1)
    .refine((methods) => new Set(methods).size === methods.length, {
      message: "A method is named once"
    })
    .optional(),
  /** Where its content is. Without one the platform keeps its documents in a store it owns. */
  backend: backendSchema.optional(),
  tables: z
    .array(tableSchema)
    .max(KNOWLEDGE_TABLES_MAX_COUNT)
    .refine((tables) => new Set(tables.map((table) => table.name)).size === tables.length, {
      message: "A table is described once"
    })
    .optional(),
  sources: z
    .array(sourceSchema)
    .max(KNOWLEDGE_SOURCES_MAX_COUNT)
    .refine((sources) => new Set(sources.map((source) => source.id)).size === sources.length, {
      message: "A source id is named once"
    })
    .optional(),
  documentTypes: knowledgeDocumentTypesSchema.optional(),
  records: knowledgeRecordsRefusalSchema,
  indexing: z
    .strictObject({
      /** Only with `semantic`. A change of it, published, starts a re-index (KB-8). */
      embedding: z
        .strictObject({
          /** An approved binding of kind `embedding` of release config. */
          binding: z.string().trim().min(1).max(200)
        })
        .optional(),
      chunking: later("indexing.chunking", "DS-7, chunking settings"),
      languages: later("indexing.languages", "KB-12, keyword languages")
    })
    .optional(),
  search: later("search", "DS-7, search settings"),
  extraction: z
    .strictObject({
      budget: knowledgeExtractionBudgetSchema.default(() =>
        knowledgeExtractionBudgetSchema.parse({})
      )
    })
    .optional(),
  // Withdrawn by SPEC-DMS: a schedule of its own would be a second, invisible one.
  schedule: z
    .never({
      error:
        "'schedule' is withdrawn. A synced source is kept current by its daily Workflow '<Knowledge Base> abgleichen' and by background updates about every 15 minutes. Remove 'schedule'."
    })
    .optional(),
  queries: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u),
        file: z.string().regex(/^queries\/[a-z][a-z0-9_]{0,62}\.sql$/u),
        sql: z.string().min(1).max(12288)
      })
    )
    .max(50)
    .refine(
      (queries) => new Set(queries.map((query) => query.name)).size === queries.length,
      "A named query is declared once"
    )
    .optional(),
  filters: later("filters", "DS-6b, declared filters")
});

type DefinitionFields = Omit<
  z.infer<typeof definitionFieldsSchema>,
  "methods" | "backend" | "tables"
>;

/** A Knowledge Base that describes tables of a Data Store and answers SQL over them. */
export interface DataStoreKnowledgeDefinition extends DefinitionFields {
  methods: ["structured"];
  backend: z.infer<typeof backendSchema>;
  tables: z.infer<typeof tableSchema>[];
}

/** A Knowledge Base whose documents the platform keeps in a store it owns: the built-in backend. */
interface BuiltinKnowledgeDefinition extends DefinitionFields {
  methods: KnowledgeSearchMethod[];
}

export type KnowledgeBaseDefinition = DataStoreKnowledgeDefinition | BuiltinKnowledgeDefinition;

const isSearchMethod = (method: string): method is KnowledgeSearchMethod =>
  KNOWLEDGE_SEARCH_METHODS.some((search) => search === method);

/**
 * The definition of a Knowledge Base as a revision holds it. Strict: a field it does not know
 * is refused, an answer prompt or a fallback text among them (spec check 46). Its backend
 * decides the rest: on a Data Store it answers `structured` over the tables it describes, and
 * on the built-in backend it searches documents and describes no table.
 */
export const knowledgeBaseDefinitionSchema = definitionFieldsSchema.transform(
  ({ methods, backend, tables, ...fields }, context): KnowledgeBaseDefinition => {
    const refuse = (path: string, message: string) => {
      context.issues.push({ code: "custom", path: [path], message, input: undefined });
      return z.NEVER;
    };
    if (backend) {
      if (fields.indexing)
        return refuse(
          "indexing",
          "Indexing settings apply to a Knowledge Base that keeps documents, not to one on a Data Store"
        );
      if (fields.extraction)
        return refuse(
          "extraction",
          "Field extraction is available only on a Knowledge Base that keeps documents"
        );
      if (fields.documentTypes?.length)
        return refuse(
          "documentTypes",
          "documentTypes classify documents of the built-in backend only"
        );
      if (fields.sources?.length) {
        return refuse(
          "sources",
          "A Knowledge Base on a Data Store reads its tables and syncs no source. Sources fill a Knowledge Base without a backend, which keeps documents."
        );
      }
      if (methods?.some((method) => method !== "structured")) {
        return refuse(
          "methods",
          "A Knowledge Base on a Data Store answers the method 'structured' alone: SQL over the tables it describes. 'semantic' and 'keyword' search documents of a Knowledge Base without a backend."
        );
      }
      if (!tables?.length) {
        return refuse(
          "tables",
          "A Knowledge Base on a Data Store describes at least one table: the descriptions are what it adds."
        );
      }
      return { ...fields, methods: ["structured"], backend, tables };
    }
    if (fields.queries?.length)
      return refuse(
        "queries",
        "Named SQL queries require a structured Knowledge Base on a Data Store"
      );
    if (tables !== undefined || methods?.includes("structured")) {
      return refuse(
        tables === undefined ? "methods" : "tables",
        "A Knowledge Base answers 'structured' over the tables of a Data Store it names: 'backend: { dataStore: <id> }'. Without a backend it keeps documents and searches them with 'semantic' and 'keyword'."
      );
    }
    // Without methods it searches by meaning and by words, the spec's default pair. Whether the
    // instance can search by meaning is its own rule, asked on every write and publish.
    const searchMethods = (methods ?? KNOWLEDGE_SEARCH_METHODS).filter(isSearchMethod);
    if (fields.indexing?.embedding && !searchMethods.includes("semantic")) {
      return refuse(
        "indexing",
        "'indexing.embedding' names the embedding model of search by meaning: list 'semantic' in 'methods', or remove it."
      );
    }
    return { ...fields, methods: searchMethods };
  }
);

/** What a backend is asked about one definition of the Knowledge Base whose asset is `assetId`. */
export function knowledgeTargetOf(
  definition: KnowledgeBaseDefinition,
  assetId: string
): KnowledgeBaseTarget {
  return "backend" in definition
    ? {
        backend: "dataStore",
        assetId,
        name: definition.name,
        dataStore: definition.backend.dataStore,
        ...(definition.queries ? { queries: definition.queries } : {}),
        tables: definition.tables
      }
    : { backend: "builtin", assetId, name: definition.name, methods: definition.methods };
}

/** What the instance offers a Knowledge Base for search by meaning, as release config names it. */
export interface KnowledgeEmbedding {
  /** The embedding binding a Knowledge Base uses. Without one there is no search by meaning. */
  defaultBinding?: string;
  /** Customer rate of the default embedding binding, for a publish cost statement. */
  processingPrices?: { bindingId: string; currency: string; perMillionTokens: number }[];
  /**
   * Every binding of kind `embedding`, the approved list, with the model behind it and the
   * length of its vectors. Left out where the process embeds nothing.
   */
  models?: readonly KnowledgeEmbeddingModel[];
}

/** The approved embedding model of a binding, or nothing where release config has none. */
export function approvedEmbeddingModel(
  embedding: KnowledgeEmbedding,
  bindingId: string | undefined
): KnowledgeEmbeddingModel | undefined {
  return bindingId === undefined
    ? undefined
    : embedding.models?.find((model) => model.bindingId === bindingId);
}

/**
 * The binding a Knowledge Base that searches by meaning embeds with: the one its definition
 * names, else the instance's default. Spec: Changing the embedding model.
 */
export function knowledgeEmbeddingBinding(
  definition: KnowledgeBaseDefinition,
  embedding: Pick<KnowledgeEmbedding, "defaultBinding">
): string | undefined {
  return "backend" in definition
    ? undefined
    : (definition.indexing?.embedding?.binding ?? embedding.defaultBinding);
}

/**
 * Why a Knowledge Base cannot be written or published with the embedding binding it names: one
 * that is not an approved binding of kind `embedding` on this instance. Nothing for any other.
 */
export function embeddingBindingIssue(
  knowledgeBase: KnowledgeBaseDefinition,
  embedding: KnowledgeEmbedding
): string | undefined {
  const binding =
    "backend" in knowledgeBase ? undefined : knowledgeBase.indexing?.embedding?.binding;
  if (binding === undefined || approvedEmbeddingModel(embedding, binding)) return undefined;
  const approved = (embedding.models ?? []).map((model) => `'${model.bindingId}'`).join(", ");
  return `Knowledge Base '${knowledgeBase.name}' names the embedding binding '${binding}', which this instance does not approve. ${approved ? `Approved: ${approved}.` : "This instance approves no embedding binding."}`;
}

/**
 * Why a Knowledge Base that searches by meaning cannot be written or published on an instance
 * that offers no embedding model: its release config names no
 * `knowledge.defaultEmbeddingBinding`. Nothing for any other. Spec check 34.
 */
export function semanticSearchIssue(
  knowledgeBase: { name: string; methods: readonly string[] },
  embedding: KnowledgeEmbedding
): string | undefined {
  if (embedding.defaultBinding !== undefined || !knowledgeBase.methods.includes("semantic")) {
    return undefined;
  }
  return `Knowledge Base '${knowledgeBase.name}' searches with 'semantic', and this instance has no embedding model approved for it: its release config names no 'knowledge.defaultEmbeddingBinding'. Search with 'methods: [keyword]', or ask the operator to approve an embedding model.`;
}
