import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  connectSampleMcpClient,
  createSampleData,
  createSampleMcpServer,
  DEFAULT_LIMIT,
  MAXIMUM_BODY_BYTES,
  MAXIMUM_LIMIT,
  MINIMUM_KEY_LENGTH,
  MINIMUM_LIMIT,
  outputSchemas,
  utcMonthAnchor
} from "@vivd-catalyst/demo/sample-mcp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const key = "test-only-sample-mcp-bearer-key-0001";
const anchor = "2026-10";
type SampleClient = Awaited<ReturnType<typeof connectSampleMcpClient>>;
type SampleServer = ReturnType<typeof createSampleMcpServer>;
type ToolName = keyof typeof outputSchemas;
const servers: SampleServer[] = [];
const clients: SampleClient[] = [];
const temporaryDirectories: string[] = [];
let client: SampleClient;
let url: string;

async function start(month = anchor) {
  const server = createSampleMcpServer({ key, anchor: month });
  servers.push(server);
  const { port } = await server.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${port}`;
  const client = await connectSampleMcpClient({ url: `${url}/mcp`, key });
  clients.push(client);
  return { client, url };
}

async function call<S extends z.ZodType>(
  client: SampleClient,
  name: ToolName,
  schema: S,
  args: Record<string, unknown> = {}
): Promise<z.output<S>> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBeUndefined();
  const parsed = schema.parse(result.structuredContent);
  expect(result.content).toEqual([
    { type: "text", text: JSON.stringify(result.structuredContent) }
  ]);
  return parsed;
}

async function allOrders(client: SampleClient) {
  const rows: z.output<typeof outputSchemas.list_orders>["rows"] = [];
  let total = Infinity;
  while (rows.length < total) {
    const result = await call(client, "list_orders", outputSchemas.list_orders, {
      limit: 200,
      offset: rows.length
    });
    expect(result.rows.length).toBeGreaterThan(0);
    total = result.total;
    rows.push(...result.rows);
  }
  return rows;
}

async function allInvoices(client: SampleClient) {
  const rows: z.output<typeof outputSchemas.list_invoices>["rows"] = [];
  let total = Infinity;
  while (rows.length < total) {
    const result = await call(client, "list_invoices", outputSchemas.list_invoices, {
      limit: 200,
      offset: rows.length
    });
    expect(result.rows.length).toBeGreaterThan(0);
    total = result.total;
    rows.push(...result.rows);
  }
  return rows;
}

function newestFirst(rows: { date: string; id: string }[]) {
  expect(rows).toEqual(
    [...rows].sort(
      (left, right) => right.date.localeCompare(left.date) || left.id.localeCompare(right.id)
    )
  );
}

beforeEach(async () => {
  ({ client, url } = await start());
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("demo sample MCP", () => {
  it("advertises exactly five read-only tools with the registered output schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name).sort()).toEqual(Object.keys(outputSchemas).sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      const name = z
        .enum([
          "list_customers",
          "get_customer",
          "list_orders",
          "list_invoices",
          "revenue_by_month"
        ])
        .parse(tool.name);
      expect(tool.outputSchema).toEqual(z.toJSONSchema(outputSchemas[name], { target: "draft-7" }));
    }
    expect(MINIMUM_LIMIT).toBe(1);
    expect(MAXIMUM_LIMIT).toBe(200);
    await call(client, "list_customers", outputSchemas.list_customers, {
      segment: "retail",
      limit: 5
    });
    const customer = await call(client, "get_customer", outputSchemas.get_customer, {
      id: "C-0001"
    });
    expect(customer.customer.id).toBe("C-0001");
    expect(customer.recentOrders).toHaveLength(10);
    newestFirst(customer.recentOrders);
    newestFirst(customer.openInvoices);
    expect(
      customer.openInvoices.every((row) => row.customerId === "C-0001" && row.status !== "paid")
    ).toBe(true);
    await call(client, "list_orders", outputSchemas.list_orders, {
      status: "shipped",
      from: "2026-01-01",
      to: "2026-09-30"
    });
    await call(client, "list_invoices", outputSchemas.list_invoices, {
      status: "paid",
      customerId: "C-0001"
    });
    await call(client, "revenue_by_month", outputSchemas.revenue_by_month, { segment: "office" });
  });

  it("reconciles twelve ordered revenue months with all paged non-cancelled orders", async () => {
    const orders = await allOrders(client);
    const revenue = await call(client, "revenue_by_month", outputSchemas.revenue_by_month);
    const months = Array.from({ length: 12 }, (_, index) =>
      utcMonthAnchor(new Date(Date.UTC(2025, 9 + index, 1)))
    );
    expect(revenue.rows.map(({ month }) => month)).toEqual(months);
    const activeOrders = orders.filter(({ status }) => status !== "cancelled");
    expect(revenue.rows.reduce((sum, row) => sum + row.revenueCents, 0)).toBe(
      activeOrders.reduce((sum, row) => sum + row.netTotalCents, 0)
    );
    expect(revenue.rows.reduce((sum, row) => sum + row.orders, 0)).toBe(activeOrders.length);
    const filtered = await call(client, "revenue_by_month", outputSchemas.revenue_by_month, {
      from: "2026-02-01",
      to: "2026-02-28",
      segment: "retail"
    });
    const customers = await call(client, "list_customers", outputSchemas.list_customers, {
      segment: "retail"
    });
    const ids = new Set(customers.rows.map(({ id }) => id));
    const expected = activeOrders.filter(
      (order) =>
        ids.has(order.customerId) && order.date >= "2026-02-01" && order.date <= "2026-02-28"
    );
    expect(filtered.rows.reduce((sum, row) => sum + row.revenueCents, 0)).toBe(
      expected.reduce((sum, row) => sum + row.netTotalCents, 0)
    );
    expect(
      filtered.rows
        .filter(({ month }) => month !== "2026-02")
        .every((row) => row.revenueCents === 0 && row.orders === 0)
    ).toBe(true);
  });

  it("repeats every tool result and all rows for an anchor and shifts dates for another", async () => {
    const second = await start();
    for (const name of Object.keys(outputSchemas)) {
      const args = name === "get_customer" ? { id: "C-0001" } : {};
      const left = await client.callTool({ name, arguments: args });
      const right = await second.client.callTool({ name, arguments: args });
      expect(left.isError).toBeUndefined();
      expect(right).toEqual(left);
    }
    expect(await allOrders(second.client)).toEqual(await allOrders(client));
    expect(await allInvoices(second.client)).toEqual(await allInvoices(client));
    expect(JSON.stringify(createSampleData(anchor))).toBe(JSON.stringify(createSampleData(anchor)));
    const third = await start("2026-11");
    const changed = await allOrders(third.client);
    expect(changed.map(({ date }) => date)).not.toEqual(
      (await allOrders(client)).map(({ date }) => date)
    );
    expect(changed.every((row) => row.date >= "2025-11-01" && row.date < "2026-11-01")).toBe(true);
    expect(utcMonthAnchor(new Date("2026-10-01T00:30:00+02:00"))).toBe("2026-09");
  });

  it("provides realistic row counts, status relationships, amounts and customer concentration", async () => {
    const customers = (await call(client, "list_customers", outputSchemas.list_customers)).rows;
    const orders = await allOrders(client);
    const invoices = await allInvoices(client);
    expect(customers.length).toBeGreaterThanOrEqual(30);
    expect(customers.length).toBeLessThanOrEqual(50);
    expect(orders.length).toBeGreaterThanOrEqual(500);
    expect(orders.length).toBeLessThanOrEqual(700);
    expect(invoices.length).toBeGreaterThanOrEqual(450);
    expect(invoices.length).toBeLessThanOrEqual(650);
    expect(new Set(customers.map(({ segment }) => segment))).toEqual(
      new Set(["retail", "hospitality", "office"])
    );
    expect(new Set(orders.map(({ status }) => status))).toEqual(
      new Set(["open", "shipped", "cancelled"])
    );
    expect(new Set(invoices.map(({ status }) => status))).toEqual(
      new Set(["open", "paid", "overdue"])
    );
    newestFirst(orders);
    newestFirst(invoices);
    const orderById = new Map(orders.map((row) => [row.id, row]));
    const customerIds = new Set(customers.map(({ id }) => id));
    for (const row of [...orders, ...invoices]) {
      expect(row.date >= "2025-10-01" && row.date < "2026-10-01").toBe(true);
      expect(customerIds.has(row.customerId)).toBe(true);
      expect(row.currency).toBe("EUR");
      const amount = "netTotalCents" in row ? row.netTotalCents : row.totalCents;
      expect(Number.isInteger(amount) && amount > 0).toBe(true);
    }
    for (const invoice of invoices) {
      const order = orderById.get(invoice.orderId);
      expect(order).toBeDefined();
      expect(order?.status).toBe("shipped");
      expect(invoice.customerId).toBe(order?.customerId);
      expect(invoice.totalCents).toBe(Math.round((order?.netTotalCents ?? 0) * 1.19));
      expect(
        new Date(`${invoice.dueDate}T00:00:00Z`).getTime() -
          new Date(`${invoice.date}T00:00:00Z`).getTime()
      ).toBe(30 * 86_400_000);
      if (invoice.status !== "paid")
        expect(invoice.status).toBe(invoice.dueDate < "2026-10-01" ? "overdue" : "open");
    }
    expect(
      orders.filter(({ status }) => status === "cancelled").length / orders.length
    ).toBeCloseTo(0.05);
    expect(
      orders.filter(({ status }) => status === "open").every(({ date }) => date >= "2026-09-10")
    ).toBe(true);
    const counts = customers.map(
      ({ id }) => orders.filter((order) => order.customerId === id).length
    );
    expect(Math.min(...counts.slice(0, 3))).toBeGreaterThan(Math.max(...counts.slice(3)) * 2);
  });

  it("pages before returning rows and applies customer, status and inclusive date filters", async () => {
    const orders = await allOrders(client);
    const invoices = await allInvoices(client);
    const page = await call(client, "list_orders", outputSchemas.list_orders);
    expect(page.rows).toEqual(orders.slice(0, DEFAULT_LIMIT));
    expect(page.total).toBe(orders.length);
    const moved = await call(client, "list_orders", outputSchemas.list_orders, {
      limit: 10,
      offset: 12
    });
    expect(moved.rows).toEqual(orders.slice(12, 22));
    expect(moved.total).toBe(orders.length);
    const defaults = await call(client, "list_invoices", outputSchemas.list_invoices);
    expect(defaults.rows).toEqual(invoices.slice(0, 50));
    const invoicePage = await call(client, "list_invoices", outputSchemas.list_invoices, {
      limit: 7,
      offset: 13
    });
    expect(invoicePage.rows).toEqual(invoices.slice(13, 20));
    expect(invoicePage.total).toBe(invoices.length);
    const filters = {
      customerId: "C-0001",
      from: "2026-01-01",
      to: "2026-08-31",
      limit: 3,
      offset: 1
    };
    const filteredOrders = await call(client, "list_orders", outputSchemas.list_orders, {
      ...filters,
      status: "shipped"
    });
    const expectedOrders = orders.filter(
      (row) =>
        row.customerId === filters.customerId &&
        row.status === "shipped" &&
        row.date >= filters.from &&
        row.date <= filters.to
    );
    expect(filteredOrders.rows).toEqual(expectedOrders.slice(1, 4));
    expect(filteredOrders.total).toBe(expectedOrders.length);
    const filteredInvoices = await call(client, "list_invoices", outputSchemas.list_invoices, {
      ...filters,
      status: "paid"
    });
    const expectedInvoices = invoices.filter(
      (row) =>
        row.customerId === filters.customerId &&
        row.status === "paid" &&
        row.date >= filters.from &&
        row.date <= filters.to
    );
    expect(filteredInvoices.rows).toEqual(expectedInvoices.slice(1, 4));
    expect(filteredInvoices.total).toBe(expectedInvoices.length);
    const boundary = z.object({ date: z.string() }).parse(orders[0]).date;
    const exactDay = await call(client, "list_orders", outputSchemas.list_orders, {
      from: boundary,
      to: boundary
    });
    expect(exactDay.rows).toEqual(orders.filter(({ date }) => date === boundary));
    const customers = await call(client, "list_customers", outputSchemas.list_customers, {
      search: "VELUNARA",
      segment: "retail",
      limit: 1,
      offset: 1
    });
    const matches = createSampleData(anchor).customers.filter(
      (row) => row.name.toLowerCase().includes("velunara") && row.segment === "retail"
    );
    expect(customers.rows).toEqual(matches.slice(1, 2));
    expect(customers.total).toBe(matches.length);
    const empty = await call(client, "list_orders", outputSchemas.list_orders, {
      offset: orders.length
    });
    expect(empty).toEqual({ rows: [], total: orders.length });
  });

  it("refuses invalid and unknown input fields and reports an unknown customer as a tool error", async () => {
    for (const name of ["list_customers", "list_orders", "list_invoices"]) {
      expect((await client.callTool({ name, arguments: { limit: 201 } })).isError).toBe(true);
      expect((await client.callTool({ name, arguments: { limit: 0 } })).isError).toBe(true);
      expect((await client.callTool({ name, arguments: { offset: -1 } })).isError).toBe(true);
    }
    for (const name of Object.keys(outputSchemas)) {
      const args = name === "get_customer" ? { id: "C-0001", extra: true } : { extra: true };
      expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
    }
    for (const name of ["list_orders", "list_invoices", "revenue_by_month"]) {
      expect((await client.callTool({ name, arguments: { from: "2026-02-30" } })).isError).toBe(
        true
      );
    }
    const result = await client.callTool({ name: "get_customer", arguments: { id: "C-missing" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "The sample customer was not found." }]);
  });

  it("authenticates before discovery and exposes only a small public health response", async () => {
    for (const authorization of [
      undefined,
      "Bearer wrong",
      `Bearer ${key.slice(0, -1)}2`,
      `Basic ${key}`,
      "Bearer",
      `Bearer ${key} extra`
    ]) {
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {})
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      const body = await response.text();
      for (const name of Object.keys(outputSchemas)) expect(body).not.toContain(name);
      expect(body).not.toContain(key);
    }
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe('{"status":"ok"}');
    expect(body).not.toContain(key);
    for (const customer of createSampleData(anchor).customers)
      expect(body).not.toContain(customer.name);
  });

  it("bounds and parses HTTP bodies and restricts methods and paths", async () => {
    for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) {
      const response = await fetch(`${url}/mcp`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
      await response.text();
    }
    const missing = await fetch(`${url}/missing`);
    expect(missing.status).toBe(404);
    await missing.text();
    for (const [body, status] of [
      ["{broken", 400],
      ["x".repeat(MAXIMUM_BODY_BYTES + 1), 413]
    ] as const) {
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body
      });
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(key);
    }
    await call(client, "list_orders", outputSchemas.list_orders);
  });

  it("rejects short or unset keys without reflecting their values", () => {
    for (const value of ["tenletters", ""]) {
      expect(() => createSampleMcpServer({ key: value })).toThrow(
        `DEMO_SAMPLE_MCP_KEY must contain at least ${MINIMUM_KEY_LENGTH} characters.`
      );
      try {
        createSampleMcpServer({ key: value });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error && value) expect(error.message).not.toContain(value);
      }
    }
    const missingKey = z.object({ key: z.string().default("") }).parse({});
    expect(() => createSampleMcpServer(missingKey)).toThrow("DEMO_SAMPLE_MCP_KEY");
    expect(() => Reflect.apply(createSampleMcpServer, undefined, [{}])).toThrow(
      "DEMO_SAMPLE_MCP_KEY"
    );
    expect(() => createSampleMcpServer({ key, anchor: "2026-13" })).toThrow();
  });

  it("generates local secrets without disclosing or replacing existing values or lines", () => {
    const directory = mkdtempSync(join(tmpdir(), "demo-sample-mcp-"));
    temporaryDirectories.push(directory);
    const path = join(directory, ".env");
    const run = () =>
      spawnSync(
        process.execPath,
        [resolve(root, "clients/demo/scripts/ensure-local-secrets.mjs"), path],
        { cwd: directory, encoding: "utf8" }
      );
    const first = run();
    expect(first.status).toBe(0);
    const initial = readFileSync(path, "utf8");
    const generated = z
      .string()
      .regex(/^[0-9a-f]{64}$/u)
      .parse(/^DEMO_SAMPLE_MCP_KEY=([^\n]+)\n$/u.exec(initial)?.[1]);
    expect(first.stdout).toBe("Generated DEMO_SAMPLE_MCP_KEY in .env.\n");
    expect(first.stderr).toBe("");
    expect(first.stdout + first.stderr).not.toContain(generated);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout + second.stderr).toBe("");
    expect(readFileSync(path, "utf8")).toBe(initial);
    writeFileSync(
      path,
      "# Other lines\r\nOTHER=leave-this\r\nDEMO_SAMPLE_MCP_KEY=\r\nTAIL=keep-this",
      { mode: 0o600 }
    );
    const third = run();
    expect(third.status).toBe(0);
    const replaced = readFileSync(path, "utf8");
    expect(replaced).toMatch(
      /^# Other lines\r\nOTHER=leave-this\r\nDEMO_SAMPLE_MCP_KEY=[0-9a-f]{64}\r\nTAIL=keep-this$/u
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(third.stdout + third.stderr).not.toContain(
      /DEMO_SAMPLE_MCP_KEY=([0-9a-f]{64})/u.exec(replaced)?.[1]
    );
    writeFileSync(path, "OTHER=keep");
    expect(run().status).toBe(0);
    expect(readFileSync(path, "utf8")).toMatch(/^OTHER=keep\nDEMO_SAMPLE_MCP_KEY=[0-9a-f]{64}\n$/u);
    writeFileSync(path, "DEMO_SAMPLE_MCP_KEY=existing-value\nDEMO_SAMPLE_MCP_KEY=\n");
    const before = readFileSync(path, "utf8");
    expect(run().stdout).toBe("");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("keeps the service local and isolated from other service environments and watch rebuilds", () => {
    expect(
      readFileSync(resolve(root, "clients/demo/docker-compose.prod.yml"), "utf8")
    ).not.toContain("sample-mcp");
    const compose = readFileSync(resolve(root, "clients/demo/docker-compose.yml"), "utf8");
    const block = z
      .string()
      .parse(compose.split("\n  sample-mcp:\n")[1]?.split(/\n  [\w-]+:|\n\S/u)[0]);
    expect(block).not.toMatch(/^\s+ports:/mu);
    expect(block).not.toContain(key);
    expect(block).toContain("DEMO_SAMPLE_MCP_KEY: ${DEMO_SAMPLE_MCP_KEY:-}");
    expect(block).not.toMatch(/DEMO_SAMPLE_MCP_KEY:\s+["']?[0-9a-f]{32,}/u);
    expect(block).toContain('expose: ["8787"]');
    expect(block).toContain("r.status===200");
    const ignores = z
      .string()
      .parse(
        compose.split("x-demo-api-watch-ignore:")[1]?.split("\nx-backend-package-watch-ignore:")[0]
      );
    expect(ignores).toContain('"sample-mcp/**"');
    expect(ignores).toContain('"src/sample-mcp-server.ts"');
    for (const path of [
      "../../clients/demo/sample-mcp",
      "../../clients/demo/src/sample-mcp-server.ts",
      "../../clients/demo/package.json",
      "../../docker",
      "../../package.json",
      "../../pnpm-lock.yaml",
      "../../pnpm-workspace.yaml"
    ]) {
      expect(block).toContain(`- action: rebuild\n          path: ${path}`);
    }
  });
});
