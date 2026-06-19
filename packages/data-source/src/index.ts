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

export interface DataSourceRegistry {
  list(): DataSourceRegistration[];
  get(sourceName: string): DataSourceRegistration | undefined;
  query(input: DataSourceQueryInput): Promise<DataSourceQueryResult>;
}

export interface SecretResolver {
  resolveConnectionRef(ref: string): string;
}

export interface CreateDataSourceRegistryInput {
  configs: Record<string, DataSourceConfig>;
  secretResolver: SecretResolver;
}

export interface CreateDataSourceQueryToolsInput {
  dataSources: DataSourceRegistry;
}

interface RegisteredDataSource extends DataSourceRegistration {
  adapter: DataSourceAdapter;
}

interface DataSourceAdapter {
  query(query: string): Promise<DataSourceQueryResult>;
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
        throw new AppError("VALIDATION_FAILED", `Missing data source connection secret '${envName}'`);
      }
      return value;
    }
  };
}

export function createDataSourceQueryTools(input: CreateDataSourceQueryToolsInput): AnyToolDefinition[] {
  const dataSources = input.dataSources;
  return dataSources.list().flatMap(({ name, config }) => {
    const queryTool = config.tools?.query;
    if (!queryTool?.enabled) {
      return [];
    }
    const toolName = queryTool.name ?? `data.${name}.query`;
    return [
      defineTool({
        name: toolName,
        description: [
          `Run a read-only query against ${config.description}.`,
          config.sql.allowedSchemas.length > 0
            ? `Unqualified table names resolve through these configured schemas: ${config.sql.allowedSchemas.join(", ")}.`
            : "",
          config.sql.schemaDescription ? `Allowed query surface: ${config.sql.schemaDescription}` : ""
        ]
          .filter(Boolean)
          .join(" "),
        inputSchema: z.object({
          query: z.string().min(1).max(20000)
        }),
        outputSchema: z.object({
          rows: z.array(z.record(z.string(), z.unknown())),
          truncated: z.boolean()
        }),
        inputJsonSchema: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: 20000,
              description: "Read-only SQL query for the configured data source."
            }
          }
        },
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
      })
    ];
  });
}

export function assertReadOnlyQuery(query: string): void {
  const normalized = query.trim().replace(/;+$/u, "").trim();
  if (!/^(select|with)\b/iu.test(normalized)) {
    throw new AppError("VALIDATION_FAILED", "Data source queries must be read-only SELECT or WITH statements");
  }
  if (/;\s*\S/u.test(normalized)) {
    throw new AppError("VALIDATION_FAILED", "Data source queries must contain a single statement");
  }
}

class DefaultDataSourceRegistry implements DataSourceRegistry {
  private readonly registrations: Map<string, RegisteredDataSource>;

  constructor(registrations: RegisteredDataSource[]) {
    this.registrations = new Map(registrations.map((registration) => [registration.name, registration]));
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
      await sql`set statement_timeout = ${this.config.sql.statementTimeoutMs}`;
      if (this.allowedSearchPath) {
        // Schema allow lists guide unqualified lookup. Hard isolation belongs to
        // the read-only database role and grants behind the connectionRef.
        await sql.unsafe(`set search_path to ${this.allowedSearchPath}`);
      }
      const rows = await sql.unsafe(query);
      const limitedRows = rows.slice(0, this.config.sql.maxRows);
      return {
        rows: limitedRows.map((row) => ({ ...row })),
        truncated: rows.length > limitedRows.length
      };
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
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
