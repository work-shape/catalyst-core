import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadClientInstanceConfigFromFile } from "@vivd-catalyst/config-schema";
import { MCP_CALL_TIMEOUT_MS, MCP_RESULT_MAX_BYTES } from "@vivd-catalyst/connections";
import {
  ACCOUNTING_DEFAULT_PAGE_SIZE,
  ACCOUNTING_MAXIMUM_PAGE_SIZE,
  ACCOUNTING_RULES,
  accountingOutputSchemas,
  connectSampleMcpClient,
  createAccountingSample,
  createSampleMcpServer,
  SIZE_GROUPS
} from "@vivd-catalyst/demo/sample-mcp";
import { required } from "./support/assertions";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const key = "test-only-sample-mcp-bearer-key-0001";
const CONNECTION = "sample-accounting";
const MONTHS = ["2024-02", "2026-11"] as const;
const [MONTH] = MONTHS;
/** The share of a Connection's result bound the largest page may fill. */
const PAGE_BYTES_SHARE = 0.75;
/** Wide, because one green run proves no timing: the largest page takes well under a second. */
const PAGE_TIME_BOUND_MS = MCP_CALL_TIMEOUT_MS / 6;

type SampleClient = Awaited<ReturnType<typeof connectSampleMcpClient>>;
type ToolName = keyof typeof accountingOutputSchemas;
type RuleId = keyof typeof ACCOUNTING_RULES;
type Posting = z.output<typeof accountingOutputSchemas.list_postings>["rows"][number];
type Account = z.output<typeof accountingOutputSchemas.list_accounts>["rows"][number];
type ToolResult = Awaited<ReturnType<SampleClient["callTool"]>>;

const servers: ReturnType<typeof createSampleMcpServer>[] = [];
const clients: SampleClient[] = [];
/** The data of the server's own seed, as the generator gives it without a server. */
const sample = createAccountingSample();

async function start(options: { accountingSeed?: number; log?: (line: string) => void } = {}) {
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

function sizeGroupOf(count: number) {
  return required(SIZE_GROUPS.find((group) => count >= group.minimum && count <= group.maximum));
}

/** The client ids of a size group, the ones with the fewest bookings in `MONTH` first. */
function clientIdsOf(group: (typeof SIZE_GROUPS)[number]["name"]): number[] {
  return sample.clients
    .map(({ client_id }) => ({ client_id, count: sample.postingCount(client_id, MONTH) }))
    .filter(({ count }) => sizeGroupOf(count).name === group)
    .sort((left, right) => left.count - right.count)
    .map(({ client_id }) => client_id);
}

function everyPosting(clientId: number, month: string): Posting[] {
  return sample.postings(clientId, month, 0, sample.postingCount(clientId, month));
}

const cents = (euros: number) => Math.round(euros * 100);

/**
 * The places of the bookings that break each rule, checked as the rule's sentence in
 * `ACCOUNTING_RULES` says and with its parameters. It knows nothing of how the bookings were made.
 */
function referenceFindings(
  rows: Posting[],
  accounts: Account[],
  month: string
): Record<RuleId, number[]> {
  const chart = new Map(accounts.map((account) => [account.account_number, account]));
  const accountOf = (number: number) => required(chart.get(number));
  const duplicate = ACCOUNTING_RULES["duplicate-posting"].parameters;
  const vat = ACCOUNTING_RULES["vat-key-account-mismatch"].parameters;
  const round = ACCOUNTING_RULES["round-amount-no-document"].parameters;
  const someBookingHasCostCentre = rows.some((row) => row.kost1 !== "");
  const seen = new Set<string>();
  const found: Record<RuleId, number[]> = {
    "duplicate-posting": [],
    "vat-key-account-mismatch": [],
    "blocked-account": [],
    "round-amount-no-document": [],
    "date-outside-month": [],
    "expense-in-credit": [],
    "missing-cost-centre": []
  };
  for (const [index, row] of rows.entries()) {
    const accountClass = accountOf(row.account_number).account_class;
    const key = row.accounting_transaction_key;

    const alike = JSON.stringify(duplicate.fields.map((field) => row[field]));
    if (seen.has(alike)) found["duplicate-posting"].push(index);
    seen.add(alike);

    if (
      (vat.inputVatKeys.some((inputKey) => inputKey === key) && accountClass === "revenue") ||
      (vat.vatKeys.some((vatKey) => vatKey === key) && accountClass === "expense")
    ) {
      found["vat-key-account-mismatch"].push(index);
    }
    if (accountOf(row.account_number).blocked || accountOf(row.contra_account_number).blocked) {
      found["blocked-account"].push(index);
    }
    if (
      row.document_field_1 === "" &&
      cents(row.amount) >= cents(round.thresholdEuros) &&
      cents(row.amount) % cents(round.roundingUnitEuros) === 0
    ) {
      found["round-amount-no-document"].push(index);
    }
    if (row.date < `${month}-01` || row.date > `${month}-31`) {
      found["date-outside-month"].push(index);
    }
    if (
      accountClass === "expense" &&
      row.debit_credit_indicator === "H" &&
      row.general_reversal === 0
    ) {
      found["expense-in-credit"].push(index);
    }
    if (accountClass === "expense" && row.kost1 === "" && someBookingHasCostCentre) {
      found["missing-cost-centre"].push(index);
    }
  }
  return found;
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
    const connection = required(config.connections[CONNECTION]);
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
    for (const { name } of read.rows) {
      expect(name).toMatch(
        /^[A-Z][a-z]+ [A-Z][a-z]+ (GmbH|UG \(haftungsbeschränkt\)|GmbH & Co\. KG|KG|OHG|AG|e\. K\.|eG)$/u
      );
    }
    const unpaged = await rowsOf(
      client,
      "list_accounting_clients",
      accountingOutputSchemas.list_accounting_clients
    );
    expect(unpaged).toEqual(sample.clients.slice(0, ACCOUNTING_DEFAULT_PAGE_SIZE));

    expect(SIZE_GROUPS).toEqual([
      { name: "small", clients: 492, minimum: 200, maximum: 4_000 },
      { name: "medium", clients: 100, minimum: 10_000, maximum: 60_000 },
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
    expect(Object.fromEntries(tally)).toEqual({ small: 492, medium: 100, large: 8 });
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
      expect(required(years.at(-1)).fiscal_year_end).toBeGreaterThanOrEqual(20261231);
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
    for (const chart of charts.values()) {
      const numbers = chart.map(({ account_number }) => account_number);
      expect(numbers).toEqual([...new Set(numbers)].sort((left, right) => left - right));
      expect(numbers.every((number) => number >= 1000 && number <= 9999)).toBe(true);
      expect(chart.some(({ blocked }) => blocked)).toBe(true);
      expect(chart.some(({ automatic_vat_key }) => automatic_vat_key !== null)).toBe(true);
    }
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

  it("plants exactly the findings it expects, one rule per booking, in an otherwise clean ledger", () => {
    const ruleIds = Object.keys(ACCOUNTING_RULES);
    expect(ruleIds).toEqual([
      "duplicate-posting",
      "vat-key-account-mismatch",
      "blocked-account",
      "round-amount-no-document",
      "date-outside-month",
      "expense-in-credit",
      "missing-cost-centre"
    ]);
    for (const rule of Object.values(ACCOUNTING_RULES)) {
      expect(rule.de).toMatch(/^Eine Buchung ist ein Befund, wenn .+\.$/u);
      expect(rule.en).toMatch(/^A booking is a finding when .+\.$/u);
    }
    const sampled = [
      ...clientIdsOf("small").slice(0, 12),
      ...clientIdsOf("small").slice(-4),
      ...clientIdsOf("medium").slice(0, 3),
      ...clientIdsOf("large").slice(0, 1)
    ];
    const totals = new Map<string, number>();
    let monthsWithoutSomeRule = 0;
    for (const clientId of sampled) {
      const accounts = sample.accounts(clientId);
      for (const month of MONTHS) {
        const rows = everyPosting(clientId, month);
        const found = referenceFindings(rows, accounts, month);
        const counts = Object.fromEntries(
          Object.entries(found).map(([rule, places]) => [rule, places.length])
        );
        expect(counts, `client ${clientId} in ${month}`).toEqual(
          sample.expectedFindings(clientId, month)
        );
        const places = Object.values(found).flat();
        expect(new Set(places).size).toBe(places.length);
        for (const [rule, count] of Object.entries(counts)) {
          totals.set(rule, (totals.get(rule) ?? 0) + count);
        }
        if (Object.values(counts).includes(0)) monthsWithoutSomeRule += 1;

        // What a ledger keeps whatever was planted.
        const chart = new Map(accounts.map((account) => [account.account_number, account]));
        for (const row of rows) {
          expect(cents(row.net_amount) + cents(row.tax_amount)).toBe(cents(row.amount));
          expect(cents(row.tax_amount)).toBe(
            Math.round((cents(row.amount) * row.tax_rate) / (100 + row.tax_rate))
          );
          if (required(chart.get(row.account_number)).automatic_vat_key !== null) {
            expect(row.accounting_transaction_key).toBe(0);
          }
        }
      }
    }
    // The sample is no empty proof: every rule is broken somewhere, and no month by every rule.
    for (const rule of ruleIds) expect(totals.get(rule), rule).toBeGreaterThan(0);
    expect(monthsWithoutSomeRule).toBeGreaterThan(0);
  }, 120_000);

  it("refuses an unknown client and a month outside the range with a sentence, and invalid input", async () => {
    const { client } = await start();
    const clientId = required(sample.clients[0]).client_id;
    for (const name of ["list_fiscal_years", "list_accounts", "list_postings"]) {
      const result = await client.callTool({
        name,
        arguments: { client_id: 999_999, ...(name === "list_postings" ? { month: MONTH } : {}) }
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "No accounting client has the client_id 999999." }
      ]);
    }
    for (const month of ["2023-12", "2027-01"]) {
      const result = await client.callTool({
        name: "list_postings",
        arguments: { client_id: clientId, month }
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: "The sample has bookings for the months 2024-01 to 2026-12 only." }
      ]);
    }
    for (const invalid of [
      { page: 0 },
      { page_size: 0 },
      { page_size: ACCOUNTING_MAXIMUM_PAGE_SIZE + 1 },
      { page: 1.5 },
      { month: "2026-13" },
      { month: "2026-3" },
      { client_id: "1001" },
      { total: true }
    ]) {
      const result = await client.callTool({
        name: "list_postings",
        arguments: { client_id: clientId, month: MONTH, ...invalid }
      });
      expect(result.isError, JSON.stringify(invalid)).toBe(true);
    }
    // A page behind the end is empty, not an error: that is how a caller finds the end.
    expect(
      await rowsOf(client, "list_postings", accountingOutputSchemas.list_postings, {
        client_id: clientId,
        month: MONTH,
        page: 1_000_000
      })
    ).toEqual([]);
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
