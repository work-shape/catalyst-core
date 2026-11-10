import { z } from "zod";
import type { KnowledgeSearchAnswer } from "@work-shape/catalyst-core";
import type { DataStoreRuntime } from "../../runtime";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { knowledgeBaseDefinitionSchema } from "../definition";
import { sourceBoundaryKey, withinSource } from "../source-boundary";

/** A boundary publish commits in the platform database, while tombstones are batched in
 * the owned database. Until that job catches up, gate search and record proposals against
 * the current published definition. A failed publish never changes visibility. */
export async function visibleSourceDocumentIds(
  runtime: DataStoreRuntime,
  knowledgeBaseId: string,
  name: string,
  documentIds: readonly string[],
  read: <T>(work: (sql: PostgresChangeStatements) => Promise<T>) => Promise<T>
): Promise<Set<string>> {
  return (await visibleSources(runtime, knowledgeBaseId, name, documentIds, read)).visible;
}

/** The dates a citation of a synced document shows (KB-WEB). */
interface SourceDates {
  /** The date the item states of its version, such as a web page's "Stand". */
  statedAt?: string;
  /** When the platform fetched the version the index holds. */
  retrievedAt?: string;
}

const UTC_SECONDS = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

/**
 * The visible documents, and the dates of each synced one, read with them so a search touches
 * the source's items once.
 */
async function visibleSources(
  runtime: DataStoreRuntime,
  knowledgeBaseId: string,
  name: string,
  documentIds: readonly string[],
  read: <T>(work: (sql: PostgresChangeStatements) => Promise<T>) => Promise<T>
): Promise<{ visible: Set<string>; dates: Map<string, SourceDates> }> {
  const none = { visible: new Set<string>(), dates: new Map<string, SourceDates>() };
  if (!documentIds.length) return none;
  const rows = await read(async (sql) =>
    z
      .array(
        z.object({
          id: z.string(),
          source_id: z.string().nullable(),
          definition_key: z.string().nullable(),
          parents: z.array(z.string()).nullable(),
          name: z.string().nullable(),
          path: z.string().nullable(),
          stated_at: z.string().nullable(),
          fetched_at: z.string().nullable()
        })
      )
      .parse(
        await sql.run(
          `select d.id,i.source_id,i.parents,i.name,i.path,seen.definition_key,pg_catalog.to_char(i.stated_at at time zone 'UTC',${UTC_SECONDS}) as stated_at,pg_catalog.to_char(i.fetched_at at time zone 'UTC',${UTC_SECONDS}) as fetched_at from catalyst_kb.documents d left join catalyst_kb.source_items i on i.id=d.source_item_id left join catalyst_kb.sync_runs seen on seen.id=i.seen_run_id where d.id=any($1::text[]) and d.withdrawn_at is null`,
          [[...documentIds]]
        )
      )
  );
  const liveIds = new Set(rows.map((row) => row.id));
  const dates = new Map(
    rows.map((row) => [
      row.id,
      {
        ...(row.stated_at === null ? {} : { statedAt: row.stated_at }),
        ...(row.fetched_at === null ? {} : { retrievedAt: row.fetched_at })
      }
    ])
  );
  if (!rows.some((row) => row.source_id !== null)) return { visible: liveIds, dates };
  const asset = await runtime.stores.configAssets.getConfigAsset({
    clientInstanceId: runtime.clientInstanceId,
    kind: "knowledge_base",
    name
  });
  if (!asset || asset.id !== knowledgeBaseId || asset.status !== "active") return none;
  const definition = knowledgeBaseDefinitionSchema.parse(asset.publishedConfig);
  const hidden = new Set(
    rows
      .filter((row) => {
        if (row.source_id === null) return false;
        // A Workflow-fed source has no boundary in the definition: its runs decide (KBW-1).
        if (row.source_id.startsWith("workflow:")) return false;
        const source = definition.sources?.find((source) => source.id === row.source_id);
        return (
          !source ||
          !row.parents ||
          // No operated source predates migration 5. Trust its null listing key;
          // a known key is trusted only at the boundary that listed the item.
          (row.parents.length === 0 &&
            row.definition_key !== null &&
            row.definition_key !== sourceBoundaryKey(source)) ||
          row.name === null ||
          row.path === null ||
          !withinSource(source, { parents: row.parents, name: row.name, path: row.path })
        );
      })
      .map((row) => row.id)
  );
  return { visible: new Set([...liveIds].filter((id) => !hidden.has(id))), dates };
}

/** Search and proposal admission use the same decision, including pending source cleanup. */
export async function visibleSourceHits(
  runtime: DataStoreRuntime,
  knowledgeBaseId: string,
  name: string,
  answer: KnowledgeSearchAnswer,
  read: <T>(work: (sql: PostgresChangeStatements) => Promise<T>) => Promise<T>
): Promise<KnowledgeSearchAnswer> {
  const { visible, dates } = await visibleSources(
    runtime,
    knowledgeBaseId,
    name,
    answer.hits.map((hit) => hit.documentId),
    read
  );
  return {
    ...answer,
    hits: answer.hits.flatMap((hit) => {
      if (!visible.has(hit.documentId)) return [];
      return [{ ...hit, ...dates.get(hit.documentId) }];
    })
  };
}
