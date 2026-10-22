import { Table2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  Badge,
  Banner,
  Chip,
  EmptyState,
  InlineError,
  KeyValue,
  KeyValueList,
  List,
  ListRow,
  Page,
  PageHeader,
  PageOutline,
  Section,
  SkeletonList,
  Table,
  TableBody,
  TableCell,
  TableCellDetail,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-ui";
import { formatDateTime } from "../../shared/locale-format";
import { useTranslation } from "../../shared/i18n";
import { usePageShown } from "./asset-editor-shell";
import type { BuildAssetViewProps } from "./build-asset-kind";
import {
  columnTypeView,
  DATA_STORE_CONDITION_LABELS,
  DATA_STORE_STATE_VIEWS,
  dataStoreStateView,
  formatDataStoreSize,
  migrationNumber
} from "./data-store-model";
import { DataStoreDraftPage, dataStoreNeverPublished } from "./data-store-draft";
import { DataStorePublishSection, pendingMigrations, useDataStoreMenu } from "./data-store-head";
import { hasDataFlows } from "./data-flows-model";
import {
  DataStoreAgents,
  DataStoreFillers,
  DataStoreProcessors,
  DataStoreReaders
} from "./data-store-provenance";
import { ReadState } from "./data-store-read-state";
import { DataStoreRowsSection } from "./data-store-rows";
import {
  serverConditionsShown,
  type DataStoreSchema,
  type DataStoreSource,
  type DataStoreState
} from "./data-store-source";

type DataStoreTable = DataStoreSchema["tables"][number];

/** With this many tables or fewer, every table shows its columns without a click. */
const TABLES_OPEN_AT_MOST = 3;

/** How long a column's default may be before its cell cuts it, in characters. */
const DEFAULT_WIDTH = 24;

/** A member of the definition that is a text, or nothing. */
function textOf(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The page of one Data Store: the header with the store's state, where its migrations stand and
 * how large it is, what the server leaves open around it, its tables with their columns, and the
 * first rows of one table. The rows are the answer of one preview, so the page holds as many as
 * the instance hands out and never the whole table. It writes nothing itself: Publish, Delete
 * and "Edit with the agent" are the frame's.
 */
export function DataStorePage(props: BuildAssetViewProps & { source: DataStoreSource }) {
  const { asset } = props;
  const title = textOf(asset.config, "title") ?? asset.name;
  // A store never published has no database yet: its page is the draft's.
  if (dataStoreNeverPublished(asset)) {
    return (
      <DataStoreDraftPage
        {...props}
        title={title}
        description={textOf(asset.config, "description")}
      />
    );
  }
  return <PublishedDataStorePage {...props} title={title} />;
}

/** The page of a Data Store with a published revision, and so a database. */
function PublishedDataStorePage({
  page,
  back,
  asset,
  source,
  title,
  publish,
  remove
}: BuildAssetViewProps & { source: DataStoreSource; title: string }) {
  const { t } = useTranslation();
  usePageShown(page, "asset");
  const head = useDataStoreMenu({ id: asset.name, title, published: true, remove });
  const read = source.useStoreState(asset.name);
  const state = read.status === "ready" ? read.data : undefined;
  const conditions = state ? serverConditionsShown(source, state) : [];
  const view = state ? DATA_STORE_STATE_VIEWS[dataStoreStateView(state)] : undefined;
  // The rows of a store are reached while it is ready, so its tables are read only then, and
  // read again at each new migration level.
  const reachable = state?.status === "ready";
  const level = state?.level;
  const provenance = {
    store: asset.name,
    workspaceId: asset.scope.kind === "workspace" ? asset.scope.workspaceId : undefined,
    source
  };
  // The data Workflows that process the store come with what uses it, the read the sections
  // below make. "Processed by" stands only where one is named or counted.
  const usedBy = source.useUsedBy(asset.name);
  const dataFlows = usedBy.status === "ready" ? usedBy.data.dataFlows : undefined;
  // A draft saved after the publish waits with the migrations it adds past the published level.
  const draftAhead =
    asset.draftRevision !== undefined && asset.revision !== asset.publishedRevision;
  const pending = state ? pendingMigrations(asset.config, state.publishedLevel) : undefined;
  // The agents that carry the store's row tools, from an instance that names them.
  const agentsNamed =
    usedBy.status === "ready" &&
    (usedBy.data.agents !== undefined || usedBy.data.hidden.agents !== undefined);
  const sections: {
    id: string;
    label: string;
    description: string;
    count?: number;
    body: ReactNode;
  }[] = [
    ...(draftAhead
      ? [
          {
            id: "pending",
            label: t("dataStores.pendingTitle"),
            description: t("dataStores.pendingDescription"),
            count: pending?.length,
            body:
              pending === undefined ? (
                <SkeletonList rows={2} />
              ) : (
                <DataStorePublishSection
                  title={title}
                  migrations={pending}
                  firstPublish={false}
                  publish={publish}
                />
              )
          }
        ]
      : []),
    {
      id: "status",
      label: t("dataStores.statusTitle"),
      description: t("dataStores.statusDescription"),
      body: (
        <>
          <ReadState read={read} failedText={t("dataStores.stateFailed")} rows={3}>
            {(loaded) => (
              <DataStoreStatus
                state={loaded}
                description={textOf(asset.config, "description")}
                updatedAt={asset.updatedAt}
              />
            )}
          </ReadState>
        </>
      )
    },
    // Where the rows come from and who reads them is read from the published definitions,
    // whatever state the store is in. They stand right after the status, as a phone shows no
    // table of contents.
    {
      id: "filled-by",
      label: t("dataStores.filledByTitle"),
      description: t("dataStores.filledByDescription"),
      body: <DataStoreFillers {...provenance} />
    },
    ...(dataFlows !== undefined && hasDataFlows(dataFlows, "processes")
      ? [
          {
            id: "processed-by",
            label: t("dataStores.processedByTitle"),
            description: t("dataStores.processedByDescription"),
            count: dataFlows.processes.length,
            body: <DataStoreProcessors {...provenance} />
          }
        ]
      : []),
    {
      id: "read-by",
      label: t("dataStores.readByTitle"),
      description: t("dataStores.readByDescription"),
      body: <DataStoreReaders {...provenance} />
    },
    ...(agentsNamed
      ? [
          {
            id: "agents",
            label: t("dataStores.agentsTitle"),
            description: t("dataStores.agentsDescription"),
            count: usedBy.data.agents?.length ?? 0,
            body: <DataStoreAgents used={usedBy.data} />
          }
        ]
      : []),
    ...(conditions.length > 0
      ? [
          {
            id: "conditions",
            label: t("dataStores.conditionsTitle"),
            description: t("dataStores.conditionsDescription"),
            count: conditions.length,
            body: <DataStoreConditions conditions={conditions} />
          }
        ]
      : []),
    ...(read.status === "failed"
      ? []
      : [
          {
            id: "tables",
            label: t("dataStores.tablesTitle"),
            description: t("dataStores.tablesDescription"),
            body:
              state === undefined ? (
                <SkeletonList rows={3} />
              ) : reachable ? (
                <DataStoreTables key={level} store={asset.name} source={source} />
              ) : (
                <EmptyState layout="inline">{t("dataStores.notReachable")}</EmptyState>
              )
          },
          {
            id: "rows",
            label: t("dataStores.rowsTitle"),
            description: t("dataStores.rowsDescription"),
            body:
              state === undefined ? (
                <SkeletonList rows={3} />
              ) : reachable ? (
                <DataStoreRowsSection key={level} store={asset.name} source={source} />
              ) : (
                <EmptyState layout="inline">{t("dataStores.notReachable")}</EmptyState>
              )
          }
        ])
  ];

  return (
    <Page
      ref={page.ref}
      header={
        <PageHeader
          variant="detail"
          back={back}
          title={title}
          description={textOf(asset.config, "description")}
          scope={
            <Chip>
              {t(
                asset.scope.kind === "workspace"
                  ? "dataStores.scopeWorkspace"
                  : "dataStores.scopeInstance"
              )}
            </Chip>
          }
          state={
            view ? (
              <Badge tone={view.tone} dot>
                {t(view.label)}
              </Badge>
            ) : undefined
          }
          menu={head.menu}
        />
      }
      outline={
        <PageOutline
          belowHeader
          items={sections.map(({ id, label, count }) => ({ id, label, count }))}
        />
      }
    >
      {page.above}
      {/* The first line of the content starts where the outline does. */}
      <div className="grid min-w-0 content-start pt-5">
        <Banner layout="line" className="mb-4" data-build-read-only="">
          {t("dataStores.description")}
        </Banner>
        {head.failure}
        {sections.map((section) => (
          <Section
            key={section.id}
            id={section.id}
            layout="stacked"
            title={section.label}
            description={section.description}
            count={section.count}
          >
            {section.body}
          </Section>
        ))}
      </div>
      {head.dialog}
    </Page>
  );
}

/** The state in a word and a sentence, then the migration level, the size and the last change. */
function DataStoreStatus({
  state,
  description,
  updatedAt
}: {
  state: DataStoreState;
  description: string | undefined;
  updatedAt: string;
}) {
  const { locale, t } = useTranslation();
  const name = dataStoreStateView(state);
  const view = DATA_STORE_STATE_VIEWS[name];
  const { size, lastMigration } = state;
  const { migration, failure } = lastMigration;
  return (
    <>
      <div role="status" data-data-store-state={name} className="grid min-w-0 gap-1.5">
        <Badge tone={view.tone} dot>
          {t(view.label)}
        </Badge>
        <p className="text-body">{t(view.text)}</p>
      </div>
      {failure ? (
        <InlineError data-data-store-failure={failure.code}>{failure.message}</InlineError>
      ) : null}
      {size.nearLimit ? (
        <Banner tone="warning" data-data-store-near-limit="">
          {t("dataStores.nearLimit")}
        </Banner>
      ) : null}
      <KeyValueList>
        <KeyValue label={t("dataStores.schemaLevel")}>
          {state.level === state.publishedLevel
            ? state.level
            : t("dataStores.schemaLevelOf", {
                level: state.level,
                published: state.publishedLevel
              })}
        </KeyValue>
        {migration ? (
          <KeyValue
            label={t(
              lastMigration.outcome === "applied"
                ? "dataStores.lastMigration"
                : "dataStores.nextMigration"
            )}
          >
            <code className="font-mono text-code">
              {migrationNumber(migration.number)}_{migration.name}
            </code>
          </KeyValue>
        ) : null}
        <KeyValue label={t("dataStores.size")}>
          {size.bytes === undefined ? (
            t("dataStores.sizeNotMeasured", {
              limit: formatDataStoreSize(size.limitBytes, locale)
            })
          ) : (
            <>
              {t("dataStores.sizeOfLimit", {
                size: formatDataStoreSize(size.bytes, locale),
                limit: formatDataStoreSize(size.limitBytes, locale)
              })}
              {size.measuredAt ? (
                <span className="block text-caption text-muted-foreground">
                  {t("dataStores.sizeMeasured", { time: formatDateTime(size.measuredAt, locale) })}
                </span>
              ) : null}
            </>
          )}
        </KeyValue>
        <KeyValue label={t("dataStores.updated")}>{formatDateTime(updatedAt, locale)}</KeyValue>
        {description ? (
          <KeyValue label={t("dataStores.descriptionLabel")} foldable>
            {description}
          </KeyValue>
        ) : null}
      </KeyValueList>
    </>
  );
}

/**
 * What the server leaves open, for the one who runs it: a step to take each, and the server's
 * own sentence of how on demand.
 */
function DataStoreConditions({ conditions }: { conditions: DataStoreState["conditions"] }) {
  const { t } = useTranslation();
  return (
    <List aria-label={t("dataStores.conditionsTitle")}>
      {conditions.map((condition) => (
        <ListRow
          key={condition.code}
          data-data-store-condition={condition.code}
          expandable
          title={t(DATA_STORE_CONDITION_LABELS[condition.code])}
          chips={
            <Badge tone="warning" size="sm">
              {t("dataStores.conditionOpen")}
            </Badge>
          }
        >
          <p className="text-body text-muted-foreground">{condition.message}</p>
        </ListRow>
      ))}
    </List>
  );
}

/** The tables of the store. A table unfolds to its columns. */
function DataStoreTables({ store, source }: { store: string; source: DataStoreSource }) {
  const { t } = useTranslation();
  return (
    <ReadState read={source.useSchema(store)} failedText={t("dataStores.schemaFailed")} rows={3}>
      {({ tables }) =>
        tables.length === 0 ? (
          <EmptyState layout="inline">{t("dataStores.tablesEmpty")}</EmptyState>
        ) : (
          <List aria-label={t("dataStores.tablesTitle")}>
            {tables.map((table) => (
              <ListRow
                key={table.name}
                data-data-store-table={table.name}
                expandable
                defaultExpanded={tables.length <= TABLES_OPEN_AT_MOST}
                leading={<Table2 aria-hidden="true" className="size-4 text-muted-foreground" />}
                title={<code className="font-mono text-code">{table.name}</code>}
                description={
                  table.comment ??
                  t(
                    table.columns.length === 1
                      ? "dataStores.columnCount"
                      : "dataStores.columnCounts",
                    { count: table.columns.length }
                  )
                }
                time={<RowEstimate table={table} />}
              >
                <DataStoreColumns table={table} />
              </ListRow>
            ))}
          </List>
        )
      }
    </ReadState>
  );
}

/**
 * How many rows the database's planner estimates. Before its first count of a table it has no
 * estimate and answers none or zero, whatever the table holds, so the row then names none.
 */
function RowEstimate({ table }: { table: DataStoreTable }) {
  const { locale, t } = useTranslation();
  if (table.rowEstimate < 1) {
    return null;
  }
  const count = Math.round(table.rowEstimate);
  return (
    <span title={t("dataStores.rowEstimateHint")}>
      {t(count === 1 ? "dataStores.rowEstimate" : "dataStores.rowEstimates", {
        count: new Intl.NumberFormat(locale).format(count)
      })}
    </span>
  );
}

function DataStoreColumns({ table }: { table: DataStoreTable }) {
  const { t } = useTranslation();
  return (
    <Table density="compact" aria-label={t("dataStores.columnsOf", { table: table.name })}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("dataStores.column")}</TableHead>
          <TableHead>{t("dataStores.columnType")}</TableHead>
          <TableHead>{t("dataStores.columnNullable")}</TableHead>
          <TableHead>{t("dataStores.columnDefault")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {table.columns.map((column) => (
          <TableRow key={column.name} data-data-store-column={column.name}>
            <TableCell>
              <span className="flex min-w-0 items-center gap-2">
                <code className="font-mono text-code">{column.name}</code>
                {column.primaryKey ? (
                  <Badge size="sm">{t("dataStores.columnPrimaryKey")}</Badge>
                ) : null}
              </span>
              {column.comment ? <TableCellDetail>{column.comment}</TableCellDetail> : null}
            </TableCell>
            <ColumnTypeCell column={column} />
            <TableCell>
              {t(column.nullable ? "dataStores.columnNullableYes" : "dataStores.columnNullableNo")}
            </TableCell>
            <TableCell
              title={column.default}
              truncate={
                column.default !== undefined && column.default.length > DEFAULT_WIDTH
                  ? DEFAULT_WIDTH
                  : undefined
              }
            >
              {column.default === undefined ? null : (
                <code className="font-mono text-code">{column.default}</code>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** A column's type in the reader's words, with the database's name below where it says more. */
function ColumnTypeCell({ column }: { column: { type: string; nativeType: string } }) {
  const { t } = useTranslation();
  const { label, native } = columnTypeView(column);
  const code = native === undefined ? null : <code className="font-mono">{native}</code>;
  if (label === undefined) return <TableCell>{code}</TableCell>;
  return (
    <TableCell>
      {label.list ? t("dataStores.typeList", { type: t(label.key) }) : t(label.key)}
      {code === null ? null : <TableCellDetail>{code}</TableCellDetail>}
    </TableCell>
  );
}
