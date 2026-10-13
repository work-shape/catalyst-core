import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ConfigAssetRevision, OperationOutcome } from "@vivd-catalyst/api-client";
import { invalidateOfferedAgents } from "../api/agent-placement-mutations";
import { createAssetWrites } from "../api/asset-writes";
import { usePlatformContextQuery } from "../api/workspace-queries";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { useTranslation } from "../i18n";
import { useSettingsPage } from "../settings/settings-page-context";
import { apiErrorCode } from "../workspace-utils";
import type { BuildAsset, BuildAssetRow } from "./build-asset-kind";
import { instanceSentence, PendingApprovalError } from "./build-refusals";
import { AGENT_ASSET_KIND, resolveBuildRights, type BuildRights } from "./build-rights";

/**
 * How many assets one read of a list asks for. The instance searches, filters and cuts the
 * list, so the browser holds the pages the reader asked for and never the whole kind.
 */
const BUILD_LIST_PAGE_SIZE = 50;

/** How many revisions one read of an asset's history asks for. */
const BUILD_HISTORY_PAGE_SIZE = 50;

/** How long the reader may pause typing before the search asks the instance. */
export const BUILD_SEARCH_DELAY_MS = 250;

/** What narrows a list. Both parts are answered by the instance. */
export interface BuildListFilter {
  /** Names and ids that contain this text. */
  text: string;
  /** Only the assets of this Namespace, by prefix. */
  namespace: string | undefined;
}

/** One kind's list as far as the reader has asked for it. */
export interface BuildList {
  /** The rows read so far, by name. Absent until the first page arrived. */
  rows: readonly BuildAssetRow[] | undefined;
  error: string | undefined;
  /** The instance holds more rows than were read. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;
  retry(): void;
}

/**
 * How reading an asset again went. `loaded` hands the page the newer asset; after the other
 * two the page still holds what it held.
 */
export type BuildAssetReload = "loaded" | "missing" | "failed";

/** One asset as its page asked for it. */
export type BuildAssetRead =
  | { status: "loading" }
  /** No asset has this id, or none the reader may know of. */
  | { status: "missing" }
  /** The reader may not read this asset. Asking again changes nothing. */
  | { status: "refused" }
  /** The read failed. The sentence is the instance's own. */
  | { status: "failed"; message: string; retry(): void }
  | {
      status: "ready";
      asset: BuildAsset;
      /** Changes with every read, so a page can tell a newer answer from the one it holds. */
      loadedAt: number;
      /** Reads the asset again, as after a conflict. A failed read leaves this one as it is. */
      reload(): Promise<BuildAssetReload>;
    };

/** One page of an asset's history, the newest revision first. */
export interface BuildRevisionPage {
  items: ConfigAssetRevision[];
  /** Hands the next call the older revisions. Absent after the oldest one. */
  nextCursor?: string;
}

/** What the instance says about one kind for this reader. */
export interface BuildKindState {
  /** The asset kind, as the server stores it. */
  kind: string;
  /** The instance lets people start an asset of the kind here, and the reader may somewhere. */
  canCreate: boolean;
  /** The instance lets people delete an asset of the kind here. The right is per asset. */
  canDelete: boolean;
}

/** A write of one asset, as the frame makes it. The answer carries the new revision. */
interface BuildWrites {
  put(input: {
    kind: string;
    name: string;
    config: Record<string, unknown>;
    /** The revision the page loaded, or `null` for an asset the call creates. */
    expectedRevision: number | null;
  }): Promise<{ revision: number }>;
  delete(input: { kind: string; name: string; expectedRevision: number }): Promise<unknown>;
  revert(input: {
    kind: string;
    name: string;
    revision: number;
    expectedRevision: number;
  }): Promise<{ revision: number }>;
  /** One page of the history, the newest first. `cursor` continues after an earlier page. */
  revisions(input: { kind: string; name: string; cursor?: string }): Promise<BuildRevisionPage>;
}

/**
 * Everything the Build frame shows and changes. The frame is handed this and reads nothing
 * else, so a test hands it lists and assets of its own.
 */
export interface BuildSource {
  /** The kinds that are on and readable for this reader. A kind that is missing has no rail item. */
  kinds: readonly BuildKindState[];
  rights: BuildRights;
  /** True until the instance said what the reader may do. */
  loading: boolean;
  error: string | undefined;
  reload(): Promise<unknown>;
  /** A hook: one kind's list under a filter, page by page. */
  useList(kind: string, filter: BuildListFilter): BuildList;
  /** A hook: one asset, read when its page opens and again only when the page asks. */
  useAsset(kind: string, name: string): BuildAssetRead;
  /**
   * Whether the asset is there now, asked without touching what its page holds. Undefined when
   * the instance could not say.
   */
  exists(kind: string, name: string): Promise<boolean | undefined>;
  writes: BuildWrites;
}

/**
 * Build on the asset operations: `platform.context.get` says which kinds exist and which
 * Namespaces the reader holds, `assets.list` answers a list page by page, `assets.get` one
 * asset. Nothing here reads the whole set of assets.
 */
export function useBuildSource(): BuildSource {
  const { apiBaseUrl, authScope, client, user, config } = useSettingsPage();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const contextQuery = usePlatformContextQuery({ apiBaseUrl, authScope, client, enabled: true });
  const context = contextQuery.data;
  const rights = useMemo(() => resolveBuildRights(user, context), [context, user]);
  const management = config.features.configAssets;
  const assetsKey = workspaceQueryKeys.assets(apiBaseUrl, authScope);

  const kinds = useMemo<BuildKindState[]>(() => {
    // The instance's own switches for the two kinds it has always had. A kind that brings no
    // switch is created and deleted by whoever holds its rights.
    const switches: Record<string, { create: boolean; delete: boolean } | undefined> = {
      agent: { create: management.allowAgentCreation, delete: management.allowAgentDeletion },
      skill: { create: management.allowSkillEditing, delete: management.allowSkillEditing }
    };
    return (context?.kinds ?? [])
      .filter((kind) => rights.reads(kind.kind))
      .map((kind) => ({
        kind: kind.kind,
        canCreate: (switches[kind.kind]?.create ?? true) && rights.mayCreate(kind.kind),
        canDelete: switches[kind.kind]?.delete ?? true
      }));
  }, [
    context,
    management.allowAgentCreation,
    management.allowAgentDeletion,
    management.allowSkillEditing,
    rights
  ]);

  const writes = createAssetWrites(client);
  // An agent's name, description and starter prompts are also read outside Studio, from the
  // lists of offered agents: a written agent is asked for there again. The save does not wait
  // for those lists.
  const changed = (kind: string) => () => {
    if (kind === AGENT_ASSET_KIND) {
      invalidateOfferedAgents(queryClient, apiBaseUrl, authScope).catch(() => undefined);
    }
    return queryClient.invalidateQueries({ queryKey: assetsKey });
  };
  return {
    kinds,
    rights,
    loading: contextQuery.isLoading,
    error: contextQuery.error
      ? (instanceSentence(contextQuery.error) ?? t("build.loadFailed"))
      : undefined,
    reload: () => contextQuery.refetch(),
    useList(kind, filter) {
      const text = filter.text.trim();
      const query = useInfiniteQuery({
        queryKey: [...assetsKey, "list", kind, text, filter.namespace ?? ""],
        queryFn: ({ pageParam, signal }) =>
          client.assets.list({
            params: { kind },
            query: {
              limit: BUILD_LIST_PAGE_SIZE,
              cursor: pageParam,
              ...(text ? { text } : {}),
              ...(filter.namespace ? { prefix: filter.namespace } : {})
            },
            signal
          }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor
      });
      return {
        rows: query.data?.pages.flatMap((page) => page.items),
        error: query.error ? (instanceSentence(query.error) ?? t("build.loadFailed")) : undefined,
        hasMore: query.hasNextPage,
        loadingMore: query.isFetchingNextPage,
        // A failed page shows through `error`, so there is nothing to catch here.
        loadMore: () => void query.fetchNextPage().catch(() => undefined),
        retry: () => void query.refetch().catch(() => undefined)
      };
    },
    useAsset(kind, name) {
      // The page writes against the revision it loaded. The read is therefore the page's
      // own: it is not kept when the page closes, and nothing reads it again behind the
      // page's back.
      const query = useQuery({
        queryKey: ["asset", apiBaseUrl, authScope, kind, name],
        queryFn: ({ signal }) => client.assets.get({ params: { kind, name }, signal }),
        gcTime: 0,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: false
      });
      // What was read stays the page's asset while it is read again and after a read that
      // failed: only a newer answer replaces it. The page would otherwise lose what was typed.
      if (query.data) {
        return {
          status: "ready",
          asset: query.data,
          loadedAt: query.dataUpdatedAt,
          reload: async () => {
            const answer = await query.refetch();
            if (!answer.error) {
              return "loaded";
            }
            return apiErrorCode(answer.error) === "NOT_FOUND" ? "missing" : "failed";
          }
        };
      }
      if (query.error && !query.isFetching) {
        const code = apiErrorCode(query.error);
        if (code === "NOT_FOUND") {
          return { status: "missing" };
        }
        if (code === "FORBIDDEN") {
          return { status: "refused" };
        }
        return {
          status: "failed",
          message: instanceSentence(query.error) ?? t("build.loadFailed"),
          retry: () => void query.refetch().catch(() => undefined)
        };
      }
      return { status: "loading" };
    },
    exists: (kind, name) =>
      client.assets.get({ params: { kind, name } }).then(
        () => true,
        (error: unknown) => (apiErrorCode(error) === "NOT_FOUND" ? false : undefined)
      ),
    writes: {
      put: (input) => made(writes.put(input)).finally(changed(input.kind)),
      delete: (input) => made(writes.delete(input)).finally(changed(input.kind)),
      revert: (input) => made(writes.revert(input)).finally(changed(input.kind)),
      revisions: ({ kind, name, cursor }) =>
        client.assets.revisions.list({
          params: { kind, name },
          query: { limit: BUILD_HISTORY_PAGE_SIZE, ...(cursor ? { cursor } : {}) }
        })
    }
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
