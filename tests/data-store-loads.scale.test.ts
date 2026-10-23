import { describe, expect, it } from "vitest";
import { manifest, useDataStoreWorld } from "./support/data-store-world";

// The production 100,000-row bound remains a nightly volume proof.
describe("a Data Store load at the production row bound", () => {
  const { published, call } = useDataStoreWorld("data_store_load_bound_scale");
  it("takes the whole 100000-row bound in one call", async () => {
    const parts = Array.from({ length: 100 }, (_, part) =>
      Array.from({ length: 1_000 }, (_, row) => ({
        month: "2026-09",
        client_id: `client-${part * 1_000 + row}`,
        rule_id: "vat-rate",
        amount: 119.5
      }))
    );
    const world = await published(
      "whole",
      [
        manifest(),
        {
          path: "migrations/0001_month_findings.sql",
          text: `create table month_findings (
        month text not null, client_id text not null, rule_id text not null,
        severity text not null default 'warning', amount numeric(14, 2), note text,
        primary key (month, client_id, rule_id)
      );`
        }
      ],
      {
        async *read() {
          for (const part of parts) yield part;
        }
      }
    );
    expect(
      await call(world, "load", {
        table: "month_findings",
        dataset: {
          $dataset: "ds_whole",
          rowCount: 100_000,
          bytes: JSON.stringify(parts.flat()).length
        }
      })
    ).toMatchObject({ inserted: 100_000 });
    expect(
      await call(world, "query", {
        sql: "select count(*)::integer as count from month_findings"
      })
    ).toMatchObject({ rows: [{ count: 100_000 }] });
  });
});
