import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type DataSourceConfig,
  type Logger,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import { createDataSourceRegistry, createDataSourceTools } from "@vivd-catalyst/data-source";
import { InProcessToolExecution, ToolRegistry } from "@vivd-catalyst/tool-execution";
import { usePostgresSuite } from "./support/postgres-suite";

describe("data source query feedback on Postgres", () => {
  const suite = usePostgresSuite("query_feedback");

  it("tells the model which column its query got wrong", async () => {
    const result = await runQuery(suite.databaseUrl, "select missing_column from pg_class");

    expect(result.result).toEqual({
      status: "failed",
      error: {
        code: "handler_failed",
        message:
          'Query failed: column "missing_column" does not exist (at character 8 of the query)',
        details: undefined
      }
    });
    expect(result.logged).toEqual([]);
  });

  it("names a data exception and a timeout", async () => {
    const division = await runQuery(suite.databaseUrl, "select 1 / 0");
    expect(division.result).toMatchObject({
      error: { code: "handler_failed", message: "Query failed: division by zero" }
    });

    const timeout = await runQuery(suite.databaseUrl, "select pg_sleep(2)", 100);
    expect(timeout.result).toMatchObject({
      error: {
        code: "handler_failed",
        message: "Query was cancelled: canceling statement due to statement timeout"
      }
    });
  });

  it("keeps a connection failure generic and its address out of the result", async () => {
    const unreachable = new URL(suite.databaseUrl);
    unreachable.port = "1";
    unreachable.password = "PRIVATE_CONNECTION_SECRET";

    const result = await runQuery(unreachable.toString(), "select 1");

    expect(result.result).toEqual({
      status: "failed",
      error: {
        code: "handler_failed",
        message: "The tool failed with an internal error. Reference: corr_query_feedback",
        details: { correlationId: "corr_query_feedback" }
      }
    });
    expect(result.logged).toHaveLength(1);
    const serialized = JSON.stringify([result.result, result.logged]);
    for (const leaked of ["PRIVATE_CONNECTION_SECRET", "ECONNREFUSED", unreachable.host]) {
      expect(serialized).not.toContain(leaked);
    }
  });
});

async function runQuery(databaseUrl: string, query: string, statementTimeoutMs = 5000) {
  const config: DataSourceConfig = {
    kind: "postgres",
    connectionRef: "env:REPORTING_DATABASE_URL",
    description: "reporting warehouse",
    sql: {
      dialect: "postgres",
      access: "read_only",
      statementTimeoutMs,
      maxRows: 10,
      allowedSchemas: []
    },
    tools: { query: { enabled: true } }
  };
  const tools = createDataSourceTools({
    dataSources: await createDataSourceRegistry({
      configs: { reporting: config },
      secrets: { resolve: async () => databaseUrl }
    })
  });
  const logged: unknown[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error(input) {
      logged.push(input);
    },
    child() {
      return logger;
    }
  };
  const execution = new InProcessToolExecution({
    registry: new ToolRegistry({ tools }),
    getAgentToolNames: () => tools.map((tool) => tool.name),
    logger
  });
  const clientInstanceId = asClientInstanceId("query_feedback");
  const context: ToolExecutionContext = {
    clientInstanceId,
    correlationId: "corr_query_feedback",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
  const result = await execution.execute(
    {
      toolName: "data.reporting.query",
      toolCallId: asToolCallId("toolcall_query_feedback"),
      agentRunId: asAgentRunId("run_query_feedback"),
      conversationId: asConversationId("conv_query_feedback"),
      agentName: "reporting_agent",
      input: { query },
      authorization: { status: "allowed" }
    },
    context
  );
  return { result, logged };
}
