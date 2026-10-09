import { describe, expect, it } from "vitest";
import type { DataSourceConfig } from "@vivd-catalyst/core";
import {
  assertReadOnlyQuery,
  createDataSourceRegistry,
  createDataSourceTools
} from "@vivd-catalyst/data-source";
import { createFakeSecrets } from "./support/fixtures";

describe("data source registry", () => {
  it("resolves env connection refs at registry creation", async () => {
    await expect(
      createDataSourceRegistry({
        configs: {
          reporting: createDataSource()
        },
        secrets: createFakeSecrets()
      })
    ).rejects.toThrow(
      "'dataSources.reporting.connectionRef' names the secret 'REPORTING_DATABASE_URL', which does not resolve"
    );
  });

  it("refuses a connection ref that is not the name of a secret", async () => {
    const connectionString = "postgres://readonly:hunter2@example.test/reporting";
    const refused = createDataSourceRegistry({
      configs: {
        reporting: { ...createDataSource(), connectionRef: connectionString }
      },
      secrets: createFakeSecrets()
    });
    await expect(refused).rejects.toThrow(
      "'dataSources.reporting.connectionRef' must be 'env:' followed by the name of a secret"
    );
    await expect(refused).rejects.not.toThrow(/hunter2/u);
  });

  it("lists configured data sources without exposing connection secrets", async () => {
    const registry = await createDataSourceRegistry({
      configs: {
        reporting: createDataSource()
      },
      secrets: createFakeSecrets({
        REPORTING_DATABASE_URL: "postgres://readonly@example.test/reporting"
      })
    });

    expect(registry.list()).toEqual([
      {
        name: "reporting",
        config: createDataSource()
      }
    ]);
  });

  it("rejects non-read-only and multi-statement SQL", () => {
    expect(() => assertReadOnlyQuery("select * from reporting.orders")).not.toThrow();
    expect(() =>
      assertReadOnlyQuery("with orders as (select 1) select * from orders")
    ).not.toThrow();
    expect(() => assertReadOnlyQuery("select '; delete is just text' as note")).not.toThrow();
    expect(() => assertReadOnlyQuery("select 1; -- trailing comment")).not.toThrow();
    expect(() => assertReadOnlyQuery("delete from reporting.orders")).toThrow(
      /read-only SELECT or WITH/u
    );
    expect(() => assertReadOnlyQuery("select 1; select 2")).toThrow(/single statement/u);
    expect(() =>
      assertReadOnlyQuery(
        "with deleted as (delete from reporting.orders returning *) select * from deleted"
      )
    ).toThrow(/write, DDL, transaction, or session-control/u);
    expect(() => assertReadOnlyQuery("select * from reporting.orders for update")).toThrow(
      /row locks/u
    );
  });

  it("creates model-visible query and schema-description tools together", async () => {
    const config = createDataSource();
    config.tools = {
      query: {
        enabled: true
      }
    };
    const tools = createDataSourceTools({
      dataSources: {
        list: () => [{ name: "reporting", config }],
        get: () => ({ name: "reporting", config }),
        async query() {
          return { rows: [{ order_count: 12 }], truncated: false };
        },
        async describe(input) {
          expect(input).toEqual({ sourceName: "reporting", relation: "orders" });
          return {
            relations: [{ schema: "reporting", name: "orders", type: "table" }],
            relation: {
              schema: "reporting",
              name: "orders",
              type: "table",
              columns: [{ name: "id", dataType: "integer", nullable: false }],
              primaryKey: ["id"],
              foreignKeys: []
            },
            truncated: false
          };
        }
      }
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "data.reporting.query",
      "data.reporting.describe"
    ]);
    expect(tools[0]?.description).toContain("Use data.reporting.describe first");
    await expect(tools[1]?.execute({ relation: "orders" }, {} as never)).resolves.toMatchObject({
      status: "success",
      output: {
        relation: {
          primaryKey: ["id"]
        }
      }
    });
  });
});

function createDataSource(): DataSourceConfig {
  return {
    kind: "postgres",
    connectionRef: "env:REPORTING_DATABASE_URL",
    description: "reporting warehouse",
    sql: {
      dialect: "postgres",
      access: "read_only",
      statementTimeoutMs: 10000,
      maxRows: 5000,
      allowedSchemas: ["reporting"],
      schemaDescription: "Reporting views for aggregate workflow state."
    },
    tools: {
      renderView: {
        enabled: true,
        name: "data.reporting.render_view",
        modelVisibleOutput: "zero_data_ack"
      }
    }
  };
}
