import type { BadgeTone } from "@work-shape/catalyst-ui";
import type { TranslationKey } from "../../shared/i18n";
import type { KnowledgeBaseState } from "./knowledge-base-source";

// The form of a Knowledge Base's page and its definition. The definition is the whole config
// of a revision: what the form does not show, the instance does not take either.

/** One table the Knowledge Base describes, with the sentence an agent reads about a row of it. */
export interface KnowledgeTableForm {
  name: string;
  description: string;
}

export interface KnowledgeBaseForm {
  name: string;
  title: string;
  description: string;
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
  return {
    name: text(config, "name"),
    title: text(config, "title"),
    description: text(config, "description"),
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

/** The definition a save writes. It answers the method `structured` alone, over a Data Store. */
export function knowledgeBaseFormToConfig(form: KnowledgeBaseForm): Record<string, unknown> {
  return {
    name: form.name,
    title: form.title.trim(),
    description: form.description.trim(),
    methods: ["structured"],
    backend: { dataStore: form.dataStore },
    tables: form.tables.map((table) => ({
      name: table.name,
      description: table.description.trim()
    }))
  };
}

/** A Knowledge Base as the dialog that starts one leaves it: its id and its name. */
export function startedKnowledgeBaseForm(start: {
  name: string;
  title: string;
}): KnowledgeBaseForm {
  return { name: start.name, title: start.title, description: "", dataStore: "", tables: [] };
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
  ok: { tone: "success", label: "knowledge.statusOk" },
  needs_attention: { tone: "warning", label: "knowledge.statusNeedsAttention" },
  unchecked: { tone: "neutral", label: "knowledge.statusUnchecked" }
};
