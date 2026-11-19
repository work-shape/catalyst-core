import { useMemo, type ReactNode } from "react";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import {
  cn,
  KeyValue,
  KeyValueList,
  List,
  ListRow,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { formatCalendarDay, formatMomentShort } from "../../shared/locale-format";

/*
 * The view of a tool's data that no widget of the release draws: it reads the data's own shape.
 * An object is labelled rows, a list of flat objects a table, a list of plain values a list.
 * Everything it shows is text, never markup from the data, and it is bounded however large or
 * deep the data is.
 */

/** How many levels of nesting are shown. A deeper object or list is counted, not shown. */
const MAX_DEPTH = 4;
/** The fields, rows or items one object or list shows before it says how many more it holds. */
const MAX_ROWS = 50;
/** The values the whole view shows, whatever the shape: a bound on what one result draws. */
const MAX_VALUES = 1500;
/** The characters of a value before it is cut. */
const MAX_TEXT = 1000;
/** The characters of a value in a table cell before it is cut. */
const MAX_CELL_TEXT = 120;
/** The characters of a label or a column's head before it is cut. */
const MAX_LABEL = 80;
/** A list of objects with more distinct fields than this is not a table: it would not fit. */
const MAX_COLUMNS = 8;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_MOMENT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/u;

type Scalar = string | number | boolean | null | undefined;

interface ViewContext {
  locale: LocaleCode;
  t: TranslationContextValue["t"];
  /** The values still to show. Rendering goes depth first, in order, and spends it. */
  budget: { left: number };
}

export function GenericDataView({ data, className }: { data: unknown; className?: string }) {
  const { locale, t } = useTranslation();
  // Drawn once per data: the view walks the whole shape, which a re-render need not repeat.
  const content = useMemo(() => {
    const context: ViewContext = { locale, t, budget: { left: MAX_VALUES } };
    if (isEmpty(data)) {
      return <p className="text-muted-foreground">{t("dataViewEmpty")}</p>;
    }
    if (isScalar(data)) {
      return (
        <p className="break-words whitespace-pre-wrap">{scalarText(data, context, MAX_TEXT)}</p>
      );
    }
    return renderValue(data, 0, context);
  }, [data, locale, t]);
  return (
    <div data-slot="generic-data-view" className={cn("grid min-w-0 gap-3 text-body", className)}>
      {content}
    </div>
  );
}

/** A key as the label of its value, cut where it is long. */
function labelOf(key: string): string {
  const label = readableLabel(key.slice(0, MAX_LABEL));
  return cut(key.length > MAX_LABEL ? `${label.trimEnd()}…` : label, MAX_LABEL);
}

/** A key as a label: `due_date` and `dueDate` are "Due date", `userID` is "User ID". */
export function readableLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[\s_.-]+/u)
    .filter(Boolean);
  if (words.length === 0) {
    return key;
  }
  return words
    .map((word, index) => {
      const acronym = word.length > 1 && /[A-Z]/u.test(word) && word === word.toUpperCase();
      const lower = acronym ? word : word.toLowerCase();
      return index === 0 ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower;
    })
    .join(" ");
}

function renderValue(value: unknown, depth: number, context: ViewContext): ReactNode {
  if (isScalar(value)) {
    return spendText(value, context, MAX_TEXT);
  }
  if (Array.isArray(value)) {
    return renderList(value, depth, context);
  }
  return isRecord(value) ? renderObject(value, depth, context) : null;
}

function renderObject(
  record: Record<string, unknown>,
  depth: number,
  context: ViewContext
): ReactNode {
  const entries = Object.entries(record);
  const shown = take(entries, context);
  if (shown.length === 0) {
    return <More count={entries.length} context={context} />;
  }
  return (
    <div className="grid min-w-0 gap-2">
      <KeyValueList>
        {shown.map(([key, value]) => renderField(key, labelOf(key), value, depth, context))}
      </KeyValueList>
      <More count={entries.length - shown.length} context={context} />
    </div>
  );
}

/** One field: a plain value beside its label, an object or list as a section under it. */
function renderField(
  key: string,
  label: string,
  value: unknown,
  depth: number,
  context: ViewContext
): ReactNode {
  if (isScalar(value) || isEmpty(value)) {
    return (
      <KeyValue key={key} label={label}>
        {spendText(isScalar(value) ? value : null, context, MAX_TEXT)}
      </KeyValue>
    );
  }
  if (depth + 1 >= MAX_DEPTH) {
    context.budget.left -= 1;
    return (
      <KeyValue key={key} label={label}>
        <span className="text-muted-foreground">{countText(value, context)}</span>
      </KeyValue>
    );
  }
  return (
    <KeyValue key={key} label={label} layout="stacked">
      <div className="min-w-0 border-l pl-3">{renderValue(value, depth + 1, context)}</div>
    </KeyValue>
  );
}

function renderList(items: unknown[], depth: number, context: ViewContext): ReactNode {
  if (items.every(isScalar)) {
    const shown = take(items, context);
    if (shown.length === 0) {
      return <More count={items.length} context={context} />;
    }
    return (
      <div className="grid min-w-0 gap-1">
        <List>
          {shown.map((item, index) => (
            <ListRow key={index} size="compact" title={spendText(item, context, MAX_TEXT)} />
          ))}
        </List>
        <More count={items.length - shown.length} context={context} />
      </div>
    );
  }
  // Only the rows a table can show are read for its shape.
  const head = items.slice(0, MAX_ROWS);
  if (head.every(isFlatRecord)) {
    const columns = tableColumns(head);
    if (columns) {
      return renderTable(head, items.length, columns, context);
    }
  }
  // Objects with nested values, or values of different shapes: each item is a section under
  // its position in the list.
  const shown = take(items, context);
  if (shown.length === 0) {
    return <More count={items.length} context={context} />;
  }
  return (
    <div className="grid min-w-0 gap-2">
      <KeyValueList>
        {shown.map((item, index) =>
          renderField(String(index), String(index + 1), item, depth, context)
        )}
      </KeyValueList>
      <More count={items.length - shown.length} context={context} />
    </div>
  );
}

function renderTable(
  rows: Array<Record<string, Scalar>>,
  total: number,
  columns: string[],
  context: ViewContext
): ReactNode {
  const fit = Math.max(0, Math.floor(context.budget.left / columns.length));
  const shown = rows.slice(0, Math.min(MAX_ROWS, fit));
  if (shown.length === 0) {
    return <More count={total} context={context} />;
  }
  const numeric = new Set(
    columns.filter((column) =>
      shown.every(
        (row) => row[column] === undefined || row[column] === null || isNumber(row[column])
      )
    )
  );
  return (
    <div className="grid min-w-0 gap-1">
      <Table density="compact">
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column} align={numeric.has(column) ? "end" : "start"}>
                {labelOf(column)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row, index) => (
            <TableRow key={index}>
              {columns.map((column) => (
                <TableCell key={column} align={numeric.has(column) ? "end" : "start"}>
                  {spendText(row[column], context, MAX_CELL_TEXT)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <More count={total - shown.length} context={context} />
    </div>
  );
}

/** The columns of flat objects as a table: all their fields, unless there are too many. */
function tableColumns(rows: Array<Record<string, Scalar>>): string[] | undefined {
  const columns = new Set(rows.flatMap((row) => Object.keys(row)));
  return columns.size > 0 && columns.size <= MAX_COLUMNS ? [...columns] : undefined;
}

function More({ count, context }: { count: number; context: ViewContext }) {
  return count > 0 ? (
    <p className="text-caption text-muted-foreground">{context.t("dataViewMore", { count })}</p>
  ) : null;
}

/** The items a level shows: at most `MAX_ROWS`, and none once the view has shown enough. */
function take<Item>(items: readonly Item[], context: ViewContext): Item[] {
  return items.slice(0, Math.min(MAX_ROWS, Math.max(0, context.budget.left)));
}

function spendText(value: Scalar, context: ViewContext, max: number): string {
  context.budget.left -= 1;
  return scalarText(value, context, max);
}

function scalarText(value: Scalar, context: ViewContext, max: number): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "boolean") {
    return context.t(value ? "dataViewYes" : "dataViewNo");
  }
  if (typeof value === "number") {
    return cut(
      Number.isFinite(value)
        ? new Intl.NumberFormat(context.locale, {
            useGrouping: false,
            maximumFractionDigits: 20
          }).format(value)
        : String(value),
      max
    );
  }
  if (typeof value !== "string") {
    return cut(String(value), max);
  }
  return dateText(value, context.locale) ?? cut(value, max);
}

/** A day or a moment written as ISO 8601, in the reader's language. A day that does not exist, such as 2026-02-31, stays text. */
function dateText(value: string, locale: LocaleCode): string | undefined {
  if (ISO_DAY.test(value) && isRealDay(value)) {
    return formatCalendarDay(value, locale);
  }
  if (ISO_MOMENT.test(value) && isRealDay(value.slice(0, 10)) && !Number.isNaN(Date.parse(value))) {
    return formatMomentShort(value, locale);
  }
  return undefined;
}

/** Whether a day of the form 2026-11-19 is on the calendar: it reads back as itself. */
function isRealDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  // Cut first, so a long text is never spread into characters; a cut through a pair of
  // surrogates leaves its first half, which is dropped.
  const head = text.slice(0, max - 1);
  const last = head.charCodeAt(head.length - 1);
  const whole = last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
  return `${whole.trimEnd()}…`;
}

function countText(value: unknown, context: ViewContext): string {
  if (Array.isArray(value)) {
    return value.length === 1
      ? context.t("dataViewItemsOne")
      : context.t("dataViewItemsMany", { count: value.length });
  }
  const fields = isRecord(value) ? Object.keys(value).length : 0;
  return fields === 1
    ? context.t("dataViewFieldsOne")
    : context.t("dataViewFieldsMany", { count: fields });
}

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value !== "object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An object whose values are all plain: a row of a table. */
function isFlatRecord(value: unknown): value is Record<string, Scalar> {
  return isRecord(value) && Object.values(value).every(isScalar);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Nothing to show: no value, or an object or list without entries. */
function isEmpty(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return value !== null && typeof value === "object" && Object.keys(value).length === 0;
}
