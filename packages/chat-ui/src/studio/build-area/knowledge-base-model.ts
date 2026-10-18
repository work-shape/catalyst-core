import {
  KNOWLEDGE_ADD_FILES_MAX_COUNT,
  KNOWLEDGE_FILE_MAX_BYTES,
  knowledgeDocumentFormatOf
} from "@work-shape/catalyst-core";
import type { BadgeTone } from "@work-shape/catalyst-ui";
import type { TranslationKey } from "../../shared/i18n";
import type {
  KnowledgeBaseState,
  KnowledgeDocument,
  KnowledgeOpenableFile
} from "./knowledge-base-source";

// The form of a Knowledge Base's page and its definition. The definition is the whole config
// of a revision: what the form does not show, the instance does not take either.

/** One table the Knowledge Base describes, with the sentence an agent reads about a row of it. */
export interface KnowledgeTableForm {
  name: string;
  description: string;
}

/**
 * What a Knowledge Base answers from: documents it keeps in a store of its own, or tables of a
 * Data Store it describes. A definition with a `backend` describes tables; one without keeps
 * documents (the built-in backend).
 */
export type KnowledgeBaseHolds = "documents" | "tables";

/**
 * How a Knowledge Base the page starts searches its documents: by words. Search by meaning
 * needs an embedding model the instance approves, which the page cannot read yet (KB-5d).
 */
const NEW_DOCUMENT_METHODS: readonly string[] = ["keyword"];

export interface KnowledgeBaseForm {
  name: string;
  title: string;
  description: string;
  holds: KnowledgeBaseHolds;
  /**
   * The search methods of a Knowledge Base of documents, kept as its definition names them.
   * Empty where it names none.
   */
  methods: string[];
  /** The id of the Data Store whose tables it describes. Empty until one is chosen. */
  dataStore: string;
  tables: KnowledgeTableForm[];
}

function text(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function member(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

export function knowledgeBaseConfigToForm(config: Record<string, unknown>): KnowledgeBaseForm {
  const store = member(config.backend, "dataStore");
  const tables = Array.isArray(config.tables) ? config.tables : [];
  const methods = Array.isArray(config.methods)
    ? config.methods.filter((method: unknown) => typeof method === "string")
    : [];
  return {
    name: text(config, "name"),
    title: text(config, "title"),
    description: text(config, "description"),
    holds: config.backend === undefined && !methods.includes("structured") ? "documents" : "tables",
    methods: methods.includes("structured") ? [...NEW_DOCUMENT_METHODS] : methods,
    dataStore: typeof store === "string" ? store : "",
    tables: tables.flatMap((table: unknown) => {
      const name = member(table, "name");
      const description = member(table, "description");
      return typeof name === "string"
        ? [{ name, description: typeof description === "string" ? description : "" }]
        : [];
    })
  };
}

/**
 * The definition a save writes. Over a Data Store it answers the method `structured` alone;
 * with documents it names no backend and keeps its search methods.
 */
export function knowledgeBaseFormToConfig(form: KnowledgeBaseForm): Record<string, unknown> {
  const about = {
    name: form.name,
    title: form.title.trim(),
    description: form.description.trim()
  };
  if (form.holds === "documents") {
    // A definition without methods searches by both, as the instance reads it: it stays so.
    return { ...about, ...(form.methods.length > 0 ? { methods: form.methods } : {}) };
  }
  return {
    ...about,
    methods: ["structured"],
    backend: { dataStore: form.dataStore },
    tables: form.tables.map((table) => ({
      name: table.name,
      description: table.description.trim()
    }))
  };
}

/**
 * A Knowledge Base as the dialog that starts one leaves it: its id and its name. It starts with
 * documents, the choice its page offers first.
 */
export function startedKnowledgeBaseForm(start: {
  name: string;
  title: string;
}): KnowledgeBaseForm {
  return {
    name: start.name,
    title: start.title,
    description: "",
    holds: "documents",
    methods: [...NEW_DOCUMENT_METHODS],
    dataStore: "",
    tables: []
  };
}

/**
 * The tables the Source section lists: those of the store, in its order, and after them each
 * described table the store does not have, so a description is never lost from sight.
 */
export function knowledgeTableRows(
  storeTables: readonly string[],
  described: readonly KnowledgeTableForm[]
): { name: string; inStore: boolean; described: KnowledgeTableForm | undefined }[] {
  const byName = new Map(described.map((table) => [table.name, table]));
  return [
    ...storeTables.map((name) => ({ name, inStore: true, described: byName.get(name) })),
    ...described
      .filter((table) => !storeTables.includes(table.name))
      .map((table) => ({ name: table.name, inStore: false, described: table }))
  ];
}

/** How a state is shown: its badge. */
export const KNOWLEDGE_STATUS_VIEWS: Record<
  KnowledgeBaseState["status"],
  { tone: BadgeTone; label: TranslationKey }
> = {
  preparing: { tone: "info", label: "knowledge.statusPreparing" },
  ok: { tone: "success", label: "knowledge.statusOk" },
  needs_attention: { tone: "warning", label: "knowledge.statusNeedsAttention" },
  unchecked: { tone: "neutral", label: "knowledge.statusUnchecked" }
};

/** How a document's state is shown: its badge. */
export const KNOWLEDGE_DOCUMENT_STATE_VIEWS: Record<
  KnowledgeDocument["state"],
  { tone: BadgeTone; label: TranslationKey }
> = {
  pending: { tone: "info", label: "knowledge.documentPending" },
  indexed: { tone: "success", label: "knowledge.documentIndexed" },
  failed: { tone: "danger", label: "knowledge.documentFailed" }
};

/** Why a document failed, in a sentence a person reads: one for every code the instance sends. */
export const KNOWLEDGE_DOCUMENT_FAILURES: Record<
  NonNullable<KnowledgeDocument["failureCode"]>,
  TranslationKey
> = {
  knowledge_file_format_unsupported: "knowledge.failureFormatUnsupported",
  knowledge_file_over_limit: "knowledge.failureOverLimit",
  knowledge_file_unreadable: "knowledge.failureFileUnreadable",
  knowledge_file_missing: "knowledge.failureFileMissing",
  knowledge_extraction_failed: "knowledge.failureExtraction",
  knowledge_file_format_unavailable: "knowledge.failureFormatUnavailable",
  knowledge_text_unreadable: "knowledge.failureTextUnreadable",
  knowledge_text_empty: "knowledge.failureTextEmpty",
  knowledge_index_failed: "knowledge.failureIndex",
  knowledge_file_too_many_pages: "knowledge.failureTooManyPages",
  knowledge_processor_output_invalid: "knowledge.failureProcessorOutput",
  knowledge_conversion_timeout: "knowledge.failureConversionTimeout"
};

/**
 * The sentence of why a document failed. A failed one without a code gets the general one. A
 * document over the page limit names the limit when the instance sent it (`{limit}`); an older
 * instance sends none, and the sentence names no number. A conversion that took too long names
 * the document's page count the same way (`{count}`).
 */
export function documentFailureText(document: KnowledgeDocument): TranslationKey {
  if (document.failureCode === undefined) {
    return "knowledge.failureIndex";
  }
  if (
    document.failureCode === "knowledge_file_too_many_pages" &&
    document.failurePageLimit !== undefined
  ) {
    return "knowledge.failureTooManyPagesLimit";
  }
  if (
    document.failureCode === "knowledge_conversion_timeout" &&
    document.failurePageCount !== undefined
  ) {
    return "knowledge.failureConversionTimeoutPages";
  }
  return KNOWLEDGE_DOCUMENT_FAILURES[document.failureCode];
}

/** The limits of one Add: how many files at once, and how large each may be. */
export const KNOWLEDGE_ADD_LIMITS = {
  files: KNOWLEDGE_ADD_FILES_MAX_COUNT,
  bytes: KNOWLEDGE_FILE_MAX_BYTES
} as const;

/**
 * Whether the Add dialog lets a file be chosen, and the reason it does not: a format no
 * Knowledge Base reads, or a file over the size limit. The call refuses both.
 */
export function addableFile(
  file: Pick<KnowledgeOpenableFile, "name" | "mimeType" | "bytes">
): { addable: true } | { addable: false; reason: TranslationKey } {
  const format = knowledgeDocumentFormatOf({
    filename: file.name,
    ...(file.mimeType ? { mimeType: file.mimeType } : {})
  });
  if (format === undefined) {
    return { addable: false, reason: "knowledge.addFormatRefused" };
  }
  if (file.bytes > KNOWLEDGE_ADD_LIMITS.bytes) {
    return { addable: false, reason: "knowledge.addTooLarge" };
  }
  return { addable: true };
}

/**
 * What a refused Add says, by the reason the instance named. A reason the page does not know
 * shows the instance's own sentence.
 */
export const KNOWLEDGE_ADD_REFUSALS: Partial<Record<string, TranslationKey>> = {
  knowledge_file_not_available: "knowledge.addRefusedNotAvailable",
  knowledge_file_format_unsupported: "knowledge.addFormatRefused",
  knowledge_file_format_unavailable: "knowledge.failureFormatUnavailable",
  knowledge_file_too_large: "knowledge.addRefusedTooLarge",
  knowledge_documents_limit: "knowledge.addRefusedDocumentsLimit",
  knowledge_store_not_ready: "knowledge.addRefusedStoreNotReady",
  knowledge_files_unavailable: "knowledge.addRefusedFilesUnavailable"
};

/**
 * What a refused removal says, by the reason the instance named. A reason the page does not
 * know shows the instance's own sentence.
 */
export const KNOWLEDGE_REMOVE_REFUSALS: Partial<Record<string, TranslationKey>> = {
  knowledge_synced_document_remove_refused: "knowledge.removeSyncedRefused"
};
