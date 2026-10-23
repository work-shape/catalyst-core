import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  accountingOutputSchemas,
  connectSampleMcpClient,
  createAccountingSample,
  createSampleMcpServer
} from "@work-shape/catalyst-demo/sample-mcp";
import { accountingRestPaths as paths } from "./support/accounting-rest";
import { referenceFindings } from "./support/sample-accounting";

const KEY = "test-only-accounting-rest-bearer-key";
const REQUEST_TIMEOUT_MS = 10_000;
const MONTH = "2026-09";
const clientsSchema = accountingOutputSchemas.list_accounting_clients.shape.rows;
const postingsSchema = accountingOutputSchemas.list_postings.shape.rows;
const closing: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const close of closing.splice(0).reverse()) await close();
});

async function start(options: Parameters<typeof createSampleMcpServer>[0]["accountingRest"] = {}) {
  const log: string[] = [];
  const server = createSampleMcpServer({
    key: KEY,
    accountingRest: options,
    log: (line) => log.push(line)
  });
  closing.push(() => server.close());
  const { port } = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/rest${path}`, {
      headers: { Authorization: `Bearer ${KEY}`, "x-client-instance-id": "demo-local", ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  return { base, get, log };
}

function monthQuery(clientId: number, page = 1, pageSize = 1000) {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  query.append("filter", `client_id eq ${clientId}`);
  query.append("filter", "date gte 2026-09-01");
  query.append("filter", "date lt 2026-10-01");
  return `${paths.postings}?${query}`;
}

describe("the accounting REST face", () => {
  it("pages all 600 clients both ways through a short final page, with top-level arrays", async () => {
    const { get } = await start();
    const enterprise: z.infer<typeof clientsSchema> = [];
    const gateway: {
      id: string;
      number: number;
      name: string;
      status: string;
      organization_number: number;
    }[] = [];
    for (let page = 1; page <= 5; page++) {
      const response = await get(`${paths.clients}?page=${page}&page_size=137`);
      expect(response.status).toBe(200);
      const rows = clientsSchema.parse(await response.json());
      enterprise.push(...rows);
      if (rows.length < 137) break;
    }
    for (let skip = 0; skip < 700; skip += 137) {
      const response = await get(`/datevconnect/master-data/v1/clients?top=137&skip=${skip}`);
      const rows = z
        .array(
          z.strictObject({
            id: z.string(),
            number: z.number(),
            name: z.string(),
            status: z.string(),
            organization_number: z.number()
          })
        )
        .parse(await response.json());
      gateway.push(...rows);
      if (rows.length < 137) break;
    }
    expect(enterprise).toHaveLength(600);
    expect(gateway.map((row) => Number(row.id))).toEqual(enterprise.map((row) => row.client_id));
    expect(gateway[0]).toEqual({
      id: String(enterprise[0]?.client_id),
      number: enterprise[0]?.client_number,
      name: enterprise[0]?.name,
      status: "active",
      organization_number: 2906417
    });
    expect(await (await get(`${paths.clients}?page=7&page_size=100`)).json()).toEqual([]);
  });

  it("matches MCP for a small ledger; the large ledger first and empty pages stay under 1 MiB", async () => {
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
    for (const id of [z.number().parse(small?.client_id)]) {
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
    for (const page of [1, 101]) {
      const response = await get(monthQuery(z.number().parse(large?.client_id), page));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(Buffer.byteLength(text)).toBeLessThan(1024 * 1024);
      expect(postingsSchema.parse(JSON.parse(text))).toHaveLength(page === 1 ? 1000 : 0);
    }
  });

  it("reads fiscal years and pages Gateway postings across months in that fiscal year", async () => {
    const { get } = await start();
    const sample = createAccountingSample();
    const id = 1001;
    const years = sample.fiscalYears(id);
    expect(await (await get(paths.fiscalYears(id))).json()).toEqual(years);
    expect(
      await (await get(`/datevconnect/accounting/v1/clients/${id}/fiscal-years`)).json()
    ).toEqual(years.map((year) => ({ ...year, id: String(year.fiscal_year) })));
    const year = z.number().parse(years.at(-1)?.fiscal_year);
    const expected = sample.months
      .flatMap((month) => sample.postings(id, month, 0, sample.postingCount(id, month)))
      .filter((row) => row.fiscal_year === String(year));
    const path = `/datevconnect/accounting/v1/clients/${id}/fiscal-years/${year}/account-postings`;
    const rows = postingsSchema.parse(await (await get(`${path}?top=17&skip=11`)).json());
    expect(rows).toEqual(expected.slice(11, 28));
    const query = new URLSearchParams({ filter: `client_id eq ${id}`, page_size: "17" });
    query.append("filter", `fiscal_year eq ${year}`);
    expect(await (await get(`${paths.postings}?${query}`)).json()).toEqual(expected.slice(0, 17));
  });

  it("continues a page that starts mid-month into the next ledger month", async () => {
    const { get } = await start();
    const sample = createAccountingSample();
    const id = 1001;
    const year = z.number().parse(sample.fiscalYears(id).at(-1)?.fiscal_year);
    // By ledger month, not booking date: planted wrong-date bookings stay in their month.
    const months = sample.months
      .map((month) => sample.postings(id, month, 0, sample.postingCount(id, month)))
      .filter((rows) => rows[0]?.fiscal_year === String(year));
    const expected = months.flat();
    const boundary = months[0]?.length ?? 0;
    expect(months.length).toBeGreaterThan(1);
    expect(boundary).toBeGreaterThan(5);
    const path = `/datevconnect/accounting/v1/clients/${id}/fiscal-years/${year}/account-postings`;
    const gateway = postingsSchema.parse(
      await (await get(`${path}?top=20&skip=${boundary - 5}`)).json()
    );
    expect(gateway).toEqual(expected.slice(boundary - 5, boundary + 15));
    const pageSize = 20;
    const page = Math.floor(boundary / pageSize) + 1;
    expect(boundary % pageSize).not.toBe(0);
    const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    query.append("filter", `client_id eq ${id}`);
    query.append("filter", `fiscal_year eq ${year}`);
    expect(await (await get(`${paths.postings}?${query}`)).json()).toEqual(
      expected.slice((page - 1) * pageSize, page * pageSize)
    );
  });

  it("requires the key and instance, scopes both shapes before paging and refuses unknown profiles", async () => {
    const { get, log } = await start();
    const refused = await get(paths.clients, { Authorization: "Bearer wrong" });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      message: "Authentication failed",
      error: "Unauthorized",
      statusCode: 401
    });
    expect((await get(paths.clients, { "x-client-instance-id": "" })).status).toBe(400);
    expect((await get(paths.clients, { "x-profile-id": "other" })).status).toBe(403);
    for (const [profile, first, last] of [
      ["team-a", 1001, 1300],
      ["team-b", 1301, 1600]
    ] as const) {
      const rows = clientsSchema.parse(
        await (await get(`${paths.clients}?page_size=1000`, { "x-profile-id": profile })).json()
      );
      expect(rows).toHaveLength(300);
      expect([rows[0]?.client_id, rows.at(-1)?.client_id]).toEqual([first, last]);
      expect(
        (
          await get(paths.fiscalYears(profile === "team-a" ? 1301 : 1001), {
            "x-profile-id": profile
          })
        ).status
      ).toBe(404);
      const gateway = await get("/datevconnect/master-data/v1/clients?top=1000", {
        "x-profile-id": profile
      });
      expect(
        z
          .array(z.object({ id: z.string() }))
          .parse(await gateway.json())
          .map((row) => Number(row.id))
      ).toEqual(rows.map((row) => row.client_id));
    }
    expect(await (await get(monthQuery(1402), { "x-profile-id": "team-a" })).json()).toEqual([]);
    expect(log.every((line) => /^REST \d{3}$/u.test(line))).toBe(true);
  });

  it.each([
    "page=0",
    "page=-1",
    "page=1.5",
    "page=9007199254740991",
    "page_size=1001",
    "page_size=0",
    "page=1&page=2",
    "filter=date+gte+2026-99-01",
    "filter=client_id+eq+oops",
    "filter=account_number+eq+1",
    "unknown=1"
  ])("refuses malformed or unsupported input: %s", async (query) => {
    const { get } = await start();
    expect((await get(`${paths.postings}?${query}`)).status).toBe(400);
  });

  it("injects Retry-After in one shared call window, recovers and keeps health independent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { get } = await start({ rateLimitAfter: 1, rateWindowMs: 2000 });
    expect((await get(paths.clients)).status).toBe(200);
    const refused = await get("/datevconnect/master-data/v1/clients");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("2");
    const health = await get(paths.health);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual([{ status: "online", service: "datev-connect" }]);
    vi.setSystemTime(Date.now() + 2001);
    expect((await get(paths.clients)).status).toBe(200);
  });

  it("can fail all reads or a single client's reads without failing health or the client list", async () => {
    const scoped = await start({ unavailableClientId: 1001 });
    expect((await scoped.get(paths.clients)).status).toBe(200);
    const failed = await scoped.get(monthQuery(1001));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "connector_unavailable" });
    expect((await scoped.get(monthQuery(1002))).status).toBe(200);
    const all = await start({ unavailable: true });
    expect((await all.get(paths.clients)).status).toBe(503);
    expect((await all.get(paths.health)).status).toBe(200);
  });

  it("scales the shared generator, keeping one large client at full volume and the planted findings truthful", async () => {
    const full = createAccountingSample();
    const scaled = createAccountingSample({ scaleDivisor: 100 });
    expect(scaled.clients).toEqual(full.clients);
    expect(
      scaled.clients.filter((client) => scaled.postingCount(client.client_id, MONTH) === 100_000)
    ).toHaveLength(1);
    const total = scaled.clients.reduce(
      (sum, client) => sum + scaled.postingCount(client.client_id, MONTH),
      0
    );
    expect(total).toBeLessThan(200_000);
    const { get, base } = await start({ scaleDivisor: 100 });
    const mcp = await connectSampleMcpClient({ url: `${base}/accounting/mcp`, key: KEY });
    closing.push(() => mcp.close());
    const id = z
      .number()
      .parse(
        full.clients.find(
          (client) =>
            full.postingCount(client.client_id, MONTH) > 1000 &&
            scaled.postingCount(client.client_id, MONTH) < 1000
        )?.client_id
      );
    const result = await mcp.callTool({
      name: "list_postings",
      arguments: { client_id: id, month: MONTH, page_size: 1000 }
    });
    expect(await (await get(monthQuery(id))).json()).toEqual(
      accountingOutputSchemas.list_postings.parse(result.structuredContent).rows
    );
    expect(scaled.postings(id, MONTH, 0, 1000)).toHaveLength(scaled.postingCount(id, MONTH));
    for (const { client_id } of scaled.clients) {
      const chart = new Map(
        scaled.accounts(client_id).map((account) => [account.account_number, account])
      );
      const rows = scaled.postings(client_id, MONTH, 0, scaled.postingCount(client_id, MONTH));
      const findings = referenceFindings(rows, chart, MONTH);
      expect(
        Object.fromEntries(
          Object.entries(findings).map(([rule, positions]) => [rule, positions.length])
        ),
        `scaled client ${client_id}`
      ).toEqual(scaled.expectedFindings(client_id, MONTH));
    }
  });

  it("delays reads and honors a disconnected caller", async () => {
    const { base } = await start({ latencyMs: 1000 });
    await expect(
      fetch(`${base}/rest${paths.clients}`, {
        headers: { Authorization: `Bearer ${KEY}`, "x-client-instance-id": "demo-local" },
        signal: AbortSignal.timeout(50)
      })
    ).rejects.toThrow();
  });

  it("refuses invalid knobs instead of silently changing the rehearsal", () => {
    expect(() =>
      createSampleMcpServer({ key: KEY, accountingRest: { scaleDivisor: 0 } })
    ).toThrow();
    expect(() => createSampleMcpServer({ key: KEY, accountingRest: { latencyMs: -1 } })).toThrow();
    expect(() =>
      createSampleMcpServer({ key: KEY, accountingRest: { unavailable: "false" } })
    ).not.toThrow();
  });
});
