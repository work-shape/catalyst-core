import { Table2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Badge,
  Banner,
  Button,
  Chip,
  EmptyState,
  InlineError,
  KeyValue,
  KeyValueList,
  List,
  ListRow,
  Page,
  PageHeader,
  Section,
  SkeletonList,
  SubRail,
  Table,
  TableBody,
  TableCell,
  TableCellDetail,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "@vivd-catalyst/ui";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import { usePageShown } from "./asset-editor-shell";
import type { BuildAssetViewProps } from "./build-asset-kind";
import {
  cellText,
  DATA_STORE_CELL_WIDTH,
  DATA_STORE_CONDITION_LABELS,
  DATA_STORE_STATE_VIEWS,
  dataStoreStateView,
  formatDataStoreSize,
  migrationNumber
} from "./data-store-model";
import type {
  DataStoreRead,
  DataStoreSchema,
  DataStoreSource,
  DataStoreState
} from "./data-store-source";

type DataStoreTable = DataStoreSchema["tables"][number];

/** With this many tables or fewer, every table shows its columns without a click. */
const TABLES_OPEN_AT_MOST = 3;

/** A member of the definition that is a text, or nothing. */
function textOf(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The page of one Data Store. It shows and changes nothing: the header with the store's state,
 * where its migrations stand and how large it is, what the server leaves open around it, its
 * tables with their columns, and the first rows of one table. The rows are the answer of one
 * preview, so the page holds as many as the instance hands out and never the whole table.
 */
export function DataStorePage({
  page,
  back,
  asset,
  source
}: BuildAssetViewProps & { source: DataStoreSource }) {
  const { t } = useTranslation();
  usePageShown(page, "asset");
  const read = source.useStoreState(asset.name);
  const state = read.status === "ready" ? read.data : undefined;
  const view = state ? DATA_STORE_STATE_VIEWS[dataStoreStateView(state)] : undefined;
  const title = textOf(asset.config, "title") ?? asset.name;
  // The rows of a store are reached while it is ready, so its tables are read only then.
  const reachable = state?.status === "ready";
  const sections: {
    id: string;
    label: string;
    description: string;
    count?: number;
    body: ReactNode;
  }[] = [
    {
      id: "status",
      label: t("dataStores.statusTitle"),
      description: t("dataStores.statusDescription"),
      body: (
        <ReadState read={read} failedText={t("dataStores.stateFailed")} rows={3}>
          {(loaded) => (
            <DataStoreStatus
              state={loaded}
              description={textOf(asset.config, "description")}
              updatedAt={asset.updatedAt}
            />
          )}
        </ReadState>
      )
    },
    ...(state && state.conditions.length > 0
      ? [
          {
            id: "conditions",
            label: t("dataStores.conditionsTitle"),
            description: t("dataStores.conditionsDescription"),
            count: state.conditions.length,
            body: <DataStoreConditions conditions={state.conditions} />
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
                <DataStoreTables store={asset.name} source={source} />
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
                <DataStoreRowsSection store={asset.name} source={source} />
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
          description={
            <span className="flex min-w-0 items-center gap-2">
              <span>{t("dataStores.kindSingular")}</span>
              <code className="min-w-0 truncate text-code" title={asset.name}>
                {asset.name}
              </code>
            </span>
          }
        />
      }
      subRail={
        <SubRail
          mode="anchors"
          belowHeader
          label={t("build.sections")}
          groups={[{ id: "sections", items: sections.map(({ id, label }) => ({ id, label })) }]}
        />
      }
    >
      {page.above}
      {/* The first line of the content starts where the first item of the index does. */}
      <div className="grid min-w-0 content-start pt-5">
        <Banner layout="line" className="mb-4" data-build-read-only="">
          {t("dataStores.description")}
        </Banner>
        {sections.map((section) => (
          <Section
            key={section.id}
            id={section.id}
            title={section.label}
            description={section.description}
            count={section.count}
          >
            {section.body}
          </Section>
        ))}
      </div>
    </Page>
  );
}

/** One read of the page before and after its answer: the rows of a skeleton, the error, the content. */
function ReadState<Answer>({
  read,
  failedText,
  rows,
  children
}: {
  read: DataStoreRead<Answer>;
  /** What the page says of a read that failed without a sentence of the instance. */
  failedText: string;
  rows: number;
  children(answer: Answer): ReactNode;
}) {
  const { t } = useTranslation();
  if (read.status === "loading") {
    return <SkeletonList rows={rows} />;
  }
  if (read.status === "failed") {
    return (
      <InlineError className="flex flex-wrap items-center justify-between gap-2">
        <span>{read.message ?? failedText}</span>
        <Button variant="outline" size="sm" onClick={read.retry}>
          {t("tryAgain")}
        </Button>
      </InlineError>
    );
  }
  return children(read.data);
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

/** What the server leaves open: a few words each, and the server's own sentence on demand. */
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

/** How many rows the database's planner estimates. It has no estimate before its first count. */
function RowEstimate({ table }: { table: DataStoreTable }) {
  const { locale, t } = useTranslation();
  if (table.rowEstimate < 0) {
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
            <TableCell>
              {column.type}
              <TableCellDetail>
                <code className="font-mono">{column.nativeType}</code>
              </TableCellDetail>
            </TableCell>
            <TableCell>
              {t(column.nullable ? "dataStores.columnNullableYes" : "dataStores.columnNullableNo")}
            </TableCell>
            <TableCell truncate={column.default === undefined ? undefined : 24}>
              {column.default ?? ""}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The first rows of one table, with a tab per table of the store. */
function DataStoreRowsSection({ store, source }: { store: string; source: DataStoreSource }) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string>();
  return (
    <ReadState read={source.useSchema(store)} failedText={t("dataStores.schemaFailed")} rows={3}>
      {({ tables }) => {
        const table = tables.find((candidate) => candidate.name === chosen) ?? tables[0];
        if (!table) {
          return <EmptyState layout="inline">{t("dataStores.tablesEmpty")}</EmptyState>;
        }
        return (
          <Tabs value={table.name} onValueChange={setChosen} className="grid min-w-0 gap-3">
            <TabsList label={t("dataStores.rowsTable")}>
              {tables.map(({ name }) => (
                <TabsTrigger key={name} value={name}>
                  <code className="font-mono">{name}</code>
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value={table.name} className="grid min-w-0 gap-2">
              <DataStoreRowsView store={store} table={table.name} source={source} />
            </TabsContent>
          </Tabs>
        );
      }}
    </ReadState>
  );
}

function DataStoreRowsView({
  store,
  table,
  source
}: {
  store: string;
  table: string;
  source: DataStoreSource;
}) {
  const { locale, t } = useTranslation();
  return (
    <ReadState read={source.useRows(store, table)} failedText={t("dataStores.rowsFailed")} rows={4}>
      {({ columns, rows, truncated }) =>
        rows.length === 0 ? (
          <EmptyState layout="inline">{t("dataStores.rowsEmpty")}</EmptyState>
        ) : (
          <>
            <Table
              density="compact"
              stickyHeader
              data-data-store-rows={table}
              aria-label={t("dataStores.rowsOf", { table })}
            >
              <TableHeader>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead key={column.name} align={alignOf(column.type)}>
                      <code className="font-mono">{column.name}</code>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={index}>
                    {columns.map((column) => (
                      <RowCell key={column.name} value={row[column.name]} type={column.type} />
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-caption text-muted-foreground" data-data-store-rows-count="">
              {t(
                truncated
                  ? "dataStores.rowsFirst"
                  : rows.length === 1
                    ? "dataStores.rowsAllOne"
                    : "dataStores.rowsAll",
                { count: new Intl.NumberFormat(locale).format(rows.length) }
              )}
            </p>
          </>
        )
      }
    </ReadState>
  );
}

/** Numbers stand at the end of their column, so they compare down it. */
function alignOf(type: string): "start" | "end" {
  return type === "integer" || type === "number" ? "end" : "start";
}

/** One value of a row. A long one is cut and shows whole on demand; `null` is named as such. */
function RowCell({ value, type }: { value: unknown; type: string }) {
  const { t } = useTranslation();
  const text = cellText(value);
  if (text === undefined) {
    return (
      <TableCell align={alignOf(type)} className="text-muted-foreground">
        {t("dataStores.valueNull")}
      </TableCell>
    );
  }
  return (
    <TableCell
      align={alignOf(type)}
      className="whitespace-nowrap"
      truncate={text.length > DATA_STORE_CELL_WIDTH ? DATA_STORE_CELL_WIDTH : undefined}
    >
      {text}
    </TableCell>
  );
}
