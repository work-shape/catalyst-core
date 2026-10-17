import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import type { ApiClient } from "@work-shape/catalyst-api-client";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorCode } from "../../shared/workspace-utils";
import { instanceSentence, PendingApprovalError, readRefusalDetails } from "./build-refusals";

/** The state of one published Knowledge Base, as `knowledge_bases.get` answers it. */
export type KnowledgeBaseState = Awaited<ReturnType<ApiClient["knowledge_bases"]["get"]>>;
/** The rows a query answers, with the Knowledge Base and its tables as their source. */
export type KnowledgeQueryAnswer = Awaited<ReturnType<ApiClient["knowledge_bases"]["query"]>>;

/** The passages a search of a Knowledge Base that keeps documents answers, best first. */
export type KnowledgeSearchAnswer = Awaited<ReturnType<ApiClient["knowledge_bases"]["search"]>>;
export type KnowledgeSearchPassage = KnowledgeSearchAnswer["passages"][number];

/** One document of a Knowledge Base that keeps documents, as `knowledge_bases.list_documents` answers it. */
export type KnowledgeDocument = Awaited<
  ReturnType<ApiClient["knowledge_bases"]["list_documents"]>
>["documents"][number];

/** A file the reader can open in a conversation of their workspace, which the Add dialog offers. */
export interface KnowledgeOpenableFile {
  conversationId: string;
  fileId: string;
  name: string;
  mimeType?: string;
  bytes: number;
  /** The title of the conversation the file is in. */
  conversationTitle: string;
}

/** The documents of a Knowledge Base, read a page at a time, newest first. */
interface KnowledgeDocumentPages {
  documents: readonly KnowledgeDocument[];
  /** Present while more documents follow. */
  more?: { loading: boolean; load(): void };
}

/**
 * Whether a document is still being indexed: the page then reads the documents again every few
 * seconds, and stops once each is searchable or failed.
 */
export function documentsStillIndexing(
  documents: readonly Pick<KnowledgeDocument, "state">[]
): boolean {
  return documents.some((document) => document.state === "pending");
}

/**
 * Whether the state of a Knowledge Base is read again every few seconds: while its store is being
 * made, while its processing waits for a worker, so the page sees it recover, and always on the
 * Documents section of a Knowledge Base that keeps documents. There a sync from a source can be
 * queued before any document exists, so no document's state tells when no worker takes it.
 */
export function knowledgeStateStillChanging(
  state: Pick<KnowledgeBaseState, "status" | "processingWaiting">,
  watchProcessing: boolean
): boolean {
  return watchProcessing || state.status === "preparing" || state.processingWaiting === true;
}

/** How many documents one page of the Documents section asks the instance for. */
const DOCUMENTS_PAGE_SIZE = 50;
/** How often the documents are read again while one of them is still being indexed. */
const DOCUMENTS_POLL_MS = 3_000;
/** How many files one search of the Add dialog asks the instance for. */
const OPENABLE_FILES_PAGE_SIZE = 50;

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

/**
 * What a call that may fail answers: its result, or the sentence of why it did not run with the
 * reason the instance named, where it named one.
 */
type KnowledgeCall<Answer> =
  | { ok: true; data: Answer }
  | { ok: false; refused: boolean; message: string | undefined; reason?: string };

/**
 * Everything the Knowledge Base page and the agent's Knowledge section read and call beyond
 * the asset the frame hands them. The page is handed this and reads nothing else, so a test
 * hands it answers of its own. The page's definition itself is saved and published by the
 * frame.
 */
export interface KnowledgeBaseSource {
  /**
   * A hook: what the last check of the published revision found, and whether its processing
   * waits for a worker. With `watchProcessing` the state is read again every few seconds, as the
   * Documents section of a Knowledge Base that keeps documents does.
   */
  useState(
    knowledgeBase: string,
    publishedRevision: number,
    watchProcessing?: boolean
  ): KnowledgeRead<KnowledgeBaseState>;
  /** Checks the published revision now. */
  check(knowledgeBase: string): Promise<KnowledgeCall<KnowledgeBaseState>>;
  /** Runs one read-only statement on the published revision. */
  query(knowledgeBase: string, sql: string): Promise<KnowledgeCall<KnowledgeQueryAnswer>>;
  /** Searches the documents of the published revision, as an agent does. */
  search(knowledgeBase: string, query: string): Promise<KnowledgeCall<KnowledgeSearchAnswer>>;
  /** A hook: the Data Stores the reader may read whose name or id holds `search`. */
  useDataStores(search: string): KnowledgeRead<readonly KnowledgeChoice[]>;
  /** A hook: the tables of one Data Store. Without a store it reads nothing and stays loading. */
  useStoreTables(store: string | undefined): KnowledgeRead<readonly string[]>;
  /**
   * A hook: the Knowledge Bases the reader may see whose name or id holds `search`. It reads
   * nothing while `enabled` is false, as where the instance has no Knowledge Bases.
   */
  useKnowledgeBases(search: string, enabled: boolean): KnowledgeRead<readonly KnowledgeChoice[]>;
  /**
   * A hook: the documents of a published Knowledge Base that keeps documents. While one of them
   * is still being indexed, they are read again every few seconds.
   */
  useDocuments(knowledgeBase: string): KnowledgeRead<KnowledgeDocumentPages>;
  /** Indexes failed documents again: each goes back to being indexed. */
  retry(knowledgeBase: string, documentIds: readonly string[]): Promise<KnowledgeCall<unknown>>;
  /**
   * Removes documents: they leave search at once, and the Knowledge Base deletes its copies
   * later. The files stay in their conversations.
   */
  remove(knowledgeBase: string, documentIds: readonly string[]): Promise<KnowledgeCall<unknown>>;
  /** Adds files the reader can open to the Knowledge Base; it keeps a copy of each. */
  addFiles(
    knowledgeBase: string,
    files: readonly { conversationId: string; fileId: string }[]
  ): Promise<KnowledgeCall<{ count: number }>>;
  /**
   * A hook: the uploaded files of the conversations in the reader's workspace whose name or
   * conversation holds `search`. It reads nothing while `enabled` is false.
   */
  useOpenableFiles(
    search: string,
    enabled: boolean
  ): KnowledgeRead<readonly KnowledgeOpenableFile[]>;
}

/** The Knowledge Base pages on the instance's own operations. */
export function useKnowledgeBaseSource(): KnowledgeBaseSource {
  const { apiBaseUrl, authScope, client, activeWorkspace } = useSettingsPage();
  const queryClient = useQueryClient();
  const key = (read: string, ...parts: (string | number)[]) => [
    "knowledge-base",
    apiBaseUrl,
    authScope,
    read,
    ...parts
  ];
  return {
    useState: (knowledgeBase, publishedRevision, watchProcessing = false) =>
      useRead(
        key("state", knowledgeBase, publishedRevision),
        (signal) => client.knowledge_bases.get({ params: { knowledgeBase }, signal }),
        { pollWhile: (state) => knowledgeStateStillChanging(state, watchProcessing) }
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
    search: (knowledgeBase, query) =>
      called(() => client.knowledge_bases.search({ params: { knowledgeBase }, body: { query } })),
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
      }),
    useDocuments: (knowledgeBase) =>
      useDocuments(client, knowledgeBase, key("documents", knowledgeBase)),
    retry: (knowledgeBase, documentIds) =>
      called(async () => {
        const outcome = await client.knowledge_bases.retry_documents({
          params: { knowledgeBase },
          body: { documentIds: [...documentIds] }
        });
        if (outcome.status !== "done") throw new PendingApprovalError();
        await queryClient.invalidateQueries({ queryKey: key("documents", knowledgeBase) });
        return outcome.output;
      }),
    remove: (knowledgeBase, documentIds) =>
      called(async () => {
        const outcome = await client.knowledge_bases.remove_documents({
          params: { knowledgeBase },
          body: { documentIds: [...documentIds] }
        });
        if (outcome.status !== "done") throw new PendingApprovalError();
        await queryClient.invalidateQueries({ queryKey: key("documents", knowledgeBase) });
        return outcome.output;
      }),
    addFiles: (knowledgeBase, files) =>
      called(async () => {
        const outcome = await client.knowledge_bases.add_files({
          params: { knowledgeBase },
          body: { files: files.map(({ conversationId, fileId }) => ({ conversationId, fileId })) }
        });
        if (outcome.status !== "done") throw new PendingApprovalError();
        await queryClient.invalidateQueries({ queryKey: key("documents", knowledgeBase) });
        return { count: outcome.output.count };
      }),
    useOpenableFiles: (search, enabled) => {
      const workspaceId = activeWorkspace?.id;
      const read = useRead(
        key("openable-files", workspaceId ?? "", search),
        async (signal) =>
          (
            await client.workspaces.files.list({
              params: { collaborationWorkspaceId: workspaceId ?? "" },
              query: {
                kind: "upload",
                limit: OPENABLE_FILES_PAGE_SIZE,
                ...(search ? { text: search } : {})
              },
              signal
            })
          ).items.map((file) => ({
            conversationId: file.conversation.id,
            fileId: file.id,
            name: file.name,
            ...(file.mimeType ? { mimeType: file.mimeType } : {}),
            bytes: file.bytes,
            conversationTitle: file.conversation.title
          })),
        { keepPrevious: true, enabled: enabled && workspaceId !== undefined }
      );
      // Outside a workspace there is no conversation whose files the reader could add.
      return workspaceId === undefined ? { status: "ready", data: [] } : read;
    }
  };
}

/**
 * The documents of one Knowledge Base, page after page as the reader asks for more. Every page
 * read is read again every few seconds while a document on it is still being indexed, so a
 * state changes on the page without a reload.
 */
function useDocuments(
  client: ApiClient,
  knowledgeBase: string,
  queryKey: (string | number)[]
): KnowledgeRead<KnowledgeDocumentPages> {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      client.knowledge_bases.list_documents({
        params: { knowledgeBase },
        query: { limit: DOCUMENTS_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
        signal
      }),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    refetchInterval: ({ state }) =>
      documentsStillIndexing(state.data?.pages.flatMap((page) => page.documents) ?? [])
        ? DOCUMENTS_POLL_MS
        : false
  });
  if (query.data !== undefined) {
    return {
      status: "ready",
      data: {
        documents: query.data.pages.flatMap((page) => page.documents),
        ...(query.hasNextPage
          ? {
              more: {
                loading: query.isFetchingNextPage,
                load: () => void query.fetchNextPage().catch(() => undefined)
              }
            }
          : {})
      }
    };
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
    const reason = readRefusalDetails(error).reason;
    return {
      ok: false,
      refused: apiErrorCode(error) === "FORBIDDEN",
      message: instanceSentence(error),
      ...(reason === undefined ? {} : { reason })
    };
  }
}

function useRead<Answer>(
  queryKey: (string | number)[],
  read: (signal: AbortSignal) => Promise<Answer>,
  options: {
    enabled?: boolean;
    keepPrevious?: boolean;
    /** Reads again every `DOCUMENTS_POLL_MS` while what was read says so. */
    pollWhile?: (answer: Answer) => boolean;
  } = {}
): KnowledgeRead<Answer> {
  const { pollWhile } = options;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => read(signal),
    retry: false,
    enabled: options.enabled ?? true,
    refetchInterval: ({ state }) =>
      pollWhile && state.data !== undefined && pollWhile(state.data) ? DOCUMENTS_POLL_MS : false,
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
