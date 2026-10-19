import { requireScopeBindings } from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  POSTGRES_QUERY_TEXT_MAX_CHARS,
  POSTGRES_PARAMETERS_MAX_COUNT,
  POSTGRES_RESULT_MAX_ROWS,
  POSTGRES_RESULT_MAX_BYTES,
  POSTGRES_STATEMENT_TIMEOUT_MS
} from "@work-shape/catalyst-postgres-connector";
import {
  DATA_STORE_SCALAR_TYPES,
  DATA_STORE_QUERY_DEFAULT_TIMEOUT_MS,
  type DataStoreParameterType
} from "@work-shape/catalyst-core";
import { bindViewerScopes, scopedQuery } from "./scoped-tables";
import { rowsOf } from "./catalog";
import type { StoreVerb } from "./verbs";

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const queryParameterValueSchema = z.union([scalarSchema, z.array(scalarSchema)]);
const parameterTypes: readonly DataStoreParameterType[] = DATA_STORE_SCALAR_TYPES.flatMap(
  (type) => [type, `${type}[]`] as const
);

/** One read-only statement and the values it binds: the input of every SQL read of a store. */
export const queryInputSchema = z.strictObject({
  sql: z.string().min(1).max(POSTGRES_QUERY_TEXT_MAX_CHARS),
  parameters: z
    .array(
      z.union([
        queryParameterValueSchema,
        z.strictObject({ type: z.enum(parameterTypes), value: queryParameterValueSchema })
      ])
    )
    .max(POSTGRES_PARAMETERS_MAX_COUNT)
    .optional()
});

/** Rows as a SQL read of a store answers them. */
export const rowsSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string(), nativeType: z.string() })),
  rows: z.array(z.record(z.string(), z.json())),
  truncated: z.boolean()
});

export const query: StoreVerb = {
  verb: "query",
  effect: "reading",
  streams: true,
  inputSchema: queryInputSchema,
  outputSchema: rowsSchema,
  use: `Reads rows. Use it to answer from what is stored there. Send one read-only SELECT or WITH statement in PostgreSQL syntax. Put every value into "parameters" and refer to it as $1, $2 and so on; never write a value into the SQL. A parameter is the bare value, or { "type", "value" } where the database cannot tell its type. The tables are in the schema "public"; call describe to learn their columns. At most ${POSTGRES_RESULT_MAX_ROWS} rows and ${POSTGRES_RESULT_MAX_BYTES} bytes come back, and "truncated" says when there were more: narrow the statement or page with LIMIT and OFFSET. A statement that runs longer than ${POSTGRES_STATEMENT_TIMEOUT_MS / 1000} seconds is cancelled.`,
  async run({ runtime, target, context, store }, call) {
    const parsed = queryInputSchema.parse(call);
    if (context?.byAppAction) requireScopeBindings(parsed.sql, store.definition.tables, "sql");
    const input = context?.byAppAction
      ? bindViewerScopes(parsed.sql, parsed.parameters, context.access)
      : scopedQuery(parsed.sql, store.definition.tables, context?.access, parsed.parameters);
    const capture = context?.runtime.captureOutput;
    if (capture && context.origin.kind === "workflow") {
      return runtime.server.executor.stream(
        {
          ...target,
          ...input,
          rowBytes: runtime.limits.streamRowBytes ?? POSTGRES_RESULT_MAX_BYTES,
          timeoutMs: runtime.limits.queryTimeoutMs ?? DATA_STORE_QUERY_DEFAULT_TIMEOUT_MS
        },
        (result) =>
          capture({
            columns: rowsOf({ columns: result.columns, rows: [], rowCount: 0, truncated: false })
              .columns,
            rows: result.rows,
            truncated: false
          })
      );
    }
    return rowsOf(
      await runtime.server.executor.query({
        ...target,
        sql: input.sql,
        ...(input.parameters ? { parameters: input.parameters } : {})
      })
    );
  }
};
