import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  APP_ASSET_KIND,
  type AppAction,
  type AppFromPageResponse,
  type AppMode,
  type AppPreviewResponse,
  type AppPublishReview,
  ApiError,
  type Asset,
  type AssetSummary,
  type ConfigAssetPublication,
  type ConfigAssetRevision,
  type OperationOutcome
} from "@work-shape/catalyst-api-client";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import {
  narrativeReadOf,
  parsePublishNarrative,
  type PublishNarrativeRead
} from "../../shared/publish-narrative";
import { PendingApprovalError } from "../build-area/build-refusals";
import {
  appDataLines,
  appPublishData,
  type AppDataSources,
  type AppPublishData
} from "../build-area/data-store-provenance-model";
import { keepPageAddress, retryUnlessGone, type PageAddressState } from "../pages/page-address";
import { appPreviewProblem, appReadsStoredData, type AppPreviewProblem } from "./app-model";

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

/** Under the key of every asset read, so a write from Build drops these too. */
function appKeys(apiBaseUrl: string) {
  return [...workspaceQueryKeys.assets(apiBaseUrl, APP_AUTH_SCOPE), APP_ASSET_KIND] as const;
}

function useAppKeys() {
  const { apiBaseUrl } = useWorkspaceApiClient();
  return useMemo(() => appKeys(apiBaseUrl), [apiBaseUrl]);
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
 * The record of one App: its name, its pointers and the manifest of one revision. The read
 * names no revision, so the instance chooses the view: the draft for whoever may read it, and
 * the published revision without a `draftRevision` for everybody else who may open the App.
 */
export function useApp(workspaceId: string, app: string, enabled: boolean): AppRead {
  const { client } = useWorkspaceApiClient();
  const keys = useAppKeys();
  const query = useQuery({
    queryKey: [...keys, "app", workspaceId, app],
    queryFn: ({ signal }) =>
      client.assets.get({
        params: { kind: APP_ASSET_KIND, name: app },
        query: { workspaceId },
        signal
      }),
    enabled,
    refetchInterval: (query) => (query.state.data?.allowed?.includes("write") ? 30_000 : false),
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

/** The named actions of one App as a screen asked for them. */
export type AppActionsRead =
  | { status: "loading" }
  | { status: "failed"; retry(): void }
  | { status: "ready"; view: AppMode; revision: number; actions: readonly AppAction[] };

/**
 * The named actions of one App with what a call of each would come to for the reader: of the
 * draft for whoever writes the App, of the published revision for every other reader. One
 * request when the screen that shows them opens, and one after each write to an App.
 */
export function useAppActions(app: string, enabled: boolean): AppActionsRead {
  const { client } = useWorkspaceApiClient();
  const keys = useAppKeys();
  const query = useQuery({
    queryKey: [...keys, "actions", app],
    queryFn: ({ signal }) => client.apps.actions.list({ query: { app }, signal }),
    enabled,
    retry: retryUnlessGone
  });
  const listed = query.data?.apps[0];
  if (listed) {
    return {
      status: "ready",
      view: listed.view,
      revision: listed.revision,
      // A reader gets every action in full; a summary is what a holder of use alone gets.
      actions: listed.actions.flatMap((action) => ("kind" in action ? [action] : []))
    };
  }
  return query.isError || query.data
    ? { status: "failed", retry: () => void query.refetch().catch(() => undefined) }
    : { status: "loading" };
}

/**
 * Where the data of an App comes from: one sentence for each Workflow or App that fills a store
 * its statements read, as the published App declares it. Whoever uses the App reads it. Nothing
 * until the answer arrived, and nothing for an App with no published revision.
 */
export function useAppDataSources(app: string, enabled = true): readonly string[] | undefined {
  const { client } = useWorkspaceApiClient();
  const keys = useAppKeys();
  const { locale, t } = useTranslation();
  const read = useQuery({
    queryKey: [...keys, "data-sources", app],
    queryFn: ({ signal }) => client.data_stores.app_sources({ query: { app }, signal }),
    enabled: enabled && app !== "",
    retry: false
  });
  return read.data ? appDataLines(read.data, t, locale) : undefined;
}

/** What one stored revision of an App would show and to whom, as a screen asked for it. */
export type AppPublishDataRead =
  | { status: "loading" }
  /** The read failed, or its answer does not describe the revision asked for. */
  | { status: "failed"; retry(): void }
  | { status: "ready"; data: AppPublishData };

/**
 * What a screen shows for the answer about one revision: an answer without an audience, or of
 * another revision, is a failure to retry and never lines to publish on.
 */
export function appPublishDataRead(
  answer: { data: AppDataSources | undefined; failed: boolean; retry(): void },
  revision: number,
  t: TranslationContextValue["t"],
  locale: string
): AppPublishDataRead {
  if (answer.data) {
    const data = appPublishData(answer.data, revision, t, locale);
    return data ? { status: "ready", data } : { status: "failed", retry: answer.retry };
  }
  return answer.failed ? { status: "failed", retry: answer.retry } : { status: "loading" };
}

/**
 * Who would see which stored data if one revision of an App were made live (DS-13b): asked
 * by the revision's number, so a publish of the draft, a first publish and a publish of an
 * older revision each name what that revision reads, never what is live now. One request per
 * App and revision while the question is open.
 */
export function useAppPublishData(
  app: string,
  revision: number,
  /** False where the revision reads no stored data: nothing is asked. */
  enabled = true
): AppPublishDataRead {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const { locale, t } = useTranslation();
  const query = useQuery({
    queryKey: appPublishDataKey(apiBaseUrl, app, revision),
    queryFn: ({ signal }) => client.data_stores.app_sources({ query: { app, revision }, signal }),
    enabled,
    retry: retryUnlessGone
  });
  return appPublishDataRead(
    {
      data: query.data,
      failed: query.isError,
      retry: () => void query.refetch().catch(() => undefined)
    },
    revision,
    t,
    locale
  );
}

/** One Workflow a Publish of an App's draft makes live with it, as the review names it. */
export type AppPublishTogetherWorkflow = AppPublishReview["workflows"][number];

/** One Data Store a Publish of an App's draft publishes with it, as the review names it. */
export type AppPublishTogetherStore = AppPublishReview["dataStores"][number];

/** What one Publish of an App's draft makes live with it (DP-3, GOLIVE-1), as the dialog reads it. */
export interface AppPublishTogetherRead {
  /** As the stored-data read of the same question: loading, failed or ready. */
  status: AppPublishDataRead["status"];
  /**
   * The Workflows with changes their live revision does not have, children first: the
   * Publish names each with the revision shown. Empty where there are none, for a revision
   * other than the draft, and for a reader who may not write the App and reads no review.
   */
  workflows: readonly AppPublishTogetherWorkflow[];
  /**
   * The Data Stores the draft binds whose draft is not published, each with the migrations
   * it would apply: the Publish names each with the revision shown. And those live that are
   * still applying migrations the App needs (`pending` false): the Publish waits for them and
   * names none. Empty as `workflows` is.
   */
  dataStores: readonly AppPublishTogetherStore[];
  retry(): void;
}

/**
 * Reads `apps.publish_review` for the publish of an App's revision. Only a publish of the
 * draft makes Workflows live with it; the review is of the draft, so any other revision names
 * none. A refused read names none either: the publish then refuses an App whose Workflow is
 * not live, as before.
 */
export function useAppPublishTogether(
  app: string,
  revision: number,
  enabled = true
): AppPublishTogetherRead {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const query = useQuery({
    queryKey: [...appKeys(apiBaseUrl), "publish-review", app] as const,
    queryFn: async ({ signal }) => {
      try {
        return await client.apps.publish_review({ params: { app }, signal });
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          return null;
        }
        throw error;
      }
    },
    enabled,
    staleTime: 0,
    retry: false
  });
  const retry = () => void query.refetch().catch(() => undefined);
  const none = { workflows: [], dataStores: [], retry };
  if (!enabled) return { status: "ready", ...none };
  if (query.isError) return { status: "failed", ...none };
  if (query.data === undefined) return { status: "loading", ...none };
  const review = query.data;
  if (!review || review.app.draftRevision !== revision) return { status: "ready", ...none };
  return {
    status: "ready",
    workflows: review.workflows.filter((workflow) => workflow.pending),
    dataStores: review.dataStores,
    retry
  };
}

/** What one Publish of an App names to make live with it, each at the revision shown. */
export interface AppPublishNamed {
  workflows: readonly { name: string; revision: number }[];
  dataStores: readonly { name: string; revision: number }[];
}

/** Who a publish of an App makes it live for: its builder, its workspace or the whole instance. */
export type AppAudience = NonNullable<Asset["appAudience"]>["selected"];

/** What the instance offers the "For whom?" question, for the audience the read asked about. */
export interface AppAudienceOffer {
  selected: AppAudience;
  choices: readonly AppAudience[];
  /** The people the selected audience names, in the reader's language. */
  label: string;
  /** How many people the selected audience names, where the instance counts them. */
  people?: number;
  /** Who the live revision is for, where one is live, and the people it names. */
  live?: { audience: AppAudience; label: string | undefined };
  /** The name of the workspace that owns the App. */
  workspaceName?: string;
}

/** The read behind an App's publish question: the sentence and the audience offer, in one answer. */
export interface AppPublishQuestionRead {
  narrative: PublishNarrativeRead;
  /** Absent while the first answer loads, and from an instance that offers no choice. */
  audience: AppAudienceOffer | undefined;
  /**
   * The revision has a reading `sql` action, so the question names who sees which stored data.
   * Absent until the first answer arrived.
   */
  readsStoredData?: boolean;
}

/** The offer an answer holds, read whole or not at all. */
function appAudienceOffer(value: Asset["appAudience"]): AppAudienceOffer | undefined {
  if (value === undefined || !value.choices.includes(value.selected)) return undefined;
  return {
    selected: value.selected,
    choices: value.choices,
    label: value.label,
    ...(value.people === undefined ? {} : { people: value.people }),
    ...(value.live === undefined ? {} : { live: { audience: value.live, label: value.liveLabel } }),
    ...(value.workspaceName === undefined ? {} : { workspaceName: value.workspaceName })
  };
}

/**
 * The instance's sentence on what publishing one revision of an App makes live (PUBQ-1), for
 * the audience asked about (SHARE-1), and the choices of "For whom?". Without `audience` the
 * instance answers for the audience it proposes. While the answer for a new choice loads, the
 * choices of the last answer stay, and the sentence is loading: it never names another audience.
 */
export function useAppPublishNarrative(
  workspaceId: string,
  app: string,
  revision: number,
  audience: AppAudience | undefined
): AppPublishQuestionRead {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const { locale } = useTranslation();
  const query = useQuery({
    queryKey: [
      "publish-narrative",
      locale,
      apiBaseUrl,
      APP_ASSET_KIND,
      workspaceId,
      app,
      revision,
      audience ?? "proposed"
    ],
    queryFn: async ({ signal }) => {
      const asset = await client.assets.get({
        params: { kind: APP_ASSET_KIND, name: app },
        query: {
          workspaceId,
          revision: String(revision),
          ...(audience === undefined ? {} : { audience })
        },
        signal
      });
      return {
        narrative: parsePublishNarrative(asset.publishNarrative),
        audience: appAudienceOffer(asset.appAudience),
        readsStoredData: appReadsStoredData(asset.config)
      };
    },
    placeholderData: keepPreviousData,
    staleTime: 0,
    retry: false
  });
  const retry = () => void query.refetch().catch(() => undefined);
  const offer = query.data?.audience;
  // The config is the revision's whatever the audience, so the last answer's flag holds.
  const reads = query.data === undefined ? {} : { readsStoredData: query.data.readsStoredData };
  if (query.isError) {
    return { narrative: { status: "failed", reason: "read", retry }, audience: offer, ...reads };
  }
  if (query.data === undefined || query.isPlaceholderData) {
    return { narrative: { status: "loading" }, audience: offer, ...reads };
  }
  const narrative = narrativeReadOf(query.data.narrative);
  return {
    narrative: narrative.status === "failed" ? { ...narrative, retry } : narrative,
    audience: offer,
    ...reads
  };
}

/** The key the answer for one revision is held under, below the key of every App read. */
export function appPublishDataKey(apiBaseUrl: string, app: string, revision: number) {
  return [...appKeys(apiBaseUrl), "publish-data", app, revision] as const;
}

/**
 * Reads the named actions of one App again: after a test from the draft, which may have used
 * up the reader's "Run live once".
 */
export function useAppActionsReload(app: string): () => void {
  const queryClient = useQueryClient();
  const keys = useAppKeys();
  return useCallback(
    () =>
      void queryClient
        .invalidateQueries({ queryKey: [...keys, "actions", app] })
        .catch(() => undefined),
    [app, keys, queryClient]
  );
}

/** The App a Page was saved as, where the reader may write it. */
export type AppFromPage = NonNullable<AppFromPageResponse["app"]>;

/** An App the reader may write and could put a Page into, with the Page it is updated from. */
export type AppLinkCandidate = NonNullable<AppFromPageResponse["candidate"]>;

/** What a preview is to the reader, whatever they may write: an App they may read, or not. */
type PreviewIdentity = AppFromPageResponse["preview"];

/** What the instance said about a Page: the App the reader may write, and what the preview is. */
export interface AppFromPageRead {
  app: AppFromPage | undefined;
  /** Absent until the instance answered, and where the asking failed. */
  preview?: PreviewIdentity;
  settled: boolean;
}

/**
 * The App a Page was saved as, where the reader may write it, and what the preview is to the
 * reader: one request when the surface of the Page opens, and one more after each write to an
 * App. `settled` once the instance answered or the asking failed; a failed asking leaves the
 * Page without an App to update and without a `preview`.
 */
export function useAppFromPage(
  conversationId: string,
  pageId: string,
  enabled: boolean
): AppFromPageRead {
  const { client } = useWorkspaceApiClient();
  const keys = useAppKeys();
  const query = useQuery({
    queryKey: [...keys, "from-page", conversationId, pageId],
    queryFn: ({ signal }) =>
      client.apps.get_from_page({ params: { conversationId, pageId }, signal }),
    enabled,
    retry: retryUnlessGone
  });
  return {
    app: query.data?.app ?? undefined,
    ...(query.data ? { preview: query.data.preview } : {}),
    settled: enabled && !query.isPending
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

/** One page of the versions of an App, the newest first. */
export interface AppPublicationPage {
  items: ConfigAssetPublication[];
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
  /**
   * Writes the newest revision of the Page an App was saved from as the App's next draft
   * revision. Refused where the draft is not at `expectedRevision` any more.
   */
  updateFromPage(input: {
    conversationId: string;
    pageId: string;
    app: string;
    expectedRevision: number;
    /** Also writes an App that is not this Page's, and makes it this Page's. */
    link?: boolean;
  }): Promise<unknown>;
  /** The App with this id, where the reader may write it and so put the Page into it. */
  linkCandidate(input: {
    conversationId: string;
    pageId: string;
    app: string;
  }): Promise<AppLinkCandidate | undefined>;
  /**
   * Makes the revision with this number the published one, for the audience chosen in the
   * question (SHARE-1). Without one the instance keeps the App's audience.
   */
  publish(
    app: string,
    revision: number,
    audience?: AppAudience,
    /** The Data Stores and Workflows made live with the App, each at the revision shown. */
    together?: AppPublishNamed
  ): Promise<unknown>;
  /**
   * Gives the App the name people read, at once for its draft and what is published. No later
   * write changes it, an agent's included. Answers once the Apps read again.
   */
  rename(app: string, title: string): Promise<unknown>;
  /** Puts the draft back on the published revision. */
  discardDraft(app: string, expectedRevision: number): Promise<unknown>;
  remove(app: string, expectedRevision: number): Promise<unknown>;
  /**
   * Makes the reader's own next call of one action of the draft live instead of simulated,
   * once. Refused where the draft is not at `expectedRevision` any more.
   */
  runLiveOnce(app: string, action: string, expectedRevision: number): Promise<unknown>;
  revisions(app: string, cursor: string | undefined): Promise<AppRevisionPage>;
  /** One page of the App's versions, the newest first. */
  publications(app: string, cursor: string | undefined): Promise<AppPublicationPage>;
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
      linkCandidate: async ({ conversationId, pageId, app }) =>
        (await client.apps.get_from_page({ params: { conversationId, pageId }, query: { app } }))
          .candidate ?? undefined,
      updateFromPage: ({ conversationId, pageId, app, expectedRevision, link }) => {
        if (workspaceId === undefined) {
          return Promise.reject(new Error("An App belongs to a workspace"));
        }
        return made(
          client.apps.update_from_page({
            params: { app },
            body: {
              conversationId,
              pageId,
              workspaceId,
              expectedRevision,
              ...(link ? { link: true } : {})
            }
          })
        ).finally(changed);
      },
      publish: (app, revision, audience, together) =>
        made(
          client.assets.publish({
            params: params(app),
            body: {
              revision,
              workspaceId,
              ...(audience === undefined ? {} : { audience }),
              ...(together?.workflows.length ? { workflows: [...together.workflows] } : {}),
              ...(together?.dataStores.length ? { dataStores: [...together.dataStores] } : {})
            }
          })
        ).finally(changed),
      rename: (app, title) => {
        if (workspaceId === undefined) {
          return Promise.reject(new Error("An App belongs to a workspace"));
        }
        return made(client.apps.rename({ params: { app }, body: { workspaceId, title } })).finally(
          changed
        );
      },
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
      runLiveOnce: (app, action, expectedRevision) =>
        made(
          client.assets.run_live_once({
            params: params(app),
            body: { part: action, expectedRevision, workspaceId }
          })
        ).finally(changed),
      revisions: (app, cursor) =>
        client.assets.revisions.list({
          params: params(app),
          query: { limit: APP_REVISIONS_PAGE_SIZE, workspaceId, ...(cursor ? { cursor } : {}) }
        }),
      publications: (app, cursor) =>
        client.assets.publications.list({
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
