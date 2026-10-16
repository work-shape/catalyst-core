import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@work-shape/catalyst-api-client";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorCode } from "../../shared/workspace-utils";
import { instanceSentence, PendingApprovalError } from "./build-refusals";

/** The state of one published Knowledge Base, as `knowledge_bases.get` answers it. */
export type KnowledgeBaseState = Awaited<ReturnType<ApiClient["knowledge_bases"]["get"]>>;
/** The rows a query answers, with the Knowledge Base and its tables as their source. */
export type KnowledgeQueryAnswer = Awaited<ReturnType<ApiClient["knowledge_bases"]["query"]>>;

/** How many Data Stores one search of the chooser asks the instance for. */
const DATA_STORE_CHOICE_PAGE_SIZE = 50;
/** How many Knowledge Bases one search of an agent's chooser asks the instance for. */
const KNOWLEDGE_BASE_CHOICE_PAGE_SIZE = 50;

/** One answer of the instance, as the page asked for it. */
export type KnowledgeRead<Answer> =
  | { status: "loading" }
  /** The instance answered that this person may not read this. */
  | { status: "refused" }
  /** The read failed. The sentence is the instance's own, where it sent one. */
  | { status: "failed"; message: string | undefined; retry(): void }
  | { status: "ready"; data: Answer };

/** One asset a chooser offers: its id, its name and the line under it. */
export interface KnowledgeChoice {
  name: string;
  title: string;
  description?: string;
}

/** What a call that may fail answers: its result, or the sentence of why it did not run. */
type KnowledgeCall<Answer> =
  { ok: true; data: Answer } | { ok: false; refused: boolean; message: string | undefined };

/**
 * Everything the Knowledge Base page and the agent's Knowledge section read and call beyond
 * the asset the frame hands them. The page is handed this and reads nothing else, so a test
 * hands it answers of its own. The page's definition itself is saved and published by the
 * frame.
 */
export interface KnowledgeBaseSource {
  /** A hook: what the last check of the published revision found. */
  useState(knowledgeBase: string, publishedRevision: number): KnowledgeRead<KnowledgeBaseState>;
  /** Checks the published revision now. */
  check(knowledgeBase: string): Promise<KnowledgeCall<KnowledgeBaseState>>;
  /** Runs one read-only statement on the published revision. */
  query(knowledgeBase: string, sql: string): Promise<KnowledgeCall<KnowledgeQueryAnswer>>;
  /** A hook: the Data Stores the reader may read whose name or id holds `search`. */
  useDataStores(search: string): KnowledgeRead<readonly KnowledgeChoice[]>;
  /** A hook: the tables of one Data Store. Without a store it reads nothing and stays loading. */
  useStoreTables(store: string | undefined): KnowledgeRead<readonly string[]>;
  /**
   * A hook: the Knowledge Bases the reader may see whose name or id holds `search`. It reads
   * nothing while `enabled` is false, as where the instance has no Knowledge Bases.
   */
  useKnowledgeBases(search: string, enabled: boolean): KnowledgeRead<readonly KnowledgeChoice[]>;
}

/** The Knowledge Base pages on the instance's own operations. */
export function useKnowledgeBaseSource(): KnowledgeBaseSource {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const queryClient = useQueryClient();
  const key = (read: string, ...parts: (string | number)[]) => [
    "knowledge-base",
    apiBaseUrl,
    authScope,
    read,
    ...parts
  ];
  return {
    useState: (knowledgeBase, publishedRevision) =>
      useRead(key("state", knowledgeBase, publishedRevision), (signal) =>
        client.knowledge_bases.get({ params: { knowledgeBase }, signal })
      ),
    check: (knowledgeBase) =>
      called(async () => {
        const outcome = await client.knowledge_bases.check({ params: { knowledgeBase } });
        if (outcome.status !== "done") throw new PendingApprovalError();
        // Every read of the state shows what this check found.
        queryClient.setQueriesData({ queryKey: key("state", knowledgeBase) }, outcome.output);
        return outcome.output;
      }),
    query: (knowledgeBase, sql) =>
      called(() => client.knowledge_bases.query({ params: { knowledgeBase }, body: { sql } })),
    useDataStores: (search) =>
      useChoices(client, key("choice", "data_store", search), {
        kind: "data_store",
        search,
        limit: DATA_STORE_CHOICE_PAGE_SIZE,
        enabled: true
      }),
    useStoreTables: (store) =>
      useRead(
        key("tables", store ?? ""),
        async (signal) =>
          (
            await client.data_stores.describe({ params: { store: store ?? "" }, signal })
          ).tables.map((table) => table.name),
        { enabled: store !== undefined }
      ),
    useKnowledgeBases: (search, enabled) =>
      useChoices(client, key("choice", "knowledge_base", search), {
        kind: "knowledge_base",
        search,
        limit: KNOWLEDGE_BASE_CHOICE_PAGE_SIZE,
        enabled
      })
  };
}

/** The assets of one kind whose name or id holds the search, one page of them. */
function useChoices(
  client: ApiClient,
  queryKey: (string | number)[],
  {
    kind,
    search,
    limit,
    enabled
  }: { kind: string; search: string; limit: number; enabled: boolean }
): KnowledgeRead<readonly KnowledgeChoice[]> {
  return useRead(
    queryKey,
    async (signal) =>
      (
        await client.assets.list({
          params: { kind },
          query: { limit, ...(search ? { text: search } : {}) },
          signal
        })
      ).items.map((asset) => ({
        name: asset.name,
        title: asset.title,
        ...(asset.description ? { description: asset.description } : {})
      })),
    { keepPrevious: true, enabled }
  );
}

async function called<Answer>(call: () => Promise<Answer>): Promise<KnowledgeCall<Answer>> {
  try {
    return { ok: true, data: await call() };
  } catch (error) {
    return {
      ok: false,
      refused: apiErrorCode(error) === "FORBIDDEN",
      message: instanceSentence(error)
    };
  }
}

function useRead<Answer>(
  queryKey: (string | number)[],
  read: (signal: AbortSignal) => Promise<Answer>,
  options: { enabled?: boolean; keepPrevious?: boolean } = {}
): KnowledgeRead<Answer> {
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => read(signal),
    retry: false,
    enabled: options.enabled ?? true,
    ...(options.keepPrevious ? { placeholderData: keepPreviousData } : {})
  });
  // What was read stays while it is read again: the page does not blink.
  if (query.data !== undefined) {
    return { status: "ready", data: query.data };
  }
  if (query.error && !query.isFetching) {
    if (apiErrorCode(query.error) === "FORBIDDEN") {
      return { status: "refused" };
    }
    return {
      status: "failed",
      message: instanceSentence(query.error),
      retry: () => void query.refetch().catch(() => undefined)
    };
  }
  return { status: "loading" };
}
