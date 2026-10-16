import { z } from "zod";
import {
  KNOWLEDGE_SEARCH_METHODS,
  type KnowledgeBaseTarget,
  type KnowledgeSearchMethod
} from "@work-shape/catalyst-core";
import { DATA_STORE_NAME_PATTERN } from "../definition";

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

const tableSchema = z.strictObject({
  /** A table or view of the schema `public` of the backend. */
  name: z.string().min(1).max(KNOWLEDGE_TABLE_NAME_MAX_CHARS),
  /** One sentence an agent reads to know what a row of it is. */
  description: z.string().trim().min(1).max(KNOWLEDGE_TABLE_DESCRIPTION_MAX_CHARS)
});

/** Every method a definition may name. Which of them a Knowledge Base answers follows its backend. */
const KNOWLEDGE_METHODS = ["structured", ...KNOWLEDGE_SEARCH_METHODS] as const;

/** The fields a definition is read with, before its backend decides what they must be. */
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
  sources: later("sources", "DS-5, documents the platform ingests from a Connection"),
  indexing: later("indexing", "DS-7, indexing settings"),
  search: later("search", "DS-7, search settings"),
  extraction: later("extraction", "DS-6a, structured extraction"),
  schedule: later("schedule", "DS-5, ingestion"),
  queries: later("queries", "DS-6a, named queries"),
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
    if (tables !== undefined || methods?.includes("structured")) {
      return refuse(
        tables === undefined ? "methods" : "tables",
        "A Knowledge Base answers 'structured' over the tables of a Data Store it names: 'backend: { dataStore: <id> }'. Without a backend it keeps documents and searches them with 'semantic' and 'keyword'."
      );
    }
    // Without methods it searches by meaning and by words, the spec's default pair. Whether the
    // instance can search by meaning is its own rule, asked on every write and publish.
    return { ...fields, methods: (methods ?? KNOWLEDGE_SEARCH_METHODS).filter(isSearchMethod) };
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
        tables: definition.tables
      }
    : { backend: "builtin", assetId, name: definition.name, methods: definition.methods };
}

/** What the instance offers a Knowledge Base for search by meaning, as release config names it. */
export interface KnowledgeEmbedding {
  /** The embedding binding a Knowledge Base uses. Without one there is no search by meaning. */
  defaultBinding?: string;
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
