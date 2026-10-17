import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ConfigAssetRevision, OperationOutcome } from "@work-shape/catalyst-api-client";
import { invalidateOfferedAgents } from "../../shared/api/agent-placement-mutations";
import {
  createAssetWrites,
  type AssetContent,
  type AssetFileEntry,
  type AssetFileRead,
  type AvailableIn,
  type NameCheckAnswer
} from "../../shared/api/asset-writes";
import { usePlatformContextQuery } from "../../shared/api/workspace-queries";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useTranslation } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorCode } from "../../shared/workspace-utils";
import type { BuildAsset, BuildAssetRow } from "./build-asset-kind";
import { instanceSentence, PendingApprovalError } from "./build-refusals";
import {
  AGENT_ASSET_KIND,
  buildScopes,
  buildScopeValue,
  readLastBuildScope,
  resolveBuildRights,
  resolveBuildScope,
  storeLastBuildScope,
  subscribeBuildScope,
  type BuildRights,
  type BuildScope
} from "../../shared/build-rights";

/**
 * How many assets one read of a list asks for. The instance searches, filters and cuts the
 * list, so the browser holds the pages the reader asked for and never the whole kind.
 */
const BUILD_LIST_PAGE_SIZE = 50;

/** How many revisions one read of an asset's history asks for. */
const BUILD_HISTORY_PAGE_SIZE = 50;

/** How long the reader may pause typing before a search or a name check asks the instance. */
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
/** What a person decides on a draft: make it the published revision, or drop it. */
export type DraftDecision = "publish" | "discard";

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
  /** Writes the config, or the whole folder of a kind whose revision holds one. */
  put(
    input: {
      kind: string;
      name: string;
      /** The revision the page loaded, or `null` for an asset the call creates. */
      expectedRevision: number | null;
      /**
       * The draft revision of an existing agent the page read, or `null` where it read none:
       * the write moves the agent's draft and leaves the live agent as it is.
       */
      expectedDraftRevision?: number | null;
      availableIn?: AvailableIn;
    } & AssetContent
  ): Promise<{ revision: number; draftRevision?: number; files?: AssetFileEntry[] }>;
  /** The whole folder of an asset's current revision, each file with its content. */
  readFiles(input: { kind: string; name: string }): Promise<AssetFileRead[]>;
  delete(input: { kind: string; name: string; expectedRevision: number }): Promise<unknown>;
  /** Makes a saved revision of a kind with drafts the one its users get. */
  publish(input: {
    kind: string;
    name: string;
    revision: number;
  }): Promise<{ draftRevision: number; publishedRevision: number }>;
  revert(input: {
    kind: string;
    name: string;
    revision: number;
    expectedRevision: number;
    /** The agent's draft revision the page read, or `null`: the revision becomes the draft. */
    expectedDraftRevision?: number | null;
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
  /** Whether a new asset of the kind could take the name, where Studio would make it. */
  checkName(kind: string, name: string): Promise<NameCheckAnswer>;
  writes: BuildWrites;
  /**
   * The owner Studio works in for a kind a workspace can own: lists, reads and writes of such
   * a kind name it, so what is made here is owned by it. Absent where the source has one owner.
   */
  scope?: BuildScope;
  /** Works in another owner. */
  chooseScope?(scope: BuildScope): void;
  /** Whether the kind's assets are listed, read and written in the scope. */
  scoped?(kind: string): boolean;
  /**
   * Opens the dock with a new conversation with an agent that builds assets, `prompt` in its
   * composer: "New" of a kind it creates goes there instead of its dialog. Its first save makes
   * the asset owned by the conversation's workspace, the open one: absent where no such agent is
   * offered, and where the scope is another owner, whose New keeps its dialog (WS-OWN-1a).
   */
  buildWithAgent?(prompt: string): void;
}

/**
 * Build on the asset operations: `platform.context.get` says which kinds exist and which
 * Namespaces the reader holds, `assets.list` answers a list page by page, `assets.get` one
 * asset. Nothing here reads the whole set of assets.
 */
export function useBuildSource(): BuildSource {
  const { apiBaseUrl, authScope, client, user, config, activeWorkspace, buildWithAgent } =
    useSettingsPage();
  const { locale, t } = useTranslation();
  const queryClient = useQueryClient();
  const contextQuery = usePlatformContextQuery({ apiBaseUrl, authScope, client, enabled: true });
  const context = contextQuery.data;
  const rights = useMemo(() => resolveBuildRights(user, context), [context, user]);
  const management = config.features.configAssets;
  const assetsKey = workspaceQueryKeys.assets(apiBaseUrl, authScope);
  const chosenScope = useSyncExternalStore(
    subscribeBuildScope,
    readLastBuildScope,
    () => undefined
  );
  const scope = resolveBuildScope(rights, chosenScope, activeWorkspace?.id);
  const scopedKinds = new Set(
    (context?.kinds ?? [])
      .filter((kind) => kind.owners.includes("workspace") && kind.owners.includes("instance"))
      .map((kind) => kind.kind)
  );
  /** The workspace a call about an asset of the kind names: the scope's, for a scoped kind. */
  const workspaceOf = (kind: string): string | undefined =>
    scopedKinds.has(kind) && scope.kind === "workspace" ? scope.workspaceId : undefined;
  const inScope = (kind: string): { workspaceId?: string } => {
    const workspaceId = workspaceOf(kind);
    return workspaceId === undefined ? {} : { workspaceId };
  };
  /** The other owners Studio offers, where an asset missing in the scope is looked for. */
  const otherScopes = buildScopes(rights).filter(
    (other) => buildScopeValue(other) !== buildScopeValue(scope)
  );

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
        canCreate:
          (switches[kind.kind]?.create ?? true) &&
          rights.mayCreate(
            kind.kind,
            kind.owners.includes("workspace") && scope.kind === "workspace"
              ? scope.workspaceId
              : undefined
          ),
        canDelete: switches[kind.kind]?.delete ?? true
      }));
  }, [
    context,
    management.allowAgentCreation,
    management.allowAgentDeletion,
    management.allowSkillEditing,
    rights,
    scope
  ]);

  const writes = createAssetWrites(client);
  // An agent's name, description and starter prompts are also read outside Studio, from the
  // lists of offered agents: a written agent is asked for there again. The save does not wait
  // for those lists.
  // `gone` names an agent that was deleted: its draft is not read again, the instance has none.
  const changed = (kind: string, gone?: string) => () => {
    if (kind === AGENT_ASSET_KIND) {
      invalidateOfferedAgents(queryClient, apiBaseUrl, authScope).catch(() => undefined);
    }
    const goneDraft =
      gone === undefined ? undefined : workspaceQueryKeys.agentDraft(apiBaseUrl, authScope, gone);
    return queryClient.invalidateQueries({
      queryKey: assetsKey,
      predicate: ({ queryKey }) =>
        goneDraft === undefined || !goneDraft.slice(0, 5).every((part, at) => queryKey[at] === part)
    });
  };
  return {
    kinds,
    rights,
    loading: contextQuery.isLoading,
    error: contextQuery.error
      ? (instanceSentence(contextQuery.error) ?? t("build.loadFailed"))
      : undefined,
    reload: () => contextQuery.refetch(),
    scope,
    chooseScope: (next) => storeLastBuildScope(buildScopeValue(next)),
    scoped: (kind) => scopedKinds.has(kind),
    ...(buildWithAgent !== undefined &&
    scope.kind === "workspace" &&
    scope.workspaceId === activeWorkspace?.id
      ? { buildWithAgent }
      : {}),
    useList(kind, filter) {
      const text = filter.text.trim();
      const owner = inScope(kind);
      // A Namespace is a prefix among the instance's own assets alone.
      const prefix = owner.workspaceId === undefined ? filter.namespace : undefined;
      const query = useInfiniteQuery({
        queryKey: [...assetsKey, "list", kind, owner.workspaceId ?? "", text, prefix ?? "", locale],
        queryFn: ({ pageParam, signal }) =>
          client.assets.list({
            params: { kind },
            query: {
              limit: BUILD_LIST_PAGE_SIZE,
              cursor: pageParam,
              locale,
              ...owner,
              ...(text ? { text } : {}),
              ...(prefix ? { prefix } : {})
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
      const owner = inScope(kind);
      const query = useQuery({
        queryKey: ["asset", apiBaseUrl, authScope, kind, owner.workspaceId ?? "", name],
        queryFn: ({ signal }) =>
          client.assets.get({ params: { kind, name }, query: owner, signal }),
        gcTime: 0,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: false
      });
      // A page reached by a link, by its address or after a reload names the asset alone,
      // not its owner. Where Studio is set to an owner that does not have it, the page looks
      // in the other owners Studio offers and sets Studio to the first that has it, so every
      // way to the page reads the asset where it is.
      const missingHere =
        query.error !== null && !query.isFetching && apiErrorCode(query.error) === "NOT_FOUND";
      const searched = missingHere && scopedKinds.has(kind) && otherScopes.length > 0;
      const elsewhere = useQuery({
        queryKey: ["asset-owner", apiBaseUrl, authScope, kind, buildScopeValue(scope), name],
        enabled: searched,
        queryFn: async ({ signal }) => {
          const found = await Promise.all(
            otherScopes.map((other) =>
              client.assets
                .get({
                  params: { kind, name },
                  query: other.kind === "workspace" ? { workspaceId: other.workspaceId } : {},
                  signal
                })
                .then(
                  () => true,
                  () => false
                )
            )
          );
          const owner = otherScopes.find((_, index) => found[index]);
          return owner === undefined ? null : buildScopeValue(owner);
        },
        gcTime: 0,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: false
      });
      const foundIn = elsewhere.data;
      useEffect(() => {
        if (typeof foundIn === "string") storeLastBuildScope(foundIn);
      }, [foundIn]);
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
          // Looked for in the other owners: loading until that answers and Studio is set.
          return searched && !elsewhere.isError && elsewhere.data !== null
            ? { status: "loading" }
            : { status: "missing" };
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
      client.assets.get({ params: { kind, name }, query: inScope(kind) }).then(
        () => true,
        (error: unknown) => (apiErrorCode(error) === "NOT_FOUND" ? false : undefined)
      ),
    checkName: (kind, name) => writes.checkName({ kind, name, ...inScope(kind) }),
    writes: {
      put: (input) =>
        made(writes.put({ ...input, ...inScope(input.kind) })).finally(changed(input.kind)),
      delete: (input) =>
        made(writes.delete({ ...input, ...inScope(input.kind) })).finally(
          changed(input.kind, input.kind === AGENT_ASSET_KIND ? input.name : undefined)
        ),
      publish: (input) =>
        made(writes.publish({ ...input, ...inScope(input.kind) })).finally(changed(input.kind)),
      revert: (input) =>
        made(writes.revert({ ...input, ...inScope(input.kind) })).finally(changed(input.kind)),
      readFiles: ({ kind, name }) => writes.readFiles({ kind, name, ...inScope(kind) }),
      revisions: ({ kind, name, cursor }) =>
        client.assets.revisions.list({
          params: { kind, name },
          query: {
            limit: BUILD_HISTORY_PAGE_SIZE,
            ...inScope(kind),
            ...(cursor ? { cursor } : {})
          }
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
