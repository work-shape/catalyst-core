import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  accountingOutputSchemas,
  connectSampleMcpClient,
  createAccountingSample,
  createSampleMcpServer
} from "@work-shape/catalyst-demo/sample-mcp";
import { accountingRestPaths as paths } from "./support/accounting-rest";
const KEY = "test-only-accounting-rest-bearer-key";
const MONTH = "2026-09";
const postingsSchema = accountingOutputSchemas.list_postings.shape.rows;
const closing: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});
async function start() {
  const server = createSampleMcpServer({ key: KEY });
  closing.push(() => server.close());
  const { port } = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const get = (path: string) =>
    fetch(`${base}/rest${path}`, {
      headers: { Authorization: `Bearer ${KEY}`, "x-client-instance-id": "demo-local" },
      signal: AbortSignal.timeout(10000)
    });
  return { base, get };
}
function monthQuery(clientId: number, page = 1, pageSize = 1000) {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  query.append("filter", `client_id eq ${clientId}`);
  query.append("filter", "date gte 2026-09-01");
  query.append("filter", "date lt 2026-10-01");
  return `${paths.postings}?${query}`;
}
describe("accounting REST at full volume", () => {
  it("matches MCP for a small and a full 100,000-row ledger month, including wrong-date anomalies; every page stays under 1 MiB", async () => {
    const { get, base } = await start();
    const mcp = await connectSampleMcpClient({ url: `${base}/accounting/mcp`, key: KEY });
    closing.push(() => mcp.close());
    const sample = createAccountingSample();
    const large = sample.clients.find(
      (client) => sample.postingCount(client.client_id, MONTH) === 100_000
    );
    expect(large).toBeDefined();
    const small = sample.clients.find(
      (client) => sample.postingCount(client.client_id, MONTH) <= 250
    );
    for (const id of [z.number().parse(small?.client_id), z.number().parse(large?.client_id)]) {
      let count = 0;
      for (let page = 1; page <= 101; page++) {
        const response = await get(monthQuery(id, page));
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(Buffer.byteLength(text)).toBeLessThan(1024 * 1024);
        const rows = postingsSchema.parse(JSON.parse(text));
        const result = await mcp.callTool({
          name: "list_postings",
          arguments: { client_id: id, month: MONTH, page, page_size: 1000 }
        });
        expect(result.isError).toBeUndefined();
        expect(rows).toEqual(
          accountingOutputSchemas.list_postings.parse(result.structuredContent).rows
        );
        count += rows.length;
        if (rows.length < 1000) break;
      }
      expect(count).toBe(sample.postingCount(id, MONTH));
    }
  });
});
