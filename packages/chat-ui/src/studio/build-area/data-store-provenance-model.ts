import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";
import type { ApiClient } from "@work-shape/catalyst-api-client";
import type { DataStoreUsedBy } from "./data-store-source";

// Where a store's rows come from and who reads them, as the page and an App's details say it.
// Pure, so a test reads what a reader is told without rendering.

type Translate = TranslationContextValue["t"];

export type DataStoreAudience = DataStoreUsedBy["readers"];
export type DataStoreUser = DataStoreUsedBy["apps"][number] | DataStoreUsedBy["workflows"][number];

/** What fills a store: every published Workflow and App that adds rows, Workflows first. */
export function dataStoreFillers(used: DataStoreUsedBy) {
  return [
    ...used.workflows
      .filter((workflow) => workflow.writes)
      .map((workflow) => ({ ...workflow, kind: "workflow" as const })),
    ...used.apps.filter((app) => app.writes).map((app) => ({ ...app, kind: "app" as const }))
  ];
}

/** A list of names as the reader's language joins them: "A, B and C", "A, B und C". */
function joinNames(names: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
}

/**
 * Who reads through one way in, in one line: the workspace that opens it with its number of
 * people, each holder by a grant the reader may be shown, and how many more hold it. The
 * instance admins hold every right by their role; the section says so once, and a line names
 * them only where nobody else reads.
 */
export function audienceLine(audience: DataStoreAudience, t: Translate, locale: string): string {
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  const parts: string[] = [];
  if (audience.workspace) {
    parts.push(
      t(
        audience.workspace.members === 1
          ? "dataStores.audienceWorkspaceOne"
          : "dataStores.audienceWorkspace",
        { workspace: audience.workspace.title, count: count(audience.workspace.members) }
      )
    );
  }
  for (const holder of audience.holders) {
    parts.push(
      holder.kind === "user" ? holder.title : t(HOLDER_KEYS[holder.kind], { name: holder.title })
    );
  }
  if (audience.hiddenHolders > 0) {
    // "more" only follows someone named; alone, the count says how many hold it.
    parts.push(
      t(parts.length > 0 ? "dataStores.audienceHidden" : "dataStores.audienceHiddenOnly", {
        count: count(audience.hiddenHolders)
      })
    );
  }
  return parts.length > 0 ? parts.join(" · ") : t("dataStores.audienceAdminsOnly");
}

const HOLDER_KEYS = {
  service_principal: "dataStores.holderAccount",
  role: "dataStores.holderRole",
  group: "dataStores.holderGroup"
} as const satisfies Record<
  Exclude<DataStoreAudience["holders"][number]["kind"], "user">,
  TranslationKey
>;

/**
 * Where the rows of a filler come from, and as whom a Workflow runs: "Copies from CRM ·
 * Runs as Nightly import account". A filler that calls no Connection adds rows of its own.
 */
export function fillerLine(filler: DataStoreUser, t: Translate, locale: string): string {
  const parts = [
    filler.sources.length > 0
      ? t("dataStores.filledFrom", {
          connections: joinNames(
            filler.sources.map((source) => source.title),
            locale
          )
        })
      : t("dataStores.filledWithoutSource")
  ];
  if ("account" in filler && filler.account) {
    parts.push(runsAsLine(filler.account, t));
  }
  return parts.join(" · ");
}

/**
 * As whom a Workflow runs: its account by name where the reader administers users, the kind of
 * account alone for anyone else.
 */
export function runsAsLine(account: { title?: string | undefined }, t: Translate): string {
  return account.title === undefined
    ? t("dataStores.runsAsUnnamed")
    : t("dataStores.runsAs", { account: account.title });
}

/** Where the data of one App comes from, as the App declares it to whoever uses it. */
export type AppDataSources = Awaited<ReturnType<ApiClient["data_stores"]["app_sources"]>>;

/**
 * Where an App's data comes from, one sentence for each Workflow or App that fills a store it
 * reads: "Shows data from “Clients”, which the Workflow “Nightly import” copies from CRM." A
 * store nothing fills is named alone.
 */
export function appDataLines(sources: AppDataSources, t: Translate, locale: string): string[] {
  return sources.stores.flatMap(({ title: store, fillers }) => {
    if (fillers.length === 0) {
      return [t("apps.sourceStoreOnly", { store })];
    }
    return fillers.map(({ kind, title: name, connections }) =>
      connections.length === 0
        ? t(kind === "app" ? "apps.sourceByAppAlone" : "apps.sourceByWorkflowAlone", {
            store,
            name
          })
        : t(kind === "app" ? "apps.sourceByApp" : "apps.sourceByWorkflow", {
            store,
            name,
            connections: joinNames(connections, locale)
          })
    );
  });
}

/** What one stored revision of an App would show and to whom: the answer asked with a revision. */
export interface AppPublishData {
  /** Who may use the App, as the store's page names an App's audience. */
  audience: string;
  /**
   * Who holds a right on the App by a grant row, named as `audience` names them: they see the
   * data whoever the App is published for. Absent where nobody does.
   */
  holders?: string;
  stores: {
    name: string;
    title: string;
    /** Which reading actions of the revision read from the store. */
    actions: string;
    /**
     * What bounds what they show: the store's last measurement of all its rows, never what the
     * actions select, which depends on what they are asked. For a store the App may not reach,
     * that it is not available.
     */
    rows: string;
    /** Where the store's rows come from: a sentence for each Workflow or App that fills it. */
    sources: string[];
  }[];
  truncated: boolean;
}

/**
 * The publish question's lines on stored data (DS-13b), for the answer asked with a revision:
 * who may use the App, and for each store its reading actions name, which actions, how many rows
 * the whole store held when last measured, and where they come from. Nothing for an answer
 * that does not describe the revision asked for: one without an audience, or of another
 * revision. The question is then not asked on it.
 */
export function appPublishData(
  sources: AppDataSources,
  revision: number,
  t: Translate,
  locale: string
): AppPublishData | undefined {
  if (sources.audience === undefined || sources.revision !== revision) return undefined;
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  return {
    audience: audienceLine(sources.audience, t, locale),
    ...(sources.audience.holders.length > 0 || sources.audience.hiddenHolders > 0
      ? {
          holders: audienceLine(
            { holders: sources.audience.holders, hiddenHolders: sources.audience.hiddenHolders },
            t,
            locale
          )
        }
      : {}),
    stores: sources.stores.map((store) => {
      const actions = store.actions ?? [];
      return {
        name: store.name,
        title: store.title,
        actions: t(actions.length === 1 ? "apps.publishDataActionOne" : "apps.publishDataActions", {
          count: count(actions.length),
          actions: joinNames(actions, locale)
        }),
        rows: store.unavailable
          ? t("apps.publishDataUnavailable")
          : store.rows
            ? t("apps.publishDataRows", {
                rows: t(
                  store.rows.estimate === 1 ? "dataStores.rowEstimate" : "dataStores.rowEstimates",
                  { count: count(store.rows.estimate) }
                ),
                tables: t(
                  store.rows.tables === 1 ? "dataStores.tableCount" : "dataStores.tableCounts",
                  { count: count(store.rows.tables) }
                )
              })
            : t("apps.publishDataRowsUnknown"),
        // A store nothing fills is named by its title already.
        sources:
          store.fillers.length === 0
            ? []
            : appDataLines({ stores: [store], truncated: false }, t, locale)
      };
    }),
    truncated: sources.truncated
  };
}
