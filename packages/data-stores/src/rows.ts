import type { PostgresParameter } from "@vivd-catalyst/postgres-connector";
import { AppError, DATA_STORE_PREVIEW_ROW_LIMIT, type JsonObject } from "@vivd-catalyst/core";
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
   * `physical`: the table has no primary key, so they come in the order they lie in, which a
   * change of a row and a rewrite of the table move: a page may then show a row twice or miss one.
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
  valueMaxChars: z.number().int()
});

const valueInputSchema = z.strictObject({
  table: tableNameSchema,
  column: z.string().min(1).max(63),
  /** `at` of the row. */
  at: cursorSchema
});

const valueOutputSchema = z.object({ value: z.json() });

/** Where a row is: the values of its key as text, or the place it lies at. */
const placeSchema = z.union([
  z.strictObject({ k: z.array(z.string()).min(1) }),
  z.strictObject({ p: z.string().regex(/^\(\d+,\d+\)$/u) })
]);
type Place = z.infer<typeof placeSchema>;

const cursorInvalid = () =>
  new AppError(
    "VALIDATION_FAILED",
    "This cursor does not name a row of the table as it is now. Read the table from its first page again.",
    { reason: "cursor_invalid" }
  );

const cursorOf = (place: Place) => Buffer.from(JSON.stringify(place)).toString("base64url");

function placeOf(cursor: string): Place {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return placeSchema.parse(parsed);
  } catch {
    throw cursorInvalid();
  }
}

/** The columns of the primary key of a table, in the order of its index. */
const PRIMARY_KEY = `
  select a.attname::text as name
  from pg_catalog.pg_index i
  join pg_catalog.pg_class c on c.oid = i.indrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.unnest(i.indkey::int2[]) with ordinality as k(attnum, position) on true
  join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
  where n.nspname = 'public' and c.relname = $1 and i.indisprimary
    and k.position <= i.indnkeyatts
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
      condition: `stored.ctid ${operator} ($1::pg_catalog.text)::pg_catalog.tid`,
      parameters: [{ type: "text", value: place.p }]
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
    // Every column is answered under a name of this statement's own, so no name of the table
    // meets one of them: `v` the value, `x` its first characters where it is longer than a
    // page answers, `k` what the row is found again by.
    const long = (column: string) =>
      `pg_catalog.length(stored.${quoteIdentifier(column)}::pg_catalog.text) > ${DATA_STORE_ROW_VALUE_MAX_CHARS}`;
    const selected = [
      ...table.columns.flatMap(({ name }, index) => [
        `case when ${long(name)} then null else stored.${quoteIdentifier(name)} end as "v${index}"`,
        `case when ${long(name)} then pg_catalog.left(stored.${quoteIdentifier(name)}::pg_catalog.text, ${DATA_STORE_ROW_VALUE_MAX_CHARS}) end as "x${index}"`
      ]),
      ...(key.length > 0
        ? key.map(
            ({ column }, index) =>
              `stored.${quoteIdentifier(column)}::pg_catalog.text as "k${index}"`
          )
        : [`stored.ctid::pg_catalog.text as "k0"`])
    ];
    const order =
      key.length > 0
        ? key.map(({ column }) => `stored.${quoteIdentifier(column)}`).join(", ")
        : "stored.ctid";
    const read = await call.runtime.server.executor.query({
      ...call.target,
      // One row more than the page says whether a row follows it.
      limits: { ...call.target.limits, maxRows: input.limit + 1 },
      sql: `select ${selected.join(", ")} from ${stored} as stored
        ${from ? `where ${from.condition}` : ""} order by ${order}`,
      ...(from ? { parameters: from.parameters } : {})
    });
    const page = read.rows.slice(0, input.limit).map((row: JsonObject) => {
      const cut = table.columns.flatMap(({ name }, index) =>
        typeof row[`x${index}`] === "string" ? [name] : []
      );
      const texts = (key.length > 0 ? key : [undefined]).map((_, index) =>
        String(row[`k${index}`])
      );
      return {
        at: cursorOf(key.length > 0 ? { k: texts } : { p: texts[0] ?? "" }),
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
      columns: table.columns.map(({ name, type, nativeType }) => ({ name, type, nativeType })),
      order:
        key.length > 0
          ? { by: "key" as const, columns: key.map(({ column }) => column) }
          : { by: "physical" as const },
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
    const read = await call.runtime.server.executor.query({
      ...call.target,
      limits: { ...call.target.limits, maxRows: 1 },
      sql: `select stored.${quoteIdentifier(column.name)} as "v" from ${ordered.stored} as stored
        where ${at.condition}`,
      parameters: at.parameters
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
