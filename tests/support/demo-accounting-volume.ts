import { expect } from "vitest";
import { MCP_CALL_TIMEOUT_MS, MCP_RESULT_MAX_BYTES } from "@work-shape/catalyst-connections";
import {
  ACCOUNTING_MAXIMUM_PAGE_SIZE,
  accountingOutputSchemas,
  type connectSampleMcpClient
} from "@work-shape/catalyst-demo/sample-mcp";
import { required } from "./assertions";
import { clientIdsOf, everyPosting, MONTH, sample, type Posting } from "./sample-accounting";

const PAGE_BYTES_SHARE = 0.75;
const PAGE_TIME_BOUND_MS = MCP_CALL_TIMEOUT_MS / 6;
type SampleClient = Awaited<ReturnType<typeof connectSampleMcpClient>>;
type ToolResult = Awaited<ReturnType<SampleClient["callTool"]>>;
function connectionBytes(result: ToolResult): number {
  return Buffer.byteLength(
    JSON.stringify({ content: result.content, structuredContent: result.structuredContent })
  );
}

export async function expectLargestLedgerPages(client: SampleClient, fullVolume = false) {
  const clientId = required(clientIdsOf("large")[0]);
  expect(sample.postingCount(clientId, MONTH)).toBe(100_000);
  const expected = fullVolume ? everyPosting(clientId, MONTH) : undefined;
  if (expected) {
    expect(expected).toHaveLength(100_000);
    expect(expected.map(({ date }) => date)).toEqual(expected.map(({ date }) => date).sort());
  }
  const rows: Posting[] = [];
  let largestBytes = 0;
  let slowestMs = 0;
  // The normal run samples the boundary pages; the scale run reads all hundred full pages.
  for (const page of fullVolume
    ? Array.from({ length: 101 }, (_, index) => index + 1)
    : [1, 50, 100, 101]) {
    const started = performance.now();
    const result = await client.callTool({
      name: "list_postings",
      arguments: {
        client_id: clientId,
        month: MONTH,
        page,
        page_size: ACCOUNTING_MAXIMUM_PAGE_SIZE
      }
    });
    slowestMs = Math.max(slowestMs, performance.now() - started);
    expect(result.isError).toBeUndefined();
    largestBytes = Math.max(largestBytes, connectionBytes(result));
    const read = accountingOutputSchemas.list_postings.parse(result.structuredContent).rows;
    expect(read).toHaveLength(page === 101 ? 0 : ACCOUNTING_MAXIMUM_PAGE_SIZE);
    rows.push(...read);
  }
  if (expected) expect(rows).toEqual(expected);
  expect(largestBytes).toBeGreaterThan(MCP_RESULT_MAX_BYTES / 2);
  expect(largestBytes).toBeLessThanOrEqual(PAGE_BYTES_SHARE * MCP_RESULT_MAX_BYTES);
  expect(slowestMs).toBeLessThan(PAGE_TIME_BOUND_MS);
}

export function expectLedgerMonthEnds(fullVolume = false) {
  for (const [index, { client_id }] of sample.clients.entries()) {
    // Every client in one month, and twenty spread across the client list in every month.
    const months = fullVolume || index % 30 === 0 ? sample.months : [MONTH];
    for (const month of months) {
      const count = sample.postingCount(client_id, month);
      expect(sample.postings(client_id, month, count - 1, 2)).toHaveLength(1);
    }
  }
}
