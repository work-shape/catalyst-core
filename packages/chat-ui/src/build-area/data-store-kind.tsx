import { Badge, Chip } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { BuildAssetViewProps, BuildListedKind } from "./build-asset-kind";
import {
  DATA_STORE_STATE_VIEWS,
  dataStoreStateView,
  formatDataStoreSize
} from "./data-store-model";
import { dataStoreNeverPublished } from "./data-store-draft";
import { DataStorePage } from "./data-store-page";
import { useDataStoreSource, type DataStoreSource } from "./data-store-source";

/** The kind's segment in an address: `/build/data-stores`. */
const DATA_STORES_BUILD_PATH = "data-stores";

/**
 * What a row says of its store beyond the definition: its state, what the server leaves open
 * and its size. The row reads the store's state itself, which reads no database of a store.
 * Until the answer is there, and when it fails, the row says nothing of the state.
 */
function DataStoreRowState({ name, useSource }: { name: string; useSource(): DataStoreSource }) {
  const { locale, t } = useTranslation();
  const read = useSource().useStoreState(name);
  if (read.status !== "ready") {
    return null;
  }
  const state = read.data;
  const view = DATA_STORE_STATE_VIEWS[dataStoreStateView(state)];
  const open = state.conditions.length;
  return (
    <>
      <Badge tone={view.tone} dot data-data-store-row-state={dataStoreStateView(state)}>
        {t(view.label)}
      </Badge>
      {open > 0 ? (
        <Badge tone="warning" className="hidden sm:inline-flex">
          {t(open === 1 ? "dataStores.conditionCount" : "dataStores.conditionCounts", {
            count: open
          })}
        </Badge>
      ) : null}
      {state.size.bytes === undefined ? null : (
        <span className="hidden sm:inline-flex">
          <Chip size="sm">{formatDataStoreSize(state.size.bytes, locale)}</Chip>
        </span>
      )}
    </>
  );
}

/**
 * How many tables a store has and how many rows the database estimates in them, as the last
 * measurement found them. The whole list is one read, which every row shares. A store that was
 * never measured says neither, and a store whose tables the database never counted says no rows.
 */
function DataStoreRowMeasured({ name, useSource }: { name: string; useSource(): DataStoreSource }) {
  const { locale, t } = useTranslation();
  const read = useSource().useListed();
  const listed =
    read.status === "ready" ? read.data.items.find((item) => item.name === name) : undefined;
  if (!listed) {
    return null;
  }
  const { tableCount, rowEstimate } = listed;
  const number = new Intl.NumberFormat(locale);
  return (
    <span className="hidden gap-1.5 md:inline-flex" data-data-store-row-measured={name}>
      {tableCount === undefined ? null : (
        <Chip size="sm">
          {t(tableCount === 1 ? "dataStores.tableCount" : "dataStores.tableCounts", {
            count: number.format(tableCount)
          })}
        </Chip>
      )}
      {rowEstimate === undefined || rowEstimate < 1 ? null : (
        <span className="inline-flex" title={t("dataStores.rowEstimateHint")}>
          <Chip size="sm">
            {t(rowEstimate === 1 ? "dataStores.rowEstimate" : "dataStores.rowEstimates", {
              count: number.format(rowEstimate)
            })}
          </Chip>
        </span>
      )}
    </span>
  );
}

/**
 * Data Stores in Build on the answers of `useSource`: a list, and a page that shows one store.
 * A store is made by its definition, which an agent or the API writes, so the kind has no
 * editor and no button that starts one. A row says what the definition says of the store, its
 * name and its description, whom it belongs to, the store's state and size, and its tables and
 * rows as last measured.
 */
export function dataStoreKindOn(useSource: () => DataStoreSource): BuildListedKind {
  function DataStoreAssetPage(frame: BuildAssetViewProps) {
    return <DataStorePage {...frame} source={useSource()} />;
  }
  return {
    kind: "data_store",
    path: DATA_STORES_BUILD_PATH,
    label: "dataStores.kind",
    description: "dataStores.description",
    searchLabel: "dataStores.search",
    emptyText: "dataStores.empty",
    icon: "datastore",
    view: { Page: DataStoreAssetPage, missingText: "dataStores.missing" },
    rowText: (asset) => asset.description,
    badges: (asset, t) => (
      <>
        {/* A store never published has no database, so there is no state to read. */}
        {dataStoreNeverPublished(asset) ? (
          <Badge tone="warning" data-data-store-row-draft="">
            {t("dataStores.draftUnpublished")}
          </Badge>
        ) : (
          <>
            <DataStoreRowState name={asset.name} useSource={useSource} />
            <DataStoreRowMeasured name={asset.name} useSource={useSource} />
          </>
        )}
      </>
    )
  };
}

/** Data Stores in Build on the instance's own answers. */
export const dataStoreKind = dataStoreKindOn(useDataStoreSource);
