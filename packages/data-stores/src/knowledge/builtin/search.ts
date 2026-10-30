import { z } from "zod";
import {
  KNOWLEDGE_RRF_K,
  KNOWLEDGE_SEARCH_LIST_DEPTH,
  type BuiltinKnowledgeTarget,
  type KnowledgeKeywordLanguage,
  type KnowledgeQueryEmbedding,
  type KnowledgeSearchAnswer,
  type KnowledgeFilterField,
  type KnowledgeSearchFilter,
  type KnowledgeSearchHit,
  type KnowledgeSearchSignal
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import {
  keywordColumn,
  keywordQuery,
  keywordWordsQuery,
  searchedKeywordLanguages
} from "./keyword-languages";

// Search over the documents of a Knowledge Base on the built-in backend: up to three ranked
// lists, fused by reciprocal rank (k = 60, equal weights) in one statement against the store
// it owns. Spec: "Search, the agent tool and citations", Indexing settings (defaults).
//
// - `semantic`: exact cosine distance between the query's embedding and the chunks' rows in
//   the active generation (`embeddings_<generation>`, `halfvec(<dimensions>)`). Only where the
//   Knowledge Base searches by meaning, a generation is active, its table is there and the
//   query could be embedded with its model.
// - `keyword`: full text with `websearch_to_tsquery` in each keyword language whose column of
//   `chunks` the store searches (KB-12; German and English unless the Knowledge Base lists
//   others). Where the Knowledge Base searches by words, and wherever `semantic` is not used, so
//   a Knowledge Base whose embeddings are not there yet still answers.
// - `title`: the words of a document's title and file name. Each passage of a document whose
//   title or file name holds a word of the query shares that document's place.
//
// Each list takes its first 50. Only chunks of a content that is indexed at its chunking
// revision and held by a document that is not withdrawn are read, in the same statement, so a
// removed document is out of the next search before its passages are deleted.
//
// Declared filters (DS-6b) narrow the documents of every list the same way: a passage counts
// only where a document that holds its content matches each filter, and it names that document.
// The column and the comparison come from the fixed tables below, chosen by the declared field
// and operator; the caller's value is always a bound parameter, never text of the statement.

/**
 * The table of one generation of embeddings and its columns: one row per chunk, keyed by the
 * chunk's id, with the vector as `halfvec(<dimensions>)`. The index job of KB-5d writes it.
 */
function knowledgeEmbeddingsTable(generation: number): string {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new RangeError(`No generation of embeddings is numbered ${generation}`);
  }
  return `catalyst_kb.embeddings_${generation}`;
}
const KNOWLEDGE_EMBEDDING_CHUNK_COLUMN = "chunk_id";
const KNOWLEDGE_EMBEDDING_VECTOR_COLUMN = "embedding";

const generationRow = z.object({
  generation: z.number().int().min(1),
  binding_id: z.string(),
  model: z.string(),
  dimensions: z.number().int().min(1).max(4_000),
  table_present: z.boolean()
});

const hitRow = z.object({
  document_id: z.string(),
  managed_file_id: z.string(),
  file_name: z.string(),
  title: z.string(),
  origin_link: z.string().nullable(),
  page: z.number().int().nullable(),
  heading: z.string().nullable(),
  text: z.string(),
  score: z.number()
});

/** The active generation of embeddings, where its table is there. */
async function activeGeneration(sql: PostgresChangeStatements) {
  const [row] = z.array(generationRow).parse(
    await sql.run(
      `select generation, binding_id, model, dimensions,
         pg_catalog.to_regclass('catalyst_kb.embeddings_' || generation) is not null
           as table_present
       from catalyst_kb.index_generations where state = 'active'`
    )
  );
  return row?.table_present ? row : undefined;
}

/** The query's embedding in the active generation's model, where it can be made. */
interface QueryVector {
  generation: number;
  dimensions: number;
  vector: readonly number[];
}

/**
 * The passages of the store that answer `query` best. `run` runs one function in one
 * transaction of the store as the platform's role; it is asked twice where the query is
 * embedded, so that no transaction is held open while the embedding provider answers.
 */
export async function searchKnowledgeStore(
  run: <T>(work: (sql: PostgresChangeStatements) => Promise<T>) => Promise<T>,
  target: Pick<BuiltinKnowledgeTarget, "methods">,
  input: {
    query: string;
    limit: number;
    embed?: KnowledgeQueryEmbedding;
    filters?: readonly KnowledgeSearchFilter[];
  }
): Promise<KnowledgeSearchAnswer> {
  const { embed } = input;
  const semanticAsked = target.methods.includes("semantic") && embed !== undefined;
  /** The query in the model of `generation`, where the instance can still embed with it. */
  const embedFor = async (
    generation: z.infer<typeof generationRow> | undefined
  ): Promise<QueryVector | undefined> => {
    if (!generation || !embed) return undefined;
    const embedded = await embed({
      bindingId: generation.binding_id,
      model: generation.model,
      dimensions: generation.dimensions
    });
    // A model that answers another length than the generation's is not the generation's.
    return embedded?.length === generation.dimensions
      ? { generation: generation.generation, dimensions: generation.dimensions, vector: embedded }
      : undefined;
  };
  const filters = input.filters ?? [];
  let vector = semanticAsked ? await embedFor(await run(activeGeneration)) : undefined;
  // A re-index switched generations between the embedding and the search (KB-8): the query is
  // embedded once more with the model now active, so the search still ranks by meaning.
  for (let attempt = 0; ; attempt += 1) {
    let signals: KnowledgeSearchSignal[] = [];
    let switched: z.infer<typeof generationRow> | undefined;
    const rows = await run(async (sql) => {
      // The generation may have switched since it was read and its table be gone: it is read
      // again in the transaction of the search, and a vector of another generation is not used.
      const current = vector && (await activeGeneration(sql));
      const semantic = vector && current?.generation === vector.generation ? vector : undefined;
      if (vector && !semantic && current && attempt === 0) {
        switched = current;
        return undefined;
      }
      const languages = await searchedKeywordLanguages(sql);
      signals = signalsOf(target.methods, semantic !== undefined, languages.length > 0);
      return z
        .array(hitRow)
        .parse(
          await sql.run(searchStatement(signals, semantic, languages, filters), [
            input.query,
            input.limit,
            ...(semantic ? [`[${semantic.vector.join(",")}]`] : []),
            ...filters.map((filter) => filter.value)
          ])
        );
    });
    if (rows) return { hits: rows.map(hitOf), signals };
    vector = await embedFor(switched);
  }
}

/**
 * The lists a search fuses: by meaning where it can, by words where the Knowledge Base
 * searches by words or by meaning cannot be used and the store has a keyword language, and by
 * title always.
 */
function signalsOf(
  methods: BuiltinKnowledgeTarget["methods"],
  semantic: boolean,
  keywords: boolean
): KnowledgeSearchSignal[] {
  return [
    ...(semantic ? (["semantic"] as const) : []),
    ...(keywords && (methods.includes("keyword") || !semantic) ? (["keyword"] as const) : []),
    "title"
  ];
}

function hitOf(row: z.infer<typeof hitRow>): KnowledgeSearchHit {
  return {
    documentId: row.document_id,
    fileId: row.managed_file_id,
    fileName: row.file_name,
    title: row.title,
    ...(row.page === null ? {} : { page: row.page }),
    ...(row.heading === null ? {} : { heading: row.heading }),
    text: row.text,
    score: row.score,
    ...(row.origin_link === null ? {} : { originLink: row.origin_link })
  };
}

/**
 * The value of a filter's field for document `d`, typed as its filter compares it. Each is fixed
 * text: what a declaration names picks one, and nothing of a caller reaches it.
 */
const FILTER_FIELD_SQL: Record<KnowledgeFilterField, string> = {
  title: "d.title",
  file_name: "d.file_name",
  document_type: `(select pg_catalog.coalesce(fc.document_type, 'default') from catalyst_kb.contents fc
    where fc.sha256 = d.content_sha256)`,
  source: `(select fi.source_id from catalyst_kb.source_items fi where fi.id = d.source_item_id)`,
  path: `(select fi.path from catalyst_kb.source_items fi where fi.id = d.source_item_id)`,
  added_at: `(d.added_at at time zone 'UTC')::pg_catalog.date`,
  modified_at: `(select (fi.modified_at at time zone 'UTC')::pg_catalog.date
    from catalyst_kb.source_items fi where fi.id = d.source_item_id)`
};

/** The fields a filter compares as dates; every other one as text. */
const DATE_FIELDS: ReadonlySet<KnowledgeFilterField> = new Set(["added_at", "modified_at"]);

/** A field's comparison with parameter `$n`, of the fixed comparisons a filter may name. */
function filterCondition(filter: KnowledgeSearchFilter, parameter: number): string {
  const field = FILTER_FIELD_SQL[filter.field];
  const value = `$${parameter}`;
  switch (filter.op) {
    case "prefix":
      return `pg_catalog.starts_with(${field}, ${value}::pg_catalog.text)`;
    case "gt":
      return `${field} > ${value}::pg_catalog.date`;
    case "gte":
      return `${field} >= ${value}::pg_catalog.date`;
    case "lt":
      return `${field} < ${value}::pg_catalog.date`;
    case "lte":
      return `${field} <= ${value}::pg_catalog.date`;
    case "eq":
      return DATE_FIELDS.has(filter.field)
        ? `${field} = ${value}::pg_catalog.date`
        : `${field} = ${value}::pg_catalog.text`;
  }
}

/**
 * The conditions on document `d` of every filter, each comparing with its own parameter from
 * `first` on, in the order of `filters`. Empty without filters.
 */
function documentFilter(filters: readonly KnowledgeSearchFilter[], first: number): string {
  return filters.map((filter, index) => ` and ${filterCondition(filter, first + index)}`).join("");
}

/**
 * Whether chunk `c` is of an indexed content that a document not withdrawn holds, one that
 * matches `filter` where there is one.
 */
const liveChunk = (filter: string) => `exists (
    select 1 from catalyst_kb.contents ct
    where ct.sha256 = c.content_sha256 and ct.state = 'extracted'
      and ct.chunking_revision = c.chunking_revision
  )
  and exists (
    select 1 from catalyst_kb.documents d
    where d.content_sha256 = c.content_sha256 and d.withdrawn_at is null${filter}
  )`;

/**
 * The one statement of a search. `$1` is the query, `$2` the limit and `$3` the query's
 * vector as text, where it is used; the filters' values follow, one parameter each. Only the
 * generation's number and dimensions, whole numbers the store answered, are written into the
 * text.
 */
function searchStatement(
  signals: readonly KnowledgeSearchSignal[],
  semantic: Pick<QueryVector, "generation" | "dimensions"> | undefined,
  languages: readonly KnowledgeKeywordLanguage[],
  filters: readonly KnowledgeSearchFilter[]
): string {
  const depth = KNOWLEDGE_SEARCH_LIST_DEPTH;
  const filter = documentFilter(filters, semantic ? 4 : 3);
  const LIVE_CHUNK = liveChunk(filter);
  const lists: string[] = [];
  // Only the codes of `KNOWLEDGE_KEYWORD_LANGUAGES` the store answered are written into the text.
  const keywords = signals.includes("keyword") ? languages : [];
  const queries = keywords.flatMap((language) => [
    `${keywordQuery(language)} as k_${language}`,
    `${keywordWordsQuery(language)} as k_${language}_words`
  ]);
  /** The best rank of chunk `c` in any language, for the query `q.k_<language><suffix>`. */
  const rank = (suffix: string) =>
    `greatest(${keywords
      .map(
        (language) =>
          `pg_catalog.ts_rank_cd(${keywordColumn(language, "c")}, q.k_${language}${suffix})`
      )
      .join(", ")})`;
  /** Whether chunk `c` matches the query `q.k_<language><suffix>` in any language. */
  const matches = (suffix: string) =>
    `(${keywords.map((language) => `${keywordColumn(language, "c")} @@ q.k_${language}${suffix}`).join(" or ")})`;
  const parts: string[] = [
    // The words of the query by the stems of each keyword language, and every word as typed,
    // any of which counts, for titles and file names.
    `q as (
      select ${queries.map((query) => `${query},`).join("\n        ")}
        $1::pg_catalog.text !~* '(^|[[:space:]])(-|OR([[:space:]]|$))|"' as plain,
        pg_catalog.to_tsquery('simple'::regconfig, pg_catalog.replace(
          pg_catalog.plainto_tsquery('simple'::regconfig, $1::pg_catalog.text)::pg_catalog.text,
          ' & ', ' | ')) as words
    )`
  ];
  if (semantic) {
    const table = knowledgeEmbeddingsTable(semantic.generation);
    const distance = `e.${KNOWLEDGE_EMBEDDING_VECTOR_COLUMN} operator(public.<=>) $3::pg_catalog.text::public.halfvec(${semantic.dimensions})`;
    parts.push(
      `semantic as (
        select c.id, pg_catalog.row_number() over (order by ${distance}, c.id) as rank
        from ${table} e
        join catalyst_kb.chunks c on c.id = e.${KNOWLEDGE_EMBEDDING_CHUNK_COLUMN}
        where ${LIVE_CHUNK}
        order by rank limit ${depth}
      )`
    );
    lists.push("select id, rank from semantic");
  }
  if (keywords.length > 0) {
    parts.push(
      `keyword_exact as (
        select c.id, pg_catalog.row_number() over (
          order by ${rank("")} desc, c.id
        ) as rank
        from catalyst_kb.chunks c, q
        where ${matches("")} and ${LIVE_CHUNK}
        order by rank limit ${depth}
      )`
    );
    // Keep web-search phrases, exclusions and OR exact. A plain question with no exact
    // hit falls back to its individual stems, ranked by the same full-text evidence.
    parts.push(`keyword as (
      select id, rank from keyword_exact
      union all
      select c.id, pg_catalog.row_number() over (
        order by ${rank("_words")} desc, c.id
      ) as rank
      from catalyst_kb.chunks c, q
      where q.plain and not exists (select 1 from keyword_exact)
        and ${matches("_words")} and ${LIVE_CHUNK}
      order by rank limit ${depth}
    )`);
    lists.push("select id, rank from keyword");
  }
  parts.push(
    `titled as (
      select d.content_sha256,
        pg_catalog.max(pg_catalog.ts_rank(d.title_search, q.words)) as score
      from catalyst_kb.documents d, q
      where d.withdrawn_at is null and d.title_search @@ q.words${filter}
      group by d.content_sha256
      order by score desc, d.content_sha256 limit ${depth}
    )`,
    // Every passage of a document shares its place: the title says nothing of which is best.
    `title as (
      select c.id, pg_catalog.dense_rank() over (order by t.score desc, t.content_sha256) as rank
      from titled t join catalyst_kb.chunks c on c.content_sha256 = t.content_sha256
      where ${LIVE_CHUNK}
      order by rank, c.position limit ${depth}
    )`,
    `fused as (
      select id, pg_catalog.sum(1.0 / (${KNOWLEDGE_RRF_K} + rank)) as score
      from (${[...lists, "select id, rank from title"].join(" union all ")}) ranked
      group by id
    )`
  );
  return `with ${parts.join(",\n")}
    select d.id as document_id, d.managed_file_id, d.file_name, d.title, d.origin_link,
      c.page, c.heading, c.text, f.score::pg_catalog.float8 as score
    from fused f
    join catalyst_kb.chunks c on c.id = f.id
    -- The document each passage names: the first added that holds its content and matches.
    join lateral (
      select d.id, d.managed_file_id, d.file_name, d.title, d.origin_link
      from catalyst_kb.documents d
      where d.content_sha256 = c.content_sha256 and d.withdrawn_at is null${filter}
      order by d.added_at, d.id limit 1
    ) d on true
    order by f.score desc, c.id
    limit $2::pg_catalog.int4`;
}
