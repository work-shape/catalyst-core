import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  APP_ASSET_KIND,
  type AppMode,
  type AppPreviewResponse,
  type Asset,
  type AssetSummary,
  type ConfigAssetRevision,
  type OperationOutcome
} from "@vivd-catalyst/api-client";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { PendingApprovalError } from "../build-area/build-refusals";
import { keepPageAddress, retryUnlessGone, type PageAddressState } from "../pages/page-address";
import { appPreviewProblem, type AppPreviewProblem, type AppReadRevision } from "./app-model";

/** The session the Apps are read with: the one the workspace shell holds. */
const APP_AUTH_SCOPE = "standalone";

/**
 * How many Apps one read of the list asks for. The instance cuts the list, so the browser
 * holds the pages the reader asked for and never every App of the workspace.
 */
const APP_LIST_PAGE_SIZE = 50;

/** How many revisions one read of an App's history asks for. */
const APP_REVISIONS_PAGE_SIZE = 50;

/** The Apps of one workspace as far as the reader has asked for them. */
export interface AppList {
  /** The rows read so far, by name. Absent until the first page arrived. */
  rows: readonly AssetSummary[] | undefined;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

function useAppKeys() {
  const { apiBaseUrl } = useWorkspaceApiClient();
  // Under the key of every asset read, so a write from Build drops these too.
  return useMemo(
    () => [...workspaceQueryKeys.assets(apiBaseUrl, APP_AUTH_SCOPE), APP_ASSET_KIND] as const,
    [apiBaseUrl]
  );
}

/**
 * The Apps of a workspace, page by page: one request for the first fifty and one more per
 * "Show more". The instance lists the Apps the reader may read.
 */
export function useAppList(workspaceId: string | undefined): AppList {
  const { client } = useWorkspaceApiClient();
  const keys = useAppKeys();
  const query = useInfiniteQuery({
    queryKey: [...keys, "list", workspaceId ?? ""],
    queryFn: ({ pageParam, signal }) =>
      client.assets.list({
        params: { kind: APP_ASSET_KIND },
        query: { limit: APP_LIST_PAGE_SIZE, cursor: pageParam, workspaceId },
        signal
      }),
    enabled: workspaceId !== undefined,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor
  });
  return {
    rows: query.data?.pages.flatMap((page) => page.items),
    failed: query.isError,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    // A failed page shows through `failed`, so there is nothing to catch here.
    loadMore: () => void query.fetchNextPage().catch(() => undefined),
    retry: () => void query.refetch().catch(() => undefined)
  };
}

/** One App's record as its page asked for it. */
export interface AppRead {
  app: Asset | undefined;
  /** The instance answered, and there is no record for this reader. */
  missing: boolean;
  failed: boolean;
  loading: boolean;
  reload(): Promise<Asset | undefined>;
}

/**
 * The record of one App: its name, its two pointers and the manifest of one revision. The
 * draft is read by whoever may write or publish the App; everybody else is answered the
 * published revision, and nothing where none is published.
 */
export function useApp(
  workspaceId: string,
  app: string,
  enabled: boolean,
  revision: AppReadRevision
): AppRead {
  const { client } = useWorkspaceApiClient();
  const keys = useAppKeys();
  const query = useQuery({
    queryKey: [...keys, "app", workspaceId, app, revision],
    queryFn: ({ signal }) =>
      client.assets.get({
        params: { kind: APP_ASSET_KIND, name: app },
        query: { workspaceId, revision },
        signal
      }),
    enabled,
    retry: retryUnlessGone
  });
  return {
    app: query.data,
    missing: enabled && query.isError && !retryUnlessGone(0, query.error),
    failed: enabled && query.isError && retryUnlessGone(0, query.error),
    loading: enabled && query.isPending,
    reload: async () => (await query.refetch()).data
  };
}

/** The source files of one revision as its Files side asked for them. */
interface AppFilesRead {
  record: Asset | undefined;
  /** What the instance refused the read with, or what went wrong on the way. */
  error: unknown;
  loading: boolean;
}

/**
 * The source files of one revision of an App, contents included: one request per revision,
 * made when the Files side is opened. A revision never changes, so it is asked for once. Above
 * `ASSET_GET_FILES_MAX_BYTES` the instance answers the index alone.
 */
export function useAppFiles(
  workspaceId: string,
  app: string,
  revision: number | undefined
): AppFilesRead {
  const { client } = useWorkspaceApiClient();
  const keys = useAppKeys();
  const query = useQuery({
    queryKey: [...keys, "files", workspaceId, app, revision ?? 0],
    queryFn: ({ signal }) =>
      client.assets.get({
        params: { kind: APP_ASSET_KIND, name: app },
        query: { workspaceId, revision: String(revision), files: "true" },
        signal
      }),
    enabled: revision !== undefined,
    retry: retryUnlessGone,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false
  });
  return {
    record: query.data,
    error: query.isError ? query.error : undefined,
    loading: revision !== undefined && query.isPending
  };
}

/** The answer of a write that was made. One that waits for an approval is thrown as such. */
async function made<Output>(call: Promise<OperationOutcome<Output>>): Promise<Output> {
  const outcome = await call;
  if (outcome.status !== "done") {
    throw new PendingApprovalError();
  }
  return outcome.output;
}

/** One page of an App's history, the newest revision first. */
export interface AppRevisionPage {
  items: ConfigAssetRevision[];
  nextCursor?: string;
}

/** The changes a person makes to the Apps of one workspace. */
export interface AppWrites {
  /** Saves the newest revision of a Page as the draft of a new App. */
  saveFromPage(input: {
    conversationId: string;
    pageId: string;
    id: string;
    name: string;
  }): Promise<{ name: string }>;
  /** Makes the revision with this number the published one. */
  publish(app: string, revision: number): Promise<unknown>;
  /** Puts the draft back on the published revision. */
  discardDraft(app: string, expectedRevision: number): Promise<unknown>;
  remove(app: string, expectedRevision: number): Promise<unknown>;
  revisions(app: string, cursor: string | undefined): Promise<AppRevisionPage>;
}

export function useAppWrites(workspaceId: string | undefined): AppWrites {
  const { client } = useWorkspaceApiClient();
  const queryClient = useQueryClient();
  const keys = useAppKeys();
  return useMemo(() => {
    const changed = () => queryClient.invalidateQueries({ queryKey: keys });
    const params = (app: string) => ({ kind: APP_ASSET_KIND, name: app });
    return {
      saveFromPage: ({ conversationId, pageId, id, name }) => {
        if (workspaceId === undefined) {
          return Promise.reject(new Error("An App is saved into a workspace"));
        }
        return made(
          client.apps.create_from_page({
            body: { conversationId, pageId, name: id, title: name, workspaceId }
          })
        ).finally(changed);
      },
      publish: (app, revision) =>
        made(
          client.assets.publish({ params: params(app), body: { revision, workspaceId } })
        ).finally(changed),
      discardDraft: (app, expectedRevision) =>
        made(
          client.assets.discard_draft({
            params: params(app),
            body: { expectedRevision, workspaceId }
          })
        ).finally(changed),
      remove: (app, expectedRevision) =>
        made(
          client.assets.delete({ params: params(app), body: { expectedRevision, workspaceId } })
        ).finally(changed),
      revisions: (app, cursor) =>
        client.assets.revisions.list({
          params: params(app),
          query: { limit: APP_REVISIONS_PAGE_SIZE, workspaceId, ...(cursor ? { cursor } : {}) }
        })
    };
  }, [client, keys, queryClient, workspaceId]);
}

/** What a mounted App knows of the address its frame loads. */
export interface AppAddress extends PageAddressState<AppPreviewResponse> {
  /** Why there is no address, once the instance refused or the asking failed. */
  problem: AppPreviewProblem | undefined;
  again(): void;
}

/**
 * The address of the published or the draft revision of an App, kept while the App is on
 * screen: one request when it opens and one before each token expires, which is once in
 * fifty-five minutes. The address is a credential of the frame and is kept nowhere else.
 * `turn` asks anew: a publish or a discard changes what an address stands for.
 */
export function useAppAddress(app: string, mode: AppMode, turn = 0): AppAddress {
  const { client } = useWorkspaceApiClient();
  const [state, setState] = useState<PageAddressState<AppPreviewResponse>>({
    gone: false,
    failed: false
  });
  const [problem, setProblem] = useState<AppPreviewProblem>();
  const keeper = useRef<{ again: () => void }>(undefined);
  useEffect(() => {
    setState({ gone: false, failed: false });
    setProblem(undefined);
    const kept = keepPageAddress(
      () =>
        client.apps.preview({ params: { app }, body: { mode } }).then(
          (address) => {
            setProblem(undefined);
            return address;
          },
          (error: unknown) => {
            setProblem(appPreviewProblem(error));
            throw error;
          }
        ),
      setState
    );
    keeper.current = kept;
    return kept.stop;
  }, [app, client, mode, turn]);
  const again = useCallback(() => keeper.current?.again(), []);
  return { ...state, problem: state.gone || state.failed ? problem : undefined, again };
}
