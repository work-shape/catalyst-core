import { z } from "zod";
import {
  isKnowledgeKeywordLanguage,
  KNOWLEDGE_KEYWORD_LANGUAGE_CONFIGS,
  KNOWLEDGE_KEYWORD_LANGUAGES,
  type KnowledgeKeywordLanguage,
  type KnowledgeKeywordLanguageState
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";

// The keyword languages of a Knowledge Base on the built-in backend (KB-12). Spec: Indexing
// settings on the Knowledge Base, check 90.
//
// Each language is one column `search_<code>` of `catalyst_kb.chunks` and one GIN index on it.
// The store itself says which languages search reads: those whose index is named
// `chunks_search_<code>_idx` and valid. A column without that index is being built. The
// trigger `chunk_keywords` fills every column there is for each chunk written, so a chunk
// written while a column is built has its words too.
//
// A change is made in steps, none of which holds a lock search waits for long:
// 1. one short transaction adds the missing columns and writes the trigger anew;
// 2. batches of their own transactions fill the new columns of the chunks already there;
// 3. each new column is indexed concurrently, under a name search does not read yet;
// 4. one transaction switches: it names those indexes as search reads them and drops the
//    columns, with their indexes, of the languages no longer listed.
// A search locks `chunks` before it reads the languages (`searchedKeywordLanguages`), so it
// never reads a column the switch drops. Nothing is embedded, and an interrupted change goes
// on from where it stopped.

/** How long one transaction of the change may take: a batch filled, the switch. */
const KEYWORD_STEP_TIMEOUT_MS = 30_000;

/** How long a concurrent index build may take. */
const KEYWORD_INDEX_TIMEOUT_MS = 30 * 60_000;

/** How long a step waits for the lock on `chunks` before it fails and its job tries again. */
const KEYWORD_LOCK_TIMEOUT = "5s";

/** How many chunks one transaction fills. */
const KEYWORD_FILL_BATCH = 500;

const column = (language: KnowledgeKeywordLanguage) => `search_${language}`;
const searchedIndex = (language: KnowledgeKeywordLanguage) => `chunks_search_${language}_idx`;
const buildingIndex = (language: KnowledgeKeywordLanguage) => `chunks_search_${language}_build`;
const config = (language: KnowledgeKeywordLanguage) =>
  `'${KNOWLEDGE_KEYWORD_LANGUAGE_CONFIGS[language]}'::regconfig`;

/** The text-search vector of a chunk's text in `language`, for SQL. */
function keywordVector(language: KnowledgeKeywordLanguage, text: string): string {
  return `pg_catalog.to_tsvector(${config(language)}, ${text})`;
}

/** The SQL that reads chunk `c`'s full-text column of `language`. */
export function keywordColumn(language: KnowledgeKeywordLanguage, alias: string): string {
  return `${alias}.${column(language)}`;
}

/** The query `$1` as `websearch_to_tsquery` of `language`. */
export function keywordQuery(language: KnowledgeKeywordLanguage): string {
  return `pg_catalog.websearch_to_tsquery(${config(language)}, $1::pg_catalog.text)`;
}

/** Each word of the query `$1` by the stems of `language`, any of which counts. */
export function keywordWordsQuery(language: KnowledgeKeywordLanguage): string {
  return `pg_catalog.to_tsquery(${config(language)}, pg_catalog.replace(
    pg_catalog.plainto_tsquery(${config(language)}, $1::pg_catalog.text)::pg_catalog.text,
    ' & ', ' | '))`;
}

const nameRow = z.object({ name: z.string() });

/** In the order of `KNOWLEDGE_KEYWORD_LANGUAGES`, the languages of the names that match. */
function languagesOf(names: readonly string[], pattern: RegExp): KnowledgeKeywordLanguage[] {
  const found = new Set(
    names.flatMap((name) => {
      const code = pattern.exec(name)?.[1];
      return code !== undefined && isKnowledgeKeywordLanguage(code) ? [code] : [];
    })
  );
  return KNOWLEDGE_KEYWORD_LANGUAGES.filter((language) => found.has(language));
}

/** The languages that have a column on `chunks`. */
async function columnLanguages(sql: PostgresChangeStatements) {
  const rows = z.array(nameRow).parse(
    await sql.run(
      `select attname as name from pg_catalog.pg_attribute
       where attrelid = 'catalyst_kb.chunks'::regclass and attnum > 0 and not attisdropped
         and attname ~ '^search_[a-z]{2}$'`
    )
  );
  return languagesOf(
    rows.map((row) => row.name),
    /^search_([a-z]{2})$/u
  );
}

/** The valid indexes on `chunks` whose name is one of a keyword language. */
async function indexNames(sql: PostgresChangeStatements, valid: boolean) {
  const rows = z.array(nameRow).parse(
    await sql.run(
      `select c.relname as name from pg_catalog.pg_index x
       join pg_catalog.pg_class c on c.oid = x.indexrelid
       where x.indrelid = 'catalyst_kb.chunks'::regclass and x.indisvalid = $1::pg_catalog.bool
         and c.relname ~ '^chunks_search_[a-z]{2}_(idx|build)$'`,
      [valid]
    )
  );
  return rows.map((row) => row.name);
}

/** The languages whose index search reads, without a lock. */
async function readLanguages(sql: PostgresChangeStatements) {
  return languagesOf(await indexNames(sql, true), /^chunks_search_([a-z]{2})_idx$/u);
}

/**
 * The languages search reads, in a search's transaction. It locks `chunks` first, so a switch
 * that drops a column waits for this search to end, and a switch done before it is read.
 */
export async function searchedKeywordLanguages(
  sql: PostgresChangeStatements
): Promise<KnowledgeKeywordLanguage[]> {
  await sql.run("lock table catalyst_kb.chunks in access share mode");
  return readLanguages(sql);
}

/** What the store searches and builds. */
export async function keywordLanguageState(
  sql: PostgresChangeStatements
): Promise<KnowledgeKeywordLanguageState> {
  const searched = await readLanguages(sql);
  const building = (await columnLanguages(sql)).filter((language) => !searched.includes(language));
  return { searched, building };
}

/** Whether the store's tables fill their keyword columns by trigger: migration 18 is applied. */
async function hasKeywordTrigger(sql: PostgresChangeStatements): Promise<boolean> {
  const [row] = z
    .array(z.object({ present: z.boolean() }))
    .parse(
      await sql.run(
        "select pg_catalog.to_regprocedure('catalyst_kb.chunk_keywords()') is not null as present"
      )
    );
  return row?.present === true;
}

/** The trigger function that fills the columns of `languages` for each chunk written. */
function keywordTriggerFunction(languages: readonly KnowledgeKeywordLanguage[]): string {
  const assignments = languages
    .map((language) => `new.${column(language)} := ${keywordVector(language, "new.text")};`)
    .join("\n    ");
  return `create or replace function catalyst_kb.chunk_keywords() returns trigger
  language plpgsql as $$
  begin
    ${assignments}
    return new;
  end $$;`;
}

/** Runs one transaction of the store, or one statement outside of one. */
export type KeywordStoreRun = <T>(
  what: string,
  options: { timeoutMs: number; transaction?: false },
  work: (sql: PostgresChangeStatements) => Promise<T>
) => Promise<T>;

/** Brings the store to `languages`, as the module comment says. Answers the state after. */
export async function applyKeywordLanguages(
  run: KeywordStoreRun,
  target: readonly KnowledgeKeywordLanguage[],
  signal?: AbortSignal
): Promise<KnowledgeKeywordLanguageState> {
  if (target.length === 0) throw new RangeError("A Knowledge Base keeps one keyword language");
  const wanted = KNOWLEDGE_KEYWORD_LANGUAGES.filter((language) => target.includes(language));
  const step = { timeoutMs: KEYWORD_STEP_TIMEOUT_MS };
  // 1. The missing columns, and the trigger that fills every column there is.
  const added = await run("Adding keyword columns", step, async (sql) => {
    await sql.run(`set local lock_timeout = '${KEYWORD_LOCK_TIMEOUT}'`);
    if (!(await hasKeywordTrigger(sql))) return undefined;
    const state = await keywordLanguageState(sql);
    const present = [...state.searched, ...state.building];
    const missing = wanted.filter((language) => !present.includes(language));
    if (missing.length > 0) {
      for (const language of missing) {
        await sql.run(`alter table catalyst_kb.chunks add column ${column(language)} tsvector`);
      }
      await sql.script(keywordTriggerFunction(await columnLanguages(sql)));
    }
    return { ...state, building: [...state.building, ...missing] };
  });
  // A store whose tables are older than migration 18 is changed once it has it.
  if (!added) return run("Reading keyword languages", step, keywordLanguageState);
  const building = added.building.filter((language) => wanted.includes(language));
  // 2. The chunks written before the trigger filled the new columns.
  if (building.length > 0) {
    const empty = building.map((language) => `${column(language)} is null`).join(" or ");
    const fill = building
      .map(
        (language) =>
          `${column(language)} = coalesce(${column(language)}, ${keywordVector(language, "text")})`
      )
      .join(", ");
    // A chunk written meanwhile is filled by the trigger; one a writer holds is waited for.
    for (;;) {
      signal?.throwIfAborted();
      const filled = await run("Filling keyword columns", step, async (sql) =>
        z.array(z.object({ id: z.string() })).parse(
          await sql.run(
            `update catalyst_kb.chunks set ${fill}
             where id in (
               select id from catalyst_kb.chunks where ${empty}
               order by id limit ${KEYWORD_FILL_BATCH}
             )
             returning id`
          )
        )
      );
      if (filled.length > 0) continue;
      // None filled: done, unless the chunks it chose were removed while it waited for them.
      const [left] = await run("Counting keyword columns to fill", step, async (sql) =>
        z
          .array(z.object({ left: z.boolean() }))
          .parse(
            await sql.run(`select exists (select 1 from catalyst_kb.chunks where ${empty}) as left`)
          )
      );
      if (left?.left !== true) break;
    }
  }
  // 3. The index of each new column, under a name search does not read yet. One an earlier
  // attempt left invalid is dropped and built again.
  for (const language of building) {
    signal?.throwIfAborted();
    const ready = await run("Reading keyword indexes", step, async (sql) => ({
      valid: await indexNames(sql, true),
      invalid: await indexNames(sql, false)
    }));
    if (ready.valid.includes(buildingIndex(language))) continue;
    const write = { timeoutMs: KEYWORD_INDEX_TIMEOUT_MS, transaction: false as const };
    if (ready.invalid.includes(buildingIndex(language))) {
      await run("Dropping an unfinished keyword index", write, (sql) =>
        sql.run(`drop index concurrently if exists catalyst_kb.${buildingIndex(language)}`)
      );
    }
    await run("Indexing keyword column", write, (sql) =>
      sql.run(
        `create index concurrently ${buildingIndex(language)}
         on catalyst_kb.chunks using gin (${column(language)})`
      )
    );
  }
  // 4. The switch: search reads the new indexes and no longer the dropped columns.
  return run("Switching keyword languages", step, async (sql) => {
    const columns = await columnLanguages(sql);
    const valid = await indexNames(sql, true);
    const dropped = columns.filter((language) => !wanted.includes(language));
    const switched = columns.filter(
      (language) => wanted.includes(language) && valid.includes(buildingIndex(language))
    );
    if (dropped.length === 0 && switched.length === 0) return keywordLanguageState(sql);
    await sql.run(`set local lock_timeout = '${KEYWORD_LOCK_TIMEOUT}'`);
    await sql.run("lock table catalyst_kb.chunks in access exclusive mode");
    for (const language of dropped) {
      await sql.run(`alter table catalyst_kb.chunks drop column ${column(language)}`);
    }
    for (const language of switched) {
      await sql.run(
        `alter index catalyst_kb.${buildingIndex(language)} rename to ${searchedIndex(language)}`
      );
    }
    await sql.script(
      keywordTriggerFunction(columns.filter((language) => wanted.includes(language)))
    );
    return keywordLanguageState(sql);
  });
}
