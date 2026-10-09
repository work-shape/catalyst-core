import postgres from "postgres";
import { z } from "zod";
import type { DataSourceConfig, PostgresDataSourceConfig } from "@vivd-catalyst/core";
import { AppError } from "@vivd-catalyst/core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

export interface DataSourceRegistration {
  name: string;
  config: DataSourceConfig;
}

export interface DataSourceQueryInput {
  sourceName: string;
  query: string;
}

export interface DataSourceQueryResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export interface DataSourceDescribeInput {
  sourceName: string;
  relation?: string;
}

export interface DataSourceRelationSummary {
  schema: string;
  name: string;
  type: "table" | "view" | "materialized_view" | "foreign_table";
  description?: string;
}

export interface DataSourceColumnDescription {
  name: string;
  dataType: string;
  nullable: boolean;
  description?: string;
}

export interface DataSourceForeignKeyDescription {
  columns: string[];
  referencedSchema: string;
  referencedRelation: string;
  referencedColumns: string[];
}

export interface DataSourceRelationDescription extends DataSourceRelationSummary {
  columns: DataSourceColumnDescription[];
  primaryKey: string[];
  foreignKeys: DataSourceForeignKeyDescription[];
}

export interface DataSourceDescribeResult {
  relations: DataSourceRelationSummary[];
  relation?: DataSourceRelationDescription;
  truncated: boolean;
}

export interface DataSourceRegistry {
  list(): DataSourceRegistration[];
  get(sourceName: string): DataSourceRegistration | undefined;
  query(input: DataSourceQueryInput): Promise<DataSourceQueryResult>;
  describe(input: DataSourceDescribeInput): Promise<DataSourceDescribeResult>;
}

export interface SecretResolver {
  resolveConnectionRef(ref: string): string;
}

export interface CreateDataSourceRegistryInput {
  configs: Record<string, DataSourceConfig>;
  secretResolver: SecretResolver;
}

export interface CreateDataSourceToolsInput {
  dataSources: DataSourceRegistry;
}

/** @deprecated Use CreateDataSourceToolsInput. */
export type CreateDataSourceQueryToolsInput = CreateDataSourceToolsInput;

const queryToolInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(20000)
    .describe("Read-only SQL query for the configured data source.")
});

const queryToolOutputSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean()
});

type QueryToolInput = z.infer<typeof queryToolInputSchema>;
type QueryToolOutput = z.infer<typeof queryToolOutputSchema>;

const describeToolInputSchema = z.object({
  relation: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "Optional relation name, such as fact_sales or reporting.fact_sales. Omit it to list readable relations."
    )
});

const relationSummarySchema = z.object({
  schema: z.string(),
  name: z.string(),
  type: z.enum(["table", "view", "materialized_view", "foreign_table"]),
  description: z.string().optional()
});

const describeToolOutputSchema = z.object({
  relations: z.array(relationSummarySchema),
  relation: relationSummarySchema
    .extend({
      columns: z.array(
        z.object({
          name: z.string(),
          dataType: z.string(),
          nullable: z.boolean(),
          description: z.string().optional()
        })
      ),
      primaryKey: z.array(z.string()),
      foreignKeys: z.array(
        z.object({
          columns: z.array(z.string()),
          referencedSchema: z.string(),
          referencedRelation: z.string(),
          referencedColumns: z.array(z.string())
        })
      )
    })
    .optional(),
  truncated: z.boolean()
});

type DescribeToolInput = z.infer<typeof describeToolInputSchema>;
type DescribeToolOutput = z.infer<typeof describeToolOutputSchema>;

interface RegisteredDataSource extends DataSourceRegistration {
  adapter: DataSourceAdapter;
}

interface DataSourceAdapter {
  query(query: string): Promise<DataSourceQueryResult>;
  describe(relation?: string): Promise<DataSourceDescribeResult>;
}

export function createDataSourceRegistry(input: CreateDataSourceRegistryInput): DataSourceRegistry {
  return new DefaultDataSourceRegistry(
    Object.entries(input.configs).map(([name, config]) => ({
      name,
      config,
      adapter: createDataSourceAdapter(config, input.secretResolver)
    }))
  );
}

export function createEnvSecretResolver(env: Record<string, string | undefined>): SecretResolver {
  return {
    resolveConnectionRef(ref) {
      const envPrefix = "env:";
      if (!ref.startsWith(envPrefix)) {
        throw new AppError(
          "VALIDATION_FAILED",
          "Only env: data source connection references are supported"
        );
      }
      const envName = ref.slice(envPrefix.length);
      const value = env[envName];
      if (!value) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Missing data source connection secret '${envName}'`
        );
      }
      return value;
    }
  };
}

export function createDataSourceTools(input: CreateDataSourceToolsInput): AnyToolDefinition[] {
  const dataSources = input.dataSources;
  return dataSources.list().flatMap(({ name, config }) => {
    const queryTool = config.tools?.query;
    if (!queryTool?.enabled) {
      return [];
    }
    const toolName = queryTool.name ?? `data.${name}.query`;
    const describeToolName = `data.${name}.describe`;
    return [
      defineTool<QueryToolInput, QueryToolOutput>({
        name: toolName,
        description: [
          `Run a read-only query against ${config.description}.`,
          `Use ${describeToolName} first when the schema is unfamiliar.`,
          config.sql.allowedSchemas.length > 0
            ? `Unqualified table names resolve through these configured schemas: ${config.sql.allowedSchemas.join(", ")}.`
            : "",
          config.sql.schemaDescription
            ? `Allowed query surface: ${config.sql.schemaDescription}`
            : ""
        ]
          .filter(Boolean)
          .join(" "),
        inputSchema: queryToolInputSchema,
        outputSchema: queryToolOutputSchema,
        async execute(toolInput) {
          const result = await dataSources.query({
            sourceName: name,
            query: toolInput.query
          });
          return toolSuccess(result, {
            auditSummary: {
              action: toolName,
              subject: name,
              metadata: {
                rowCount: result.rows.length,
                truncated: result.truncated
              }
            }
          });
        }
      }),
      defineTool<DescribeToolInput, DescribeToolOutput>({
        name: describeToolName,
        description: `Discover the readable schema of ${config.description}. Omit relation to list tables and views, or provide one relation to inspect its columns, primary key, and foreign keys.`,
        inputSchema: describeToolInputSchema,
        outputSchema: describeToolOutputSchema,
        async execute(toolInput) {
          const result = await dataSources.describe({
            sourceName: name,
            relation: toolInput.relation
          });
          return toolSuccess(result, {
            auditSummary: {
              action: describeToolName,
              subject: name,
              metadata: toolInput.relation ? { relation: toolInput.relation } : {}
            }
          });
        }
      })
    ];
  });
}

/** @deprecated Query-enabled sources now expose both query and schema-description tools. */
export const createDataSourceQueryTools = createDataSourceTools;

export function assertReadOnlyQuery(query: string): void {
  const normalized = maskSqlLiteralsAndComments(query).trim().replace(/;+$/u, "").trim();
  if (!/^(select|with)\b/iu.test(normalized)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Data source queries must be read-only SELECT or WITH statements"
    );
  }
  if (/;\s*\S/u.test(normalized)) {
    throw new AppError("VALIDATION_FAILED", "Data source queries must contain a single statement");
  }
  if (
    /\bfor\s+(?:no\s+key\s+)?update\b/iu.test(normalized) ||
    /\bfor\s+(?:key\s+)?share\b/iu.test(normalized)
  ) {
    throw new AppError("VALIDATION_FAILED", "Data source queries must not request row locks");
  }
  if (containsDisallowedSqlToken(normalized)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Data source queries must not contain write, DDL, transaction, or session-control SQL"
    );
  }
}

class DefaultDataSourceRegistry implements DataSourceRegistry {
  private readonly registrations: Map<string, RegisteredDataSource>;

  constructor(registrations: RegisteredDataSource[]) {
    this.registrations = new Map(
      registrations.map((registration) => [registration.name, registration])
    );
  }

  list(): DataSourceRegistration[] {
    return [...this.registrations.values()].map(({ name, config }) => ({ name, config }));
  }

  get(sourceName: string): DataSourceRegistration | undefined {
    const registration = this.registrations.get(sourceName);
    return registration ? { name: registration.name, config: registration.config } : undefined;
  }

  async query(input: DataSourceQueryInput): Promise<DataSourceQueryResult> {
    const registration = this.registrations.get(input.sourceName);
    if (!registration) {
      throw new AppError("NOT_FOUND", `Data source '${input.sourceName}' is not configured`);
    }
    return registration.adapter.query(input.query);
  }

  async describe(input: DataSourceDescribeInput): Promise<DataSourceDescribeResult> {
    const registration = this.registrations.get(input.sourceName);
    if (!registration) {
      throw new AppError("NOT_FOUND", `Data source '${input.sourceName}' is not configured`);
    }
    return registration.adapter.describe(input.relation);
  }
}

/**
 * The mistakes in a query its author can correct, as an error the model may read: a syntax
 * error, an unknown or forbidden table, column or function (SQLSTATE class 42), a data
 * exception such as an invalid cast or a division by zero (class 22), and a statement that
 * ran into the timeout or was cancelled (57014). The text is the database's short message
 * and the position in the query. Every other failure, a connection error included, returns
 * undefined and stays internal.
 */
function toQueryFeedback(error: unknown): AppError | undefined {
  if (!(error instanceof postgres.PostgresError)) {
    return undefined;
  }
  if (error.code === "57014") {
    return new AppError("TIMEOUT", `Query was cancelled: ${error.message}`, undefined, {
      exposeMessage: true
    });
  }
  if (!error.code.startsWith("42") && !error.code.startsWith("22")) {
    return undefined;
  }
  const position = /^\d+$/u.test(error.position ?? "")
    ? ` (at character ${error.position} of the query)`
    : "";
  return new AppError("VALIDATION_FAILED", `Query failed: ${error.message}${position}`);
}

function createDataSourceAdapter(
  config: DataSourceConfig,
  secretResolver: SecretResolver
): DataSourceAdapter {
  switch (config.kind) {
    case "postgres":
      return new PostgresDataSourceAdapter({
        config,
        databaseUrl: secretResolver.resolveConnectionRef(config.connectionRef)
      });
  }
}

class PostgresDataSourceAdapter implements DataSourceAdapter {
  private readonly config: PostgresDataSourceConfig;
  private readonly databaseUrl: string;
  private readonly allowedSearchPath: string | undefined;

  constructor(input: { config: PostgresDataSourceConfig; databaseUrl: string }) {
    this.config = input.config;
    this.databaseUrl = input.databaseUrl;
    this.allowedSearchPath = createAllowedSearchPath(input.config.sql.allowedSchemas);
  }

  async query(query: string): Promise<DataSourceQueryResult> {
    assertReadOnlyQuery(query);
    const sql = postgres(this.databaseUrl, {
      max: 1,
      connect_timeout: Math.max(1, Math.ceil(this.config.sql.statementTimeoutMs / 1000)),
      idle_timeout: 1
    });
    try {
      await sql`begin read only`;
      if (this.allowedSearchPath) {
        // Schema allow lists guide unqualified lookup. Hard isolation belongs to
        // the read-only database role and grants behind the connectionRef.
        await sql.unsafe(`set local search_path to ${this.allowedSearchPath}`);
      }
      await sql`select set_config('statement_timeout', ${String(this.config.sql.statementTimeoutMs)}, true)`;
      const rows = await sql.unsafe(query);
      const limitedRows = rows.slice(0, this.config.sql.maxRows);
      await sql`commit`;
      return {
        rows: limitedRows.map((row) => ({ ...row })),
        truncated: rows.length > limitedRows.length
      };
    } catch (error) {
      try {
        await sql`rollback`;
      } catch {
        // The connection may already be closed or outside a transaction after a failed begin/commit.
      }
      throw toQueryFeedback(error) ?? error;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }

  async describe(relation?: string): Promise<DataSourceDescribeResult> {
    const sql = postgres(this.databaseUrl, {
      max: 1,
      connect_timeout: Math.max(1, Math.ceil(this.config.sql.statementTimeoutMs / 1000)),
      idle_timeout: 1
    });
    try {
      await sql`begin read only`;
      await sql`select set_config('statement_timeout', ${String(this.config.sql.statementTimeoutMs)}, true)`;
      const relationRows = await sql<RelationRow[]>`
        select
          namespace.nspname as schema,
          relation.relname as name,
          case relation.relkind
            when 'r' then 'table'
            when 'p' then 'table'
            when 'v' then 'view'
            when 'm' then 'materialized_view'
            when 'f' then 'foreign_table'
          end as type,
          obj_description(relation.oid, 'pg_class') as description
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        where relation.relkind in ('r', 'p', 'v', 'm', 'f')
          and namespace.nspname not in ('pg_catalog', 'information_schema')
          and namespace.nspname not like 'pg_toast%'
          and has_schema_privilege(namespace.oid, 'usage')
          and has_table_privilege(relation.oid, 'select')
        order by namespace.nspname, relation.relname
      `;
      const visibleRelations = relationRows
        .filter((row) => this.isSchemaAllowed(row.schema))
        .map(toRelationSummary);
      const listedRelations = visibleRelations.slice(0, this.config.sql.maxRows);
      if (!relation) {
        await sql`commit`;
        return {
          relations: listedRelations,
          truncated: visibleRelations.length > listedRelations.length
        };
      }

      const selected = resolveRelation(relation, visibleRelations);
      const [columnRows, primaryKeyRows, foreignKeyRows] = await Promise.all([
        sql<ColumnRow[]>`
          select
            attribute.attname as name,
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as data_type,
            not attribute.attnotnull as nullable,
            col_description(relation.oid, attribute.attnum) as description
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
          join pg_catalog.pg_attribute attribute on attribute.attrelid = relation.oid
          where namespace.nspname = ${selected.schema}
            and relation.relname = ${selected.name}
            and attribute.attnum > 0
            and not attribute.attisdropped
          order by attribute.attnum
        `,
        sql<PrimaryKeyRow[]>`
          select attribute.attname as name
          from pg_catalog.pg_constraint constraint_record
          join pg_catalog.pg_class relation on relation.oid = constraint_record.conrelid
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
          join unnest(constraint_record.conkey) with ordinality key_column(attnum, position) on true
          join pg_catalog.pg_attribute attribute
            on attribute.attrelid = relation.oid and attribute.attnum = key_column.attnum
          where constraint_record.contype = 'p'
            and namespace.nspname = ${selected.schema}
            and relation.relname = ${selected.name}
          order by key_column.position
        `,
        sql<ForeignKeyRow[]>`
          select
            array(
              select attribute.attname
              from unnest(constraint_record.conkey) with ordinality key_column(attnum, position)
              join pg_catalog.pg_attribute attribute
                on attribute.attrelid = relation.oid and attribute.attnum = key_column.attnum
              order by key_column.position
            ) as columns,
            referenced_namespace.nspname as referenced_schema,
            referenced_relation.relname as referenced_relation,
            array(
              select attribute.attname
              from unnest(constraint_record.confkey) with ordinality key_column(attnum, position)
              join pg_catalog.pg_attribute attribute
                on attribute.attrelid = referenced_relation.oid and attribute.attnum = key_column.attnum
              order by key_column.position
            ) as referenced_columns
          from pg_catalog.pg_constraint constraint_record
          join pg_catalog.pg_class relation on relation.oid = constraint_record.conrelid
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
          join pg_catalog.pg_class referenced_relation on referenced_relation.oid = constraint_record.confrelid
          join pg_catalog.pg_namespace referenced_namespace
            on referenced_namespace.oid = referenced_relation.relnamespace
          where constraint_record.contype = 'f'
            and namespace.nspname = ${selected.schema}
            and relation.relname = ${selected.name}
          order by constraint_record.conname
        `
      ]);
      await sql`commit`;
      return {
        relations: listedRelations,
        relation: {
          ...selected,
          columns: columnRows.map((row) => ({
            name: row.name,
            dataType: row.data_type,
            nullable: row.nullable,
            ...(row.description ? { description: row.description } : {})
          })),
          primaryKey: primaryKeyRows.map((row) => row.name),
          foreignKeys: foreignKeyRows.map((row) => ({
            columns: row.columns,
            referencedSchema: row.referenced_schema,
            referencedRelation: row.referenced_relation,
            referencedColumns: row.referenced_columns
          }))
        },
        truncated: visibleRelations.length > listedRelations.length
      };
    } catch (error) {
      try {
        await sql`rollback`;
      } catch {
        // The connection may already be closed or outside a transaction after a failed begin/commit.
      }
      throw error;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }

  private isSchemaAllowed(schema: string): boolean {
    const allowedSchemas = this.config.sql.allowedSchemas;
    return allowedSchemas.length === 0 || allowedSchemas.includes(schema);
  }
}

interface RelationRow {
  schema: string;
  name: string;
  type: DataSourceRelationSummary["type"];
  description: string | null;
}

interface ColumnRow {
  name: string;
  data_type: string;
  nullable: boolean;
  description: string | null;
}

interface PrimaryKeyRow {
  name: string;
}

interface ForeignKeyRow {
  columns: string[];
  referenced_schema: string;
  referenced_relation: string;
  referenced_columns: string[];
}

function toRelationSummary(row: RelationRow): DataSourceRelationSummary {
  return {
    schema: row.schema,
    name: row.name,
    type: row.type,
    ...(row.description ? { description: row.description } : {})
  };
}

function resolveRelation(
  requestedRelation: string,
  relations: DataSourceRelationSummary[]
): DataSourceRelationSummary {
  const parts = requestedRelation.trim().split(".");
  if (parts.length > 2 || parts.some((part) => part.length === 0)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Relation must be an unqualified name or a schema-qualified name"
    );
  }
  const matches =
    parts.length === 2
      ? relations.filter((relation) => relation.schema === parts[0] && relation.name === parts[1])
      : relations.filter((relation) => relation.name === parts[0]);
  if (matches.length === 0) {
    throw new AppError("NOT_FOUND", `Readable relation '${requestedRelation}' was not found`);
  }
  if (matches.length > 1) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Relation '${requestedRelation}' exists in multiple schemas; use a schema-qualified name`
    );
  }
  const [match] = matches;
  if (!match)
    throw new AppError("NOT_FOUND", `Readable relation '${requestedRelation}' was not found`);
  return match;
}

function createAllowedSearchPath(allowedSchemas: readonly string[]): string | undefined {
  if (allowedSchemas.length === 0) {
    return undefined;
  }
  return allowedSchemas.map(quotePostgresIdentifier).join(", ");
}

function quotePostgresIdentifier(identifier: string): string {
  if (identifier.includes("\u0000")) {
    throw new AppError("VALIDATION_FAILED", "Postgres schema names must not contain null bytes");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

const DISALLOWED_SQL_TOKENS = new Set([
  "alter",
  "analyze",
  "call",
  "copy",
  "create",
  "delete",
  "discard",
  "do",
  "drop",
  "execute",
  "grant",
  "insert",
  "listen",
  "lock",
  "merge",
  "notify",
  "refresh",
  "reset",
  "revoke",
  "set",
  "truncate",
  "update",
  "vacuum"
]);

function containsDisallowedSqlToken(sql: string): boolean {
  for (const match of sql.matchAll(/\b[a-z_][a-z0-9_]*\b/giu)) {
    if (DISALLOWED_SQL_TOKENS.has(match[0].toLowerCase())) {
      return true;
    }
  }
  return /\bselect\b[\s\S]*\binto\b/iu.test(sql);
}

function maskSqlLiteralsAndComments(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "'" || char === '"') {
      const endIndex = skipQuoted(sql, index, char);
      output += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }
    const dollarQuoteTag = readDollarQuoteTag(sql, index);
    if (dollarQuoteTag) {
      const endIndex = skipDollarQuoted(sql, index, dollarQuoteTag);
      output += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }
    if (char === "-" && next === "-") {
      const endIndex = skipLineComment(sql, index);
      output += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }
    if (char === "/" && next === "*") {
      const endIndex = skipBlockComment(sql, index);
      output += " ".repeat(endIndex - index);
      index = endIndex;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function skipQuoted(sql: string, startIndex: number, quote: string): number {
  let index = startIndex + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
}

function readDollarQuoteTag(sql: string, startIndex: number): string | undefined {
  if (sql[startIndex] !== "$") {
    return undefined;
  }
  const match = /^\$[a-z_][a-z0-9_]*\$|^\$\$/iu.exec(sql.slice(startIndex));
  return match?.[0];
}

function skipDollarQuoted(sql: string, startIndex: number, tag: string): number {
  const contentStart = startIndex + tag.length;
  const closeIndex = sql.indexOf(tag, contentStart);
  return closeIndex === -1 ? sql.length : closeIndex + tag.length;
}

function skipLineComment(sql: string, startIndex: number): number {
  const endIndex = sql.indexOf("\n", startIndex + 2);
  return endIndex === -1 ? sql.length : endIndex;
}

function skipBlockComment(sql: string, startIndex: number): number {
  const endIndex = sql.indexOf("*/", startIndex + 2);
  return endIndex === -1 ? sql.length : endIndex + 2;
}
