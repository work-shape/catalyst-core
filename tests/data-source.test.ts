import { describe, expect, it } from "vitest";
import type { DataSourceConfig } from "@vivd-catalyst/core";
import {
  assertReadOnlyQuery,
  createDataSourceRegistry,
  createEnvSecretResolver
} from "@vivd-catalyst/data-source";

describe("data source registry", () => {
  it("resolves env connection refs at registry creation", () => {
    expect(() =>
      createDataSourceRegistry({
        configs: {
          reporting: createDataSource()
        },
        secretResolver: createEnvSecretResolver({})
      })
    ).toThrow(/Missing data source connection secret 'REPORTING_DATABASE_URL'/u);
  });

  it("lists configured data sources without exposing connection secrets", () => {
    const registry = createDataSourceRegistry({
      configs: {
        reporting: createDataSource()
      },
      secretResolver: createEnvSecretResolver({
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
    expect(() => assertReadOnlyQuery("with orders as (select 1) select * from orders")).not.toThrow();
    expect(() => assertReadOnlyQuery("select '; delete is just text' as note")).not.toThrow();
    expect(() => assertReadOnlyQuery("select 1; -- trailing comment")).not.toThrow();
    expect(() => assertReadOnlyQuery("delete from reporting.orders")).toThrow(/read-only SELECT or WITH/u);
    expect(() => assertReadOnlyQuery("select 1; select 2")).toThrow(/single statement/u);
    expect(() =>
      assertReadOnlyQuery("with deleted as (delete from reporting.orders returning *) select * from deleted")
    ).toThrow(/write, DDL, transaction, or session-control/u);
    expect(() => assertReadOnlyQuery("select * from reporting.orders for update")).toThrow(/row locks/u);
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
