import { z } from "zod";
import type { KnowledgeBaseTarget } from "@work-shape/catalyst-core";
import { DATA_STORE_NAME_PATTERN } from "../definition";

// What a Knowledge Base's definition holds: the fields of this cut, and a refusal that names
// the slice for each field the spec has and this cut does not build. The definition is the
// whole config of a revision: an editor in Build and the API write it as it is.

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

const backendSchema = z.strictObject(
  {
    /** The id of the Data Store whose tables the Knowledge Base describes. */
    dataStore: z.string().min(1),
    index: later("backend.index", "DS-8, the external index backend"),
    location: later("backend.location", "DS-9, a store on an external Postgres server"),
    database: later("backend.database", "WD-2, a Knowledge Base on a Postgres Connection")
  },
  {
    error: (issue) =>
      issue.input === undefined
        ? "A Knowledge Base names its backend: 'backend: { dataStore: <id> }', the Data Store whose tables it describes. The built-in backend that ingests documents arrives with DS-4."
        : undefined
  }
);

const tableSchema = z.strictObject({
  /** A table or view of the schema `public` of the backend. */
  name: z.string().min(1).max(KNOWLEDGE_TABLE_NAME_MAX_CHARS),
  /** One sentence an agent reads to know what a row of it is. */
  description: z.string().trim().min(1).max(KNOWLEDGE_TABLE_DESCRIPTION_MAX_CHARS)
});

/**
 * The definition of a Knowledge Base as a revision holds it. Strict: a field it does not know
 * is refused, an answer prompt or a fallback text among them (spec check 46).
 */
export const knowledgeBaseDefinitionSchema = z.strictObject({
  name: z.string(),
  title: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX_CHARS),
  /** What it holds, for the agent that picks among its Knowledge Bases. */
  description: z.string().trim().min(1).max(KNOWLEDGE_DESCRIPTION_MAX_CHARS),
  /** The retrieval methods. A Knowledge Base on a Data Store answers `structured` alone. */
  methods: z
    .array(
      z.literal("structured", {
        error:
          "A Knowledge Base on a Data Store answers the method 'structured' alone: SQL over the tables it describes. 'semantic' and 'keyword' search arrive with DS-4 and DS-6a."
      })
    )
    .min(1)
    .default(["structured"]),
  backend: backendSchema,
  tables: z
    .array(tableSchema)
    .min(1, "A Knowledge Base describes at least one table: the descriptions are what it adds.")
    .max(KNOWLEDGE_TABLES_MAX_COUNT)
    .refine((tables) => new Set(tables.map((table) => table.name)).size === tables.length, {
      message: "A table is described once"
    }),
  sources: later("sources", "DS-4 and DS-5, documents the platform ingests"),
  indexing: later("indexing", "DS-7, indexing settings"),
  search: later("search", "DS-7, search settings"),
  extraction: later("extraction", "DS-6a, structured extraction"),
  schedule: later("schedule", "DS-5, ingestion"),
  queries: later("queries", "DS-6a, named queries"),
  filters: later("filters", "DS-6b, declared filters")
});

export type KnowledgeBaseDefinition = z.infer<typeof knowledgeBaseDefinitionSchema>;

/** What a backend is asked about one definition of the Knowledge Base whose asset is `assetId`. */
export function knowledgeTargetOf(
  definition: KnowledgeBaseDefinition,
  assetId: string
): KnowledgeBaseTarget {
  return {
    assetId,
    name: definition.name,
    backend: definition.backend,
    tables: definition.tables
  };
}
