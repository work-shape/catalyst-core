import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import { withTestSql as withSql } from "./test-sql";
import { createTestInstanceWith } from "./test-instance";
import { createCallerAuthAdapter } from "./route-callers";

const clientInstanceId = asClientInstanceId("demo-local");
const createServer = () =>
  createTestInstanceWith(() => ({ authAdapter: createCallerAuthAdapter() }));

export function jobAdminQueryPlanTests(volume: 50_000 | 500_000) {
  describe("Instance > Jobs: the summary on a large queue", () => {
    const explainSchema = z.tuple([
      z.object({ "QUERY PLAN": z.tuple([z.object({ Plan: z.unknown() }).loose()]) })
    ]);
    const nodeSchema = z
      .object({
        "Node Type": z.string(),
        "Index Name": z.string().optional(),
        "Relation Name": z.string().optional(),
        "Shared Hit Blocks": z.number().default(0),
        "Shared Read Blocks": z.number().default(0),
        Plans: z.array(z.unknown()).default([])
      })
      .loose();
    type PlanNode = z.infer<typeof nodeSchema>;
    function nodesOf(plan: unknown): PlanNode[] {
      const node = nodeSchema.parse(plan);
      return [node, ...node.Plans.flatMap(nodesOf)];
    }

    it(`is answered from the claim index without reading the table of ${volume} jobs, and so is the list`, async () => {
      const server = await createServer();
      await withSql(async (sql) => {
        // Vacuum marks a page all-visible only once the commit of its rows is on disk. A test
        // server that commits asynchronously (synchronous_commit = off, as on the Mac mini) has
        // not written it yet when the vacuum below runs, so it would leave every page unmarked,
        // and the planner then counts from the table. The rows are committed synchronously here.
        await sql`set synchronous_commit = on`;
        // Mostly succeeded jobs, as after a week of work, over ten kinds.
        await sql`
        insert into platform_jobs (
          id, client_instance_id, kind, payload, status, run_after, attempts, max_attempts,
          correlation_id, created_at
        )
        select
          'job_' || n, ${clientInstanceId}, 'kind.number_' || (n % 10),
          '{"conversationId": "conv_0000000000000000", "userId": "usr_0000000000000000"}',
          case when n % 49 = 0 then (array['queued', 'running', 'failed', 'dead'])[1 + (n / 49) % 4]
               else 'succeeded' end,
          timestamptz '2024-01-01' + make_interval(secs => n), 1, 3, 'corr_' || n,
          timestamptz '2024-01-01' + make_interval(secs => n)
        from generate_series(1, ${volume}) n`;
        await sql`vacuum analyze platform_jobs`;
        // The queue the summary is built for: vacuumed, every page all-visible, so the index
        // answers alone. A plan from the table below then means the summary, not the arranging.
        const [table] = await sql<{ pages: number; visible: number }[]>`
        select relpages as pages, relallvisible as visible from pg_class
        where oid = 'platform_jobs'::regclass`;
        expect(table?.pages).toBeGreaterThan(12_000 * (volume / 500_000));
        expect(table?.visible).toBe(table?.pages);
      });

      const summary = await server.stores.jobs.summarizeByKind({ clientInstanceId });
      expect(summary).toHaveLength(10);
      expect(
        summary.reduce((sum, row) => sum + row.queued + row.running + row.failed + row.dead, 0)
      ).toBe(Math.floor(volume / 49));

      // The statement the store just ran, as the server recorded it, explained with its values.
      const nodes = await withSql(async (sql) => {
        const [ran] = await sql<{ query: string }[]>`
        select query from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and query like '%with recursive kinds%'`;
        // The server keeps the first 1,023 bytes of a statement by default. A longer summary
        // statement would be explained cut off, so its length is held here.
        expect(ran?.query.length).toBeLessThan(1000);
        const explained = await sql.unsafe(
          `explain (analyze, buffers, format json) ${ran?.query ?? ""}`,
          [
            clientInstanceId,
            clientInstanceId,
            ["queued", "running", "failed", "dead"],
            clientInstanceId
          ]
        );
        return nodesOf(explainSchema.parse(explained)[0]["QUERY PLAN"][0].Plan);
      });

      const scans = nodes.filter((node) => node["Relation Name"] === "platform_jobs");
      expect(new Set(scans.map((node) => `${node["Node Type"]} ${node["Index Name"]}`))).toEqual(
        new Set(["Index Only Scan platform_jobs_claim_idx"])
      );
      // The work is bounded by the jobs counted: at 500k rows a table read touches about
      // 12,500 pages and the whole index about 4,000. Scale the read ceilings with volume.
      const pages =
        (nodes[0]?.["Shared Hit Blocks"] ?? 0) + (nodes[0]?.["Shared Read Blocks"] ?? 0);
      // Ten kinds times four statuses have a fixed index-probe cost even at 50k rows.
      expect(pages).toBeLessThan(Math.max(250, SUMMARY_MAX_PAGES * (volume / 500_000)));

      // The list the page opens with: the first page of the failed and dead jobs.
      const listed = await server.stores.jobs.listOverview({
        clientInstanceId,
        filters: { statuses: ["failed", "dead"] },
        page: { limit: 51 }
      });
      expect(listed).toHaveLength(51);
      expect(listed.every((job) => job.status === "failed" || job.status === "dead")).toBe(true);
      expect(listed[0]?.id).toBe(volume === 500_000 ? "job_499947" : "job_49931");
      const listNodes = await withSql(async (sql) => {
        const [ran] = await sql<{ query: string }[]>`
        select query from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and query like '%with recursive k as%'`;
        expect(ran?.query.length).toBeLessThan(1000);
        const explained = await sql.unsafe(
          `explain (analyze, buffers, format json) ${ran?.query ?? ""}`,
          [clientInstanceId, clientInstanceId, clientInstanceId, "failed", "dead", 51]
        );
        return nodesOf(explainSchema.parse(explained)[0]["QUERY PLAN"][0].Plan);
      });
      // Every read of the table goes through the claim index, by kind and status. What it
      // finds is sorted, so the pages read grow with the failed and dead jobs and stay
      // below the page ceiling even at the nightly volume.
      const listScans = listNodes.filter(
        (node) => node["Relation Name"] === "platform_jobs" || node["Index Name"] !== undefined
      );
      expect(listScans.map((node) => node["Node Type"])).not.toContain("Seq Scan");
      expect(new Set(listScans.flatMap((node) => node["Index Name"] ?? []))).toEqual(
        new Set(["platform_jobs_claim_idx"])
      );
      const listPages =
        (listNodes[0]?.["Shared Hit Blocks"] ?? 0) + (listNodes[0]?.["Shared Read Blocks"] ?? 0);
      expect(listPages).toBeLessThan(LIST_MAX_PAGES * (volume / 500_000));
    }, 120_000);
  });
}

/** Counting 10,204 of 500,000 jobs through the index touches about 300 pages. */
const SUMMARY_MAX_PAGES = 1_000;
/** Reading 5,102 of 500,000 jobs through the index touches about 5,000 pages. */
const LIST_MAX_PAGES = 8_000;
