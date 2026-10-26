import { scopePredicate } from "./scoped-tables";
import type { PostgresParameter } from "@work-shape/catalyst-postgres-connector";
import {
  AppError,
  DATA_STORE_PREVIEW_ROW_LIMIT,
  decodePageCursor,
  encodePageCursor,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { catalogTarget, readTables } from "./catalog";
import { quoteIdentifier } from "./server";
import { tableUnknown, type StoreRead } from "./verbs";

// The rows of one table, a page at a time, for whoever reads a store on its page: in the
// order of the table's primary key, or in the order the rows lie in where it has none, with
// long values cut and each one readable whole by one more read. Both reads run as the app
// role in a read-only transaction, under the row, byte and time ceilings of every read of a
// store.

/** How many rows one page holds at most: as many as the preview answers. */
const DATA_STORE_ROWS_PAGE_MAX = DATA_STORE_PREVIEW_ROW_LIMIT;
/**
 * How many characters of a value a page answers, counted on the value as text. A longer
 * value is cut there and named in `cut` of its row; `value` reads it whole.
 */
const DATA_STORE_ROW_VALUE_MAX_CHARS = 1_000;
/**
 * How many bytes a value that is no text may take as it is stored before a page leaves it
 * unread. A text is cut by reading its first characters alone. Any other value has to be read
 * whole to be shown as text, so one stored above this size is answered as an empty text and
 * named in `cut`: a page never reads a long value.
 */
const DATA_STORE_ROW_VALUE_READ_MAX_BYTES = 65_536;
/** How long a cursor is at most, in characters: the keys of one row as text. */
const DATA_STORE_ROW_CURSOR_MAX_CHARS = 8_192;

const tableNameSchema = z.string().min(1).max(63);
const cursorSchema = z.string().min(1).max(DATA_STORE_ROW_CURSOR_MAX_CHARS);

const rowsInputSchema = z.strictObject({
  table: tableNameSchema,
  limit: z.number().int().min(1).max(DATA_STORE_ROWS_PAGE_MAX).default(DATA_STORE_ROWS_PAGE_MAX),
  /** `next` of the page before, or `at` of a row: the page starts behind that row. */
  after: cursorSchema.optional()
});

const rowsOutputSchema = z.object({
  table: z.string(),
  columns: z.array(z.object({ name: z.string(), type: z.string(), nativeType: z.string() })),
  /**
   * `key`: the rows come in the order of the table's primary key, whose columns are named.
   * `physical`: the table has no key that holds for all its rows, so they come in the order
   * they lie in, part by part of the table. While nothing changes every row comes once; a
   * change of a row and a rewrite of the table move rows, and a page may then show a row
   * twice or miss one.
   */
  order: z.union([
    z.object({ by: z.literal("key"), columns: z.array(z.string()) }),
    z.object({ by: z.literal("physical") })
  ]),
  rows: z.array(
    z.object({
      /** Where the row is: what `after` and `value` take. */
      at: z.string(),
      values: z.record(z.string(), z.json()),
      /** The columns whose value was cut, as text, at `valueMaxChars`. Left out where none was. */
      cut: z.array(z.string()).optional()
    })
  ),
  /** What `after` takes for the next page. Left out behind the last row. */
  next: z.string().optional(),
  scopeUnassigned: z.string().optional(),
  valueMaxChars: z.number().int()
});

const valueInputSchema = z.strictObject({
  table: tableNameSchema,
  column: z.string().min(1).max(63),
  /** `at` of the row. */
  at: cursorSchema
});

const valueOutputSchema = z.object({ value: z.json() });

/**
 * Where a row is: the values of its key as text, or the place it lies at, which is the part of
 * the table that holds it (`t`, the table itself, a partition or a child) and its place in
 * that part (`p`). The place in a part alone names a row of each part.
 */
const placeSchema = z.union([
  z.strictObject({ k: z.array(z.string()).min(1) }),
  z.strictObject({ t: z.string().regex(/^\d+$/u), p: z.string().regex(/^\(\d+,\d+\)$/u) })
]);
type Place = z.infer<typeof placeSchema>;

const cursorInvalid = () =>
  new AppError(
    "VALIDATION_FAILED",
    "This cursor does not name a row of the table as it is now. Read the table from its first page again.",
    { reason: "cursor_invalid" }
  );

function placeOf(cursor: string): Place {
  try {
    const parsed: unknown = decodePageCursor(cursor);
    return placeSchema.parse(parsed);
  } catch {
    throw cursorInvalid();
  }
}

/**
 * The columns of the primary key of a table, in the order of its index. A table that other
 * tables inherit from has none here: its key holds for its own rows and not for the rows of
 * its children, which a read of it answers too. The key of a partitioned table holds for all
 * its partitions.
 */
const PRIMARY_KEY = `
  select a.attname::text as name
  from pg_catalog.pg_index i
  join pg_catalog.pg_class c on c.oid = i.indrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.unnest(i.indkey::int2[]) with ordinality as k(attnum, position) on true
  join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
  where n.nspname = 'public' and c.relname = $1 and i.indisprimary
    and k.position <= i.indnkeyatts
    and not (c.relkind = 'r' and exists (
      select 1 from pg_catalog.pg_inherits h where h.inhparent = c.oid))
  order by k.position
`;

type Call = Parameters<StoreRead["run"]>[0];

/** The table as the catalog has it, with the columns its rows are ordered and found by. */
async function orderedTable({ runtime, target }: Call, name: string) {
  const [table] = await readTables(runtime.server.executor, target, name);
  if (!table) throw tableUnknown(name);
  const read = await runtime.server.executor.query({
    ...catalogTarget(target),
    sql: PRIMARY_KEY,
    parameters: [table.name]
  });
  const key = z.array(z.object({ name: z.string() })).parse(read.rows);
  const typeOf = new Map(table.columns.map((column) => [column.name, column.nativeType]));
  return {
    table,
    stored: `public.${quoteIdentifier(table.name)}`,
    key: key.map(({ name: column }) => ({
      column,
      nativeType: typeOf.get(column) ?? "text"
    }))
  };
}

type Ordered = Awaited<ReturnType<typeof orderedTable>>;

/**
 * The comparison of a row's place with a cursor, and the values it binds. The values are
 * bound as text and read by the database as the type of their column; a name in the statement
 * is the catalog's.
 */
function placed(
  { key }: Ordered,
  place: Place,
  operator: ">" | "="
): { condition: string; parameters: PostgresParameter[] } {
  if ("p" in place) {
    if (key.length > 0) throw cursorInvalid();
    return {
      condition: `(stored.tableoid, stored.ctid) ${operator} (($1::pg_catalog.text)::pg_catalog.oid, ($2::pg_catalog.text)::pg_catalog.tid)`,
      parameters: [
        { type: "text", value: place.t },
        { type: "text", value: place.p }
      ]
    };
  }
  if (place.k.length !== key.length) throw cursorInvalid();
  const columns = key.map(({ column }) => `stored.${quoteIdentifier(column)}`).join(", ");
  const values = key
    .map(({ nativeType }, index) => `($${index + 1}::pg_catalog.text)::${nativeType}`)
    .join(", ");
  return {
    condition: `(${columns}) ${operator} (${values})`,
    parameters: place.k.map((value) => ({ type: "text" as const, value }))
  };
}

export const rows: StoreRead = {
  part: "rows",
  inputSchema: rowsInputSchema,
  outputSchema: rowsOutputSchema,
  async run(call, raw) {
    const input = rowsInputSchema.parse(raw);
    const ordered = await orderedTable(call, input.table);
    const { table, stored, key } = ordered;
    const from = input.after === undefined ? undefined : placed(ordered, placeOf(input.after), ">");
    const filter = scopePredicate(
      call.store.definition.tables,
      table.name,
      call.context?.access,
      from?.parameters.length ?? 0,
      "stored"
    );
    const physical = key.length === 0;
    const column = (name: string) => `page.${quoteIdentifier(name)}`;
    // Names of this statement's own that no column of the table has: the part of the table a
    // row lies in and its place there, which a table has under no name of its own.
    const free = (name: string): string =>
      table.columns.some((candidate) => candidate.name === name) ? free(`${name}_`) : name;
    const [part, place] = [free("row_part"), free("row_place")].map(quoteIdentifier);
    // The rows of the page are found first, by their key or their place alone, and no value
    // of a row that is not on the page is looked at.
    const order = physical
      ? "stored.tableoid, stored.ctid"
      : key.map(({ column: name }) => `stored.${quoteIdentifier(name)}`).join(", ");
    const found = `select stored.*, stored.tableoid::pg_catalog.oid as ${part}, stored.ctid as ${place}
      from ${stored} as stored where (${from ? from.condition : "true"}) and (${filter.condition})
      order by ${order} limit ${input.limit + 1}`;
    // Then each value is cut where the database holds it. A text is read up to one character
    // past what a page answers, which reads the beginning of a long one and not the rest.
    // Another value must be read whole to be text, so one stored above the read bound is not
    // read at all. Every column is answered under a name of this statement's own: `v` the
    // value, `x` its first characters where it is cut, `k` what the row is found again by.
    const selected = [
      ...table.columns.flatMap(({ name, type }, index) => {
        const shown = `pg_catalog.left(${column(name)}::pg_catalog.text, ${DATA_STORE_ROW_VALUE_MAX_CHARS + 1})`;
        const long = `pg_catalog.length(${shown}) > ${DATA_STORE_ROW_VALUE_MAX_CHARS}`;
        const cutText = `pg_catalog.left(${column(name)}::pg_catalog.text, ${DATA_STORE_ROW_VALUE_MAX_CHARS})`;
        if (type === "text") {
          return [
            `case when ${long} then null else ${column(name)} end as "v${index}"`,
            `case when ${long} then ${cutText} end as "x${index}"`
          ];
        }
        const unread = `pg_catalog.pg_column_size(${column(name)}) > ${DATA_STORE_ROW_VALUE_READ_MAX_BYTES}`;
        return [
          `case when ${unread} then null when ${long} then null else ${column(name)} end as "v${index}"`,
          `case when ${unread} then '' when ${long} then ${cutText} end as "x${index}"`
        ];
      }),
      ...(physical
        ? [`page.${part}::pg_catalog.text as "k0"`, `page.${place}::pg_catalog.text as "k1"`]
        : key.map(({ column: name }, index) => `${column(name)}::pg_catalog.text as "k${index}"`))
    ];
    const pageOrder = physical
      ? `page.${part}, page.${place}`
      : key.map(({ column: name }) => column(name)).join(", ");
    const read = await call.runtime.server.executor.query({
      ...call.target,
      // One row more than the page says whether a row follows it.
      limits: { ...call.target.limits, maxRows: input.limit + 1 },
      sql: `select ${selected.join(", ")} from (${found}) as page order by ${pageOrder}`,
      parameters: [...(from?.parameters ?? []), ...filter.parameters]
    });
    const page = read.rows.slice(0, input.limit).map((row: JsonObject) => {
      const cut = table.columns.flatMap(({ name }, index) =>
        typeof row[`x${index}`] === "string" ? [name] : []
      );
      return {
        at: encodePageCursor(
          physical
            ? { t: String(row.k0), p: String(row.k1) }
            : { k: key.map((_, index) => String(row[`k${index}`])) }
        ),
        values: Object.fromEntries(
          table.columns.map(({ name }, index) => [
            name,
            row[`x${index}`] ?? row[`v${index}`] ?? null
          ])
        ),
        ...(cut.length > 0 ? { cut } : {})
      };
    });
    // A row follows where one more was read, or where the byte ceiling ended the read early.
    const more = read.rows.length > input.limit || read.truncated;
    const last = page.at(-1);
    return {
      table: table.name,
      ...(filter.unassigned
        ? {
            scopeUnassigned:
              call.runtime.scopes?.[
                Object.keys(call.store.definition.tables?.[table.name]?.scope ?? {})[0] ?? ""
              ]?.label ?? "data"
          }
        : {}),
      columns: table.columns.map(({ name, type, nativeType }) => ({ name, type, nativeType })),
      order: physical
        ? { by: "physical" as const }
        : { by: "key" as const, columns: key.map(({ column: name }) => name) },
      rows: page,
      ...(more && last ? { next: last.at } : {}),
      valueMaxChars: DATA_STORE_ROW_VALUE_MAX_CHARS
    } satisfies z.infer<typeof rowsOutputSchema>;
  }
};

export const value: StoreRead = {
  part: "value",
  inputSchema: valueInputSchema,
  outputSchema: valueOutputSchema,
  async run(call, raw) {
    const input = valueInputSchema.parse(raw);
    const ordered = await orderedTable(call, input.table);
    const column = ordered.table.columns.find(({ name }) => name === input.column);
    if (!column) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The table '${ordered.table.name}' has no column '${input.column}'`,
        { reason: "column_unknown" }
      );
    }
    const at = placed(ordered, placeOf(input.at), "=");
    const filter = scopePredicate(
      call.store.definition.tables,
      ordered.table.name,
      call.context?.access,
      at.parameters.length,
      "stored"
    );
    const read = await call.runtime.server.executor.query({
      ...call.target,
      limits: { ...call.target.limits, maxRows: 1 },
      sql: `select stored.${quoteIdentifier(column.name)} as "v" from ${ordered.stored} as stored
        where (${at.condition}) and (${filter.condition})`,
      parameters: [...at.parameters, ...filter.parameters]
    });
    const [row] = read.rows;
    if (!row) {
      throw read.truncated
        ? new AppError(
            "VALIDATION_FAILED",
            "This value is larger than one read of a store answers (POSTGRES_RESULT_MAX_BYTES). Read a part of it with a query.",
            { reason: "value_too_large" }
          )
        : new AppError(
            "NOT_FOUND",
            "The row is not there any more: it was removed, or its key or its place changed. Read the table again.",
            { reason: "row_gone" }
          );
    }
    return { value: row.v ?? null } satisfies z.infer<typeof valueOutputSchema>;
  }
};
