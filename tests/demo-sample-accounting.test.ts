import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  loadClientInstanceConfigFromFile,
  releaseConnectionConfigSchema
} from "@work-shape/catalyst-config-schema";
import {
  compileJsonSchema,
  MCP_CALL_TIMEOUT_MS,
  MCP_RESULT_MAX_BYTES
} from "@work-shape/catalyst-connections";
import { isJsonObject, unknownToJsonValue } from "@work-shape/catalyst-core";
import {
  ACCOUNTING_DEFAULT_PAGE_SIZE,
  ACCOUNTING_MAXIMUM_PAGE_SIZE,
  accountingOutputSchemas,
  createAccountingSample,
  connectSampleMcpClient,
  createSampleMcpServer,
  SIZE_GROUPS
} from "@work-shape/catalyst-demo/sample-mcp";
import { required } from "./support/assertions";
import {
  clientIdsOf,
  everyPosting,
  isCreditor,
  isDebtor,
  MONTH,
  MONTHS,
  sample,
  sizeGroupOf,
  type Account,
  type Posting
} from "./support/sample-accounting";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const key = "test-only-sample-mcp-bearer-key-0001";
const CONNECTION = "sample-accounting";
/** The share of a Connection's result bound the largest page may fill. */
const PAGE_BYTES_SHARE = 0.75;
/** Wide, because one green run proves no timing: the largest page takes well under a second. */
const PAGE_TIME_BOUND_MS = MCP_CALL_TIMEOUT_MS / 6;

type SampleClient = Awaited<ReturnType<typeof connectSampleMcpClient>>;
type ToolName = keyof typeof accountingOutputSchemas;
type ToolResult = Awaited<ReturnType<SampleClient["callTool"]>>;

const servers: ReturnType<typeof createSampleMcpServer>[] = [];
const clients: SampleClient[] = [];

async function start(
  options: {
    accountingSeed?: number;
    accountingLastMonth?: string;
    log?: (line: string) => void;
  } = {}
) {
  const server = createSampleMcpServer({ key, ...options });
  servers.push(server);
  const { port } = await server.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${port}/accounting/mcp`;
  const client = await connectSampleMcpClient({ url, key });
  clients.push(client);
  return { client, url };
}

async function rowsOf<S extends z.ZodType<{ rows: unknown[] }>>(
  client: SampleClient,
  name: ToolName,
  schema: S,
  args: Record<string, unknown> = {}
): Promise<z.output<S>["rows"]> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBeUndefined();
  expect(result.content).toEqual([
    { type: "text", text: JSON.stringify(result.structuredContent) }
  ]);
  return schema.parse(result.structuredContent).rows;
}

/** Reads a tool as a caller without a total must: page after page until one is short or empty. */
async function readToEnd<S extends z.ZodType<{ rows: unknown[] }>>(
  client: SampleClient,
  name: ToolName,
  schema: S,
  args: Record<string, unknown>,
  pageSize: number
): Promise<{ rows: z.output<S>["rows"]; pages: number }> {
  const rows: z.output<S>["rows"] = [];
  for (let page = 1; ; page += 1) {
    const read = await rowsOf(client, name, schema, { ...args, page, page_size: pageSize });
    expect(read.length).toBeLessThanOrEqual(pageSize);
    rows.push(...read);
    if (read.length < pageSize) return { rows, pages: page };
  }
}

/** The bytes of a result as a call of an MCP Connection counts them: content and structured content. */
function connectionBytes(result: ToolResult): number {
  return Buffer.byteLength(
    JSON.stringify({ content: result.content, structuredContent: result.structuredContent })
  );
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("demo sample accounting", () => {
  it("advertises the four reading tools, and the Connection accepts exactly those for a Workflow", async () => {
    const { client } = await start();
    const { tools } = await client.listTools();
    const names = Object.keys(accountingOutputSchemas).sort();
    expect(names).toEqual([
      "list_accounting_clients",
      "list_accounts",
      "list_fiscal_years",
      "list_postings"
    ]);
    expect(tools.map(({ name }) => name).sort()).toEqual(names);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.additionalProperties).toBe(false);
      const name = z
        .enum(["list_accounting_clients", "list_accounts", "list_fiscal_years", "list_postings"])
        .parse(tool.name);
      expect(tool.outputSchema).toEqual(
        z.toJSONSchema(accountingOutputSchemas[name], { target: "draft-7" })
      );
    }

    const config = await loadClientInstanceConfigFromFile(
      resolve(root, "clients/demo/config/app.yaml")
    );
    const connection = releaseConnectionConfigSchema.parse(config.connections[CONNECTION]);
    expect(connection).toMatchObject({
      connectorType: "mcp",
      displayName: "Sample accounting",
      authScheme: "bearer",
      secret: "DEMO_SAMPLE_MCP_KEY",
      settings: { url: "http://sample-mcp:8787/accounting/mcp" }
    });
    expect(connection.operations.map(({ name }) => name).sort()).toEqual(names);
    // No booking passes through a model: a Workflow may call, an agent and a Page may not.
    for (const operation of connection.operations) {
      expect(operation).toMatchObject({ effect: "reading", exposure: ["workflow"] });
    }
    const agentFiles = readdirSync(resolve(root, "clients/demo"), {
      recursive: true,
      encoding: "utf8"
    }).filter((path) => path.endsWith(".agent.yaml") && !path.includes("node_modules"));
    expect(agentFiles.length).toBeGreaterThan(0);
    for (const path of agentFiles) {
      expect(readFileSync(resolve(root, "clients/demo", path), "utf8")).not.toContain(CONNECTION);
    }
  });

  it("serves 600 distinct invented clients in the documented size groups", async () => {
    const { client } = await start();
    const read = await readToEnd(
      client,
      "list_accounting_clients",
      accountingOutputSchemas.list_accounting_clients,
      {},
      ACCOUNTING_DEFAULT_PAGE_SIZE
    );
    // Six full pages and the empty one that ends them.
    expect(read.pages).toBe(7);
    expect(read.rows).toEqual(sample.clients);
    expect(read.rows).toHaveLength(600);
    const ids = read.rows.map(({ client_id }) => client_id);
    expect(ids).toEqual([...new Set(ids)].sort((left, right) => left - right));
    expect(new Set(read.rows.map(({ name }) => name)).size).toBe(600);
    expect(new Set(read.rows.map(({ client_number }) => client_number)).size).toBe(600);
    // Every name is two invented words with the trade of the industry, and the legal form
    // where the form is part of a name.
    for (const { client_id, name } of read.rows) {
      const { legalForm } = sample.businessOf(client_id);
      expect(name).toMatch(/[A-Z][a-z]+ (& )?[A-Z][a-z]+/u);
      if (legalForm === "Einzelunternehmen" || legalForm === "Freiberufler") {
        expect(name).not.toMatch(/(GmbH|GbR|UG|AG|KG|eG|e\. K\.)/u);
      } else {
        expect(name.endsWith(` ${legalForm}`)).toBe(true);
      }
    }
    const unpaged = await rowsOf(
      client,
      "list_accounting_clients",
      accountingOutputSchemas.list_accounting_clients
    );
    expect(unpaged).toEqual(sample.clients.slice(0, ACCOUNTING_DEFAULT_PAGE_SIZE));

    expect(SIZE_GROUPS).toEqual([
      { name: "micro", clients: 335, minimum: 50, maximum: 250 },
      { name: "small", clients: 184, minimum: 300, maximum: 4_000 },
      { name: "medium", clients: 73, minimum: 10_000, maximum: 60_000 },
      { name: "large", clients: 8, minimum: 100_000, maximum: 100_000 }
    ]);
    const tally = new Map<string, number>();
    let variedClients = 0;
    for (const id of ids) {
      const counts = MONTHS.map((month) => sample.postingCount(id, month));
      const groups = new Set(counts.map((count) => sizeGroupOf(count).name));
      // A client stays in its group in every month.
      expect(groups.size).toBe(1);
      const [group] = groups;
      tally.set(required(group), (tally.get(required(group)) ?? 0) + 1);
      if (new Set(counts).size > 1) variedClients += 1;
    }
    expect(Object.fromEntries(tally)).toEqual({ micro: 335, small: 184, medium: 73, large: 8 });
    // A count varies by month, except where it is exactly 100,000.
    expect(variedClients).toBeGreaterThan(500);
  });

  it("describes each client's fiscal years and its chart of accounts", async () => {
    const { client } = await start();
    const startMonths = new Set<number>();
    const charts = new Map<number, Account[]>();
    for (const { client_id, client_number, name } of sample.clients.slice(0, 60)) {
      const years = await rowsOf(
        client,
        "list_fiscal_years",
        accountingOutputSchemas.list_fiscal_years,
        { client_id }
      );
      expect(years).toEqual(sample.fiscalYears(client_id));
      const first = required(years[0]);
      startMonths.add(Math.floor(first.fiscal_year_start / 100) % 100);
      // The fiscal years follow one another without a gap and cover the sample's months.
      expect(first.fiscal_year_start).toBeLessThanOrEqual(20240101);
      expect(required(years.at(-1)).fiscal_year_end).toBeGreaterThanOrEqual(20260930);
      for (const [index, year] of years.entries()) {
        expect(year).toMatchObject({
          client_id,
          client_number,
          client_name: name,
          fiscal_year: year.fiscal_year_start,
          account_length: 4,
          consultant_number: first.consultant_number,
          base_currency: "EUR",
          inactive: 0
        });
        const next = years[index + 1];
        if (next) expect(next.fiscal_year_start).toBe(year.fiscal_year_start + 10_000);
      }
      if (!charts.has(first.skr)) {
        charts.set(
          first.skr,
          await rowsOf(client, "list_accounts", accountingOutputSchemas.list_accounts, {
            client_id
          })
        );
        expect(charts.get(first.skr)).toEqual(sample.accounts(client_id));
      }
    }
    // Most clients keep the calendar year, some a deviating fiscal year.
    expect(startMonths.has(1)).toBe(true);
    expect(startMonths.size).toBeGreaterThan(1);
    expect([...charts.keys()].sort()).toEqual([3, 4]);
    for (const [skr, chart] of charts) {
      const numbers = chart.map(({ account_number }) => account_number);
      expect(numbers).toEqual([...new Set(numbers)].sort((left, right) => left - right));
      // Four-digit general ledger accounts, then the debtors and the creditors in their ranges.
      const personal = chart.filter(({ account_number }) => account_number > 9_999);
      expect(numbers.every((number) => number >= 1_000 && number <= 99_999)).toBe(true);
      expect(personal.some(({ account_number }) => isDebtor(account_number))).toBe(true);
      expect(personal.some(({ account_number }) => isCreditor(account_number))).toBe(true);
      for (const account of personal) {
        expect(account).toMatchObject({
          account_class: isDebtor(account.account_number) ? "asset" : "liability",
          automatic_vat_key: null
        });
      }
      // The creditors the client no longer buys from stay in its chart, blocked, behind the others.
      expect(personal.filter(({ blocked }) => blocked)).toEqual(personal.slice(-3));
      expect(personal.slice(-3).every(({ account_number }) => isCreditor(account_number))).toBe(
        true
      );
      expect(new Set(personal.map(({ label }) => label)).size).toBe(personal.length);
      // Of the general ledger, the two accounts closed in every chart and the purchase
      // accounts the client's industry has no use for.
      const closed = chart.filter(
        ({ blocked, account_number }) => blocked && account_number < 10_000
      );
      expect(closed.map(({ label }) => label)).toEqual(
        expect.arrayContaining(["Durchlaufende Posten", "Sonstige betriebliche Aufwendungen"])
      );
      expect(closed.length).toBeGreaterThan(2);
      expect(closed.every(({ account_class }) => account_class !== "revenue")).toBe(true);
      expect(chart.some(({ automatic_vat_key }) => automatic_vat_key !== null)).toBe(true);
      // The tax-free export and the tax-free intra-community delivery are two accounts.
      const labelOf = (number: number) =>
        required(chart.find(({ account_number }) => account_number === number)).label;
      expect(labelOf(skr === 3 ? 8120 : 4120)).toBe("Steuerfreie Umsätze § 4 Nr. 1a UStG");
      expect(labelOf(skr === 3 ? 8125 : 4125)).toBe(
        "Steuerfreie innergemeinschaftliche Lieferungen § 4 Nr. 1b UStG"
      );
      // The labels are those of DATEV's frames: both charts say "Fahrzeug-", and the repairs of
      // machines are worded in the plural in SKR03 and in the singular in SKR04.
      expect(labelOf(skr === 3 ? 4530 : 6530)).toBe("Laufende Fahrzeug-Betriebskosten");
      expect(labelOf(skr === 3 ? 4540 : 6540)).toBe("Fahrzeug-Reparaturen");
      expect(labelOf(skr === 3 ? 4800 : 6460)).toBe(
        skr === 3
          ? "Reparaturen und Instandhaltungen von technischen Anlagen und Maschinen"
          : "Reparaturen und Instandhaltung von technischen Anlagen und Maschinen"
      );
    }
    // The longest chart, with every personal account, still fits one answer of a Connection.
    const [mostAccounts] = sample.clients
      .map(({ client_id }) => client_id)
      .sort((left, right) => sample.accounts(right).length - sample.accounts(left).length);
    const longest = await client.callTool({
      name: "list_accounts",
      arguments: { client_id: mostAccounts }
    });
    expect(connectionBytes(longest)).toBeLessThanOrEqual(PAGE_BYTES_SHARE * MCP_RESULT_MAX_BYTES);
    // One consultant number for every client.
    expect(
      new Set(
        sample.clients.map(
          ({ client_id }) => required(sample.fiscalYears(client_id)[0]).consultant_number
        )
      ).size
    ).toBe(1);
  });

  it("pages a mid-size client's month to its end at two page sizes, each booking once and in order", async () => {
    const { client } = await start();
    const clientId = required(clientIdsOf("medium")[0]);
    const expected = everyPosting(clientId, MONTH);
    expect(expected).toHaveLength(sample.postingCount(clientId, MONTH));
    expect(sizeGroupOf(expected.length).name).toBe("medium");
    expect(expected.map(({ date }) => date)).toEqual(expected.map(({ date }) => date).sort());
    // A size that divides nothing ends on a short page, the other may end on an empty one.
    for (const pageSize of [777, ACCOUNTING_MAXIMUM_PAGE_SIZE]) {
      const read = await readToEnd(
        client,
        "list_postings",
        accountingOutputSchemas.list_postings,
        { client_id: clientId, month: MONTH },
        pageSize
      );
      expect(read.pages).toBe(Math.floor(expected.length / pageSize) + 1);
      expect(read.rows).toEqual(expected);
    }
    const defaults = await rowsOf(client, "list_postings", accountingOutputSchemas.list_postings, {
      client_id: clientId,
      month: MONTH
    });
    expect(defaults).toEqual(expected.slice(0, ACCOUNTING_DEFAULT_PAGE_SIZE));
  });

  it("pages the largest client's 100,000 bookings at the maximum page size, each page under the Connection's bound and far inside its time", async () => {
    const { client } = await start();
    const clientId = required(clientIdsOf("large")[0]);
    const expected = everyPosting(clientId, MONTH);
    expect(expected).toHaveLength(100_000);
    expect(expected.map(({ date }) => date)).toEqual(expected.map(({ date }) => date).sort());
    const rows: Posting[] = [];
    let largestBytes = 0;
    let slowestMs = 0;
    // 100 full pages and the empty one that ends them.
    for (let page = 1; page <= 101; page += 1) {
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
    expect(rows).toEqual(expected);
    expect(largestBytes).toBeGreaterThan(MCP_RESULT_MAX_BYTES / 2);
    expect(largestBytes).toBeLessThanOrEqual(PAGE_BYTES_SHARE * MCP_RESULT_MAX_BYTES);
    expect(slowestMs).toBeLessThan(PAGE_TIME_BOUND_MS);
  }, 120_000);

  it("gives two servers of one seed the same data and a server of another seed other data", async () => {
    const [first, second, other] = await Promise.all([
      start(),
      start(),
      start({ accountingSeed: 20261012 })
    ]);
    const clientId = required(clientIdsOf("small")[0]);
    const read = ({ client }: { client: SampleClient }) =>
      Promise.all([
        rowsOf(client, "list_accounting_clients", accountingOutputSchemas.list_accounting_clients),
        rowsOf(client, "list_fiscal_years", accountingOutputSchemas.list_fiscal_years, {
          client_id: clientId
        }),
        rowsOf(client, "list_postings", accountingOutputSchemas.list_postings, {
          client_id: clientId,
          month: MONTH
        })
      ]);
    const [firstRows, secondRows, otherRows] = await Promise.all([
      read(first),
      read(second),
      read(other)
    ]);
    expect(secondRows).toEqual(firstRows);
    expect(otherRows[0]).not.toEqual(firstRows[0]);
    expect(otherRows[2]).not.toEqual(firstRows[2]);
    // A month is the same whenever it is asked for: the server has no clock in its data.
    expect(firstRows[2]).toEqual(sample.postings(clientId, MONTH, 0, ACCOUNTING_DEFAULT_PAGE_SIZE));
  });

  it("refuses an unknown client and a month outside the range as invalid input that names the range", async () => {
    const { client } = await start();
    const first = required(sample.clients[0]).client_id;
    const last = required(sample.clients.at(-1)).client_id;
    const { tools } = await client.listTools();
    /**
     * What a Connection reads of the input before it calls: it validates against the schema
     * the tool advertises and refuses with `input_invalid`, which no retry mends.
     */
    const refusedByConnection = (name: ToolName, input: Record<string, unknown>) => {
      const schema = unknownToJsonValue(
        required(tools.find((tool) => tool.name === name)).inputSchema
      );
      const compiled = compileJsonSchema(isJsonObject(schema) ? schema : {});
      return compiled.ok && compiled.validate(input).length > 0;
    };
    const refusal = async (name: ToolName, input: Record<string, unknown>) => {
      expect(refusedByConnection(name, input), JSON.stringify(input)).toBe(true);
      const result = await client.callTool({ name, arguments: input });
      expect(result.isError, JSON.stringify(input)).toBe(true);
      return JSON.stringify(result.content);
    };

    for (const name of ["list_fiscal_years", "list_accounts", "list_postings"] as const) {
      const month = name === "list_postings" ? { month: MONTH } : {};
      expect(refusedByConnection(name, { client_id: first, ...month })).toBe(false);
      expect(refusedByConnection(name, { client_id: last, ...month })).toBe(false);
      for (const client_id of [first - 1, last + 1, 999_999, -1]) {
        expect(await refusal(name, { client_id, ...month })).toContain(
          `client_id must be a whole number from ${first} to ${last}, the clients of the sample.`
        );
      }
    }
    // The range ends with the sample's last month. No month after it has bookings.
    for (const month of ["2024-01", "2026-09"]) {
      expect(refusedByConnection("list_postings", { client_id: first, month })).toBe(false);
    }
    for (const month of ["2023-12", "2026-10", "2026-11", "2027-01", "2026-13", "2026-3"]) {
      expect(await refusal("list_postings", { client_id: first, month })).toContain(
        "month must be a month from 2024-01 to 2026-09 as YYYY-MM."
      );
    }
    expect(required(tools.find(({ name }) => name === "list_postings")).description).toContain(
      "from 2024-01 to 2026-09"
    );
    for (const invalid of [
      { page: 0 },
      { page_size: 0 },
      { page_size: ACCOUNTING_MAXIMUM_PAGE_SIZE + 1 },
      { page: 1.5 },
      { client_id: "1001" },
      { total: true }
    ]) {
      await refusal("list_postings", { client_id: first, month: MONTH, ...invalid });
    }
    // A page behind the end is empty, not an error: that is how a caller finds the end.
    expect(
      await rowsOf(client, "list_postings", accountingOutputSchemas.list_postings, {
        client_id: first,
        month: MONTH,
        page: 1_000_000
      })
    ).toEqual([]);
  });

  it("ends with the month it is given, 2026-09 when left out, whatever the clock says", () => {
    expect(sample.months).toHaveLength(33);
    expect(sample.months[0]).toBe("2024-01");
    expect(sample.months.at(-1)).toBe("2026-09");
    const earlier = createAccountingSample({ lastMonth: "2025-06" });
    expect(earlier.months).toEqual(sample.months.slice(0, 18));
    const { client_id } = required(sample.clients[0]);
    // A month keeps its bookings when the range grows. Only its lock follows the last month.
    expect(earlier.postings(client_id, MONTH, 0, 50)).toEqual(
      sample.postings(client_id, MONTH, 0, 50)
    );
    expect(() => earlier.postingCount(client_id, "2025-07")).toThrow(
      "The sample has bookings for the months 2024-01 to 2025-06 only."
    );
    expect(required(earlier.fiscalYears(client_id).at(-1)).year).toBe(2025);
    for (const lastMonth of ["2023-12", "2026-13", "2026-1", "September"]) {
      expect(() => createAccountingSample({ lastMonth })).toThrow(
        "lastMonth must be a month from 2024-01 on as YYYY-MM."
      );
    }
    // The last three months are open, the ones before are locked.
    const capitalisation = (month: string) =>
      required(sample.postings(client_id, month, 0, 1)[0]).capitalisation_number;
    expect(sample.months.map(capitalisation).slice(-4)).toEqual([30, 0, 0, 0]);
  });

  it("takes its last month from where the server is built: schema, description and refusal name it", async () => {
    const { client } = await start({ accountingLastMonth: "2025-03" });
    const { client_id } = required(sample.clients[0]);
    const { tools } = await client.listTools();
    const listPostings = required(tools.find(({ name }) => name === "list_postings"));
    expect(listPostings.description).toContain("from 2024-01 to 2025-03");
    expect(JSON.stringify(listPostings.inputSchema)).toContain('"2025-03"');
    expect(JSON.stringify(listPostings.inputSchema)).not.toContain('"2025-04"');
    // A month it has holds the bookings of the server that is given none.
    expect(
      await rowsOf(client, "list_postings", accountingOutputSchemas.list_postings, {
        client_id,
        month: MONTH
      })
    ).toEqual(sample.postings(client_id, MONTH, 0, ACCOUNTING_DEFAULT_PAGE_SIZE));
    const refused = await client.callTool({
      name: "list_postings",
      arguments: { client_id, month: "2025-04" }
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(
      "month must be a month from 2024-01 to 2025-03 as YYYY-MM."
    );
    expect(() => createSampleMcpServer({ key, accountingLastMonth: "2026-13" })).toThrow(
      "lastMonth must be a month from 2024-01 on as YYYY-MM."
    );
  });

  it("opens every month of every client with the month's exact count", () => {
    for (const { client_id } of sample.clients) {
      for (const month of sample.months) {
        const count = sample.postingCount(client_id, month);
        // The last booking exists and nothing stands behind it.
        expect(sample.postings(client_id, month, count - 1, 2)).toHaveLength(1);
      }
    }
  });

  it("guards the second address with the same key and logs it under its own path", async () => {
    const lines: string[] = [];
    const { client, url } = await start({ log: (line) => lines.push(line) });
    const refused = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    expect(refused.status).toBe(401);
    expect(lines).toContain("POST /accounting/mcp 401");
    await client.callTool({ name: "list_accounts", arguments: { client_id: 1001 } });
    expect(lines).toContain("POST /accounting/mcp 200 tools/call list_accounts");
    expect((await fetch(`${url}/more`, { method: "POST" })).status).toBe(404);
    // The wholesale tools stay at their own address.
    const wholesale = await connectSampleMcpClient({ url: url.replace("/accounting", ""), key });
    clients.push(wholesale);
    const { tools } = await wholesale.listTools();
    expect(tools.map(({ name }) => name)).toContain("list_customers");
    expect(tools.map(({ name }) => name)).not.toContain("list_postings");
  });
});
