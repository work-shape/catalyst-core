import { afterEach, describe, it } from "vitest";
import {
  connectSampleMcpClient,
  createSampleMcpServer
} from "@work-shape/catalyst-demo/sample-mcp";
import { expectLargestLedgerPages, expectLedgerMonthEnds } from "./support/demo-accounting-volume";

const key = "test-only-sample-mcp-bearer-key-0001";
const closing: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
});
describe("accounting sample at full volume", () => {
  it("reads all 100000 bookings, preserving sorted order, exact rows and per-page bounds", async () => {
    const server = createSampleMcpServer({ key });
    closing.push(() => server.close());
    const { port } = await server.listen(0, "127.0.0.1");
    const client = await connectSampleMcpClient({
      url: `http://127.0.0.1:${port}/accounting/mcp`,
      key
    });
    closing.push(() => client.close());
    await expectLargestLedgerPages(client, true);
  }, 120_000);
  it("opens every month of every client with the exact count", () => {
    expectLedgerMonthEnds(true);
  });
});
