import { describe, expect, it } from "vitest";
import { manifest, refusal, useDataStoreWorld } from "./support/data-store-world";

describe("timeouts after an unscoped replacement gets its table lock", () => {
  const { published, call, connect } = useDataStoreWorld("data_store_load_timeouts");

  it.each(["group", "later-chunk row"] as const)("keeps a %s wait as TIMEOUT", async (phase) => {
    const held = { month: "2026-10", id: 2_000, note: "stored" };
    const first = Array.from({ length: 1_100 }, (_, id) => ({
      month: "2026-09",
      id,
      note: "new"
    }));
    let reachedLaterPart = false;
    const world = await published(
      "after-table-lock",
      [
        manifest(),
        {
          path: "migrations/0001_init.sql",
          text: `create table month_findings (
              month text not null, id integer not null, note text,
              primary key (month, id)
            );`
        }
      ],
      {
        async *read(reference) {
          if (reference.$dataset === "ds_stored") {
            yield [held];
          } else {
            // More than 1,000 rows flushes a full statement before the later part.
            yield first;
            reachedLaterPart = true;
            yield [held];
          }
        }
      },
      undefined,
      { load: { rows: 100_000, bytes: 64 * 1024 ** 2, timeoutMs: 2_000 } }
    );
    const storedBytes = Buffer.byteLength(JSON.stringify([held]));
    await call(world, "load", {
      table: "month_findings",
      dataset: { $dataset: "ds_stored", rowCount: 1, bytes: storedBytes }
    });
    const holder = await connect(world.record.location.database).reserve();
    try {
      await holder`begin`;
      // Neither holder takes the replacement table lock: the load acquires it first.
      if (phase === "group") {
        await holder`select pg_advisory_xact_lock(hashtextextended('month_findings ' || row('2026-09'::text)::text, 0))`;
      } else {
        await holder`select * from month_findings where month = '2026-10' for update`;
      }
      expect(
        await refusal(
          call(world, "load", {
            table: "month_findings",
            dataset: {
              $dataset: "ds_wait",
              rowCount: first.length + 1,
              bytes: Buffer.byteLength(JSON.stringify(first)) + storedBytes
            },
            key: ["month", "id"],
            replace: { by: ["month"] }
          })
        )
      ).toMatchObject({ code: "TIMEOUT", details: { sqlState: "57014" } });
      expect(reachedLaterPart).toBe(phase === "later-chunk row");
    } finally {
      await holder`rollback`;
      holder.release();
    }
    // A later-chunk timeout rolls back the earlier successful statement too.
    expect(
      await call(world, "query", { sql: "select month, id, note from month_findings" })
    ).toMatchObject({ rows: [held] });
  });
});
