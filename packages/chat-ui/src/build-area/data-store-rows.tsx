import { Maximize2 } from "lucide-react";
import { useState } from "react";
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../i18n";
import { cellText, DATA_STORE_CELL_WIDTH, wholeValueText } from "./data-store-model";
import { ReadState } from "./data-store-read-state";
import type { DataStoreSource, DataStoreValuePlace } from "./data-store-source";

/** The rows of one table, a page at a time, with a tab per table of the store. */
export function DataStoreRowsSection({
  store,
  source
}: {
  store: string;
  source: DataStoreSource;
}) {
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
              {/* A table starts at its own first page, whatever page the one before stood on. */}
              <DataStoreRowsView
                key={table.name}
                store={store}
                table={table.name}
                source={source}
              />
            </TabsContent>
          </Tabs>
        );
      }}
    </ReadState>
  );
}

/**
 * The rows of one table. The instance answers a page and where the next one starts, and no
 * number of pages, so the reader goes on to the next page or back to the first. The page
 * counts the rows it went past, which says where in the table the shown rows stand.
 */
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
  // `before`: the rows passed on the page left, which stays shown while the next one is read.
  const [from, setFrom] = useState<{ after: string; passed: number; before: number }>();
  const [shown, setShown] = useState<DataStoreValuePlace>();
  const read = source.useRowsPage(store, table, from?.after);
  const number = new Intl.NumberFormat(locale);
  const toStart = (
    <Button variant="outline" size="sm" disabled={!from} onClick={() => setFrom(undefined)}>
      {t("dataStores.rowsToStart")}
    </Button>
  );
  return (
    <>
      <ReadState
        read={read}
        failedText={t("dataStores.rowsFailed")}
        refusedText={t("dataStores.rowsRefused")}
        // A page that cannot be read leaves the way back to the first one.
        failedAction={from ? toStart : undefined}
        rows={4}
      >
        {({ columns, rows, order, next }, renewing) => {
          const passed = (renewing ? from?.before : from?.passed) ?? 0;
          const orderText =
            order.by === "key"
              ? t("dataStores.rowsOrderKey", { columns: order.columns.join(", ") })
              : t("dataStores.rowsOrderPhysical");
          if (rows.length === 0) {
            return (
              <EmptyState layout="inline" action={from ? toStart : undefined}>
                {t(from ? "dataStores.rowsNoMore" : "dataStores.rowsEmpty")}
              </EmptyState>
            );
          }
          return (
            <>
              <Table
                density="compact"
                stickyHeader
                data-data-store-rows={table}
                data-data-store-rows-order={order.by}
                aria-busy={renewing}
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
                  {rows.map((row) => (
                    <TableRow key={row.at}>
                      {columns.map((column) =>
                        row.cut?.includes(column.name) ? (
                          <CutCell
                            key={column.name}
                            value={row.values[column.name]}
                            column={column.name}
                            onShow={() => setShown({ table, column: column.name, at: row.at })}
                          />
                        ) : (
                          <RowCell
                            key={column.name}
                            value={row.values[column.name]}
                            type={column.type}
                          />
                        )
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <p
                  className="min-w-0 text-caption text-muted-foreground"
                  data-data-store-rows-count=""
                >
                  {t(rows.length === 1 ? "dataStores.rowsRangeOne" : "dataStores.rowsRange", {
                    from: number.format(passed + 1),
                    to: number.format(passed + rows.length)
                  })}{" "}
                  {t(next === undefined ? "dataStores.rowsEnd" : "dataStores.rowsMore")} {orderText}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {toStart}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={next === undefined || renewing}
                    onClick={() =>
                      next === undefined
                        ? undefined
                        : setFrom({ after: next, passed: passed + rows.length, before: passed })
                    }
                  >
                    {t("dataStores.rowsNext")}
                  </Button>
                </div>
              </div>
            </>
          );
        }}
      </ReadState>
      <DataStoreValueDialog
        store={store}
        place={shown}
        source={source}
        onClose={() => setShown(undefined)}
      />
    </>
  );
}

/** Numbers stand at the end of their column, so they compare down it. */
function alignOf(type: string): "start" | "end" {
  return type === "integer" || type === "number" ? "end" : "start";
}

/**
 * A value the instance cut: its first characters and the button that reads it whole. A value
 * that is no text and too large to read with a page arrives without any character, and the cell
 * says so.
 */
function CutCell({ value, column, onShow }: { value: unknown; column: string; onShow(): void }) {
  const { t } = useTranslation();
  const text = cellText(value) ?? "";
  return (
    <TableCell data-data-store-cut={text === "" ? "unread" : "text"}>
      <span className="flex min-w-0 items-center gap-1">
        {text === "" ? (
          <span className="whitespace-nowrap text-muted-foreground">
            {t("dataStores.valueUnread")}
          </span>
        ) : (
          <span className="block max-w-[40ch] truncate">{text}</span>
        )}
        <IconButton size="sm" label={t("dataStores.valueShow", { column })} onClick={onShow}>
          <Maximize2 aria-hidden="true" />
        </IconButton>
      </span>
    </TableCell>
  );
}

/**
 * One value read whole, in a dialog. The instance answers a value up to its ceiling for one
 * read; above it the dialog says that a query reads a part of the value.
 */
export function DataStoreValueDialog({
  store,
  place,
  source,
  onClose
}: {
  store: string;
  place: DataStoreValuePlace | undefined;
  source: DataStoreSource;
  onClose(): void;
}) {
  const { locale, t } = useTranslation();
  const read = source.useValue(store, place);
  return (
    <Dialog
      open={place !== undefined}
      size="lg"
      title={<code className="font-mono">{place?.column}</code>}
      description={place ? t("dataStores.valueOf", { table: place.table }) : undefined}
      onClose={onClose}
    >
      {place === undefined ? null : read.status === "failed" &&
        read.reason === "value_too_large" ? (
        <Banner tone="warning" data-data-store-value="too_large">
          {t("dataStores.valueTooLarge")}
        </Banner>
      ) : read.status === "failed" && read.reason === "row_gone" ? (
        <Banner tone="warning" data-data-store-value="gone">
          {t("dataStores.valueGone")}
        </Banner>
      ) : (
        <ReadState
          read={read}
          failedText={t("dataStores.valueFailed")}
          refusedText={t("dataStores.rowsRefused")}
          rows={3}
        >
          {({ value }) => {
            const text = wholeValueText(value);
            if (text === undefined) {
              return <p className="text-body text-muted-foreground">{t("dataStores.valueNull")}</p>;
            }
            return (
              <div className="grid min-w-0 grid-cols-1 gap-2" data-data-store-value="whole">
                <p className="text-caption text-muted-foreground">
                  {t("dataStores.valueLength", {
                    count: new Intl.NumberFormat(locale).format(text.length)
                  })}
                </p>
                <p className="min-w-0 font-mono text-code whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {text}
                </p>
              </div>
            );
          }}
        </ReadState>
      )}
    </Dialog>
  );
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
