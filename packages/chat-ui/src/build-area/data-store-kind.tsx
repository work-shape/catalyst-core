import { Database } from "lucide-react";
import { Badge, Chip } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { BuildAssetViewProps, BuildListedKind } from "./build-asset-kind";
import {
  DATA_STORE_STATE_VIEWS,
  dataStoreStateView,
  formatDataStoreSize
} from "./data-store-model";
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
 * Data Stores in Build on the answers of `useSource`: a list, and a page that shows one store.
 * A store is made by its definition, which an agent or the API writes, so the kind has no
 * editor and no button that starts one. A row says what the definition says of the store, its
 * name and its description, whom it belongs to, and the store's state and size.
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
    icon: Database,
    view: { Page: DataStoreAssetPage, missingText: "dataStores.missing" },
    rowText: (asset) => asset.description,
    badges: (asset, t) => (
      <>
        <Chip size="sm">
          {t(
            asset.scope.kind === "workspace"
              ? "dataStores.scopeWorkspace"
              : "dataStores.scopeInstance"
          )}
        </Chip>
        <DataStoreRowState name={asset.name} useSource={useSource} />
      </>
    )
  };
}

/** Data Stores in Build on the instance's own answers. */
export const dataStoreKind = dataStoreKindOn(useDataStoreSource);
