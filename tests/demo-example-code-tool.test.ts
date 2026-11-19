import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { runCli, type CliRuntimeOptions } from "@work-shape/catalyst-cli";
import {
  loadClientInstanceConfigFromFile,
  releaseConnectionConfigSchema
} from "@work-shape/catalyst-config-schema";
import { toolAssetConfigSchema } from "@work-shape/catalyst-core";
import {
  connectSampleMcpClient,
  createSampleMcpServer,
  outputSchemas
} from "@work-shape/catalyst-demo/sample-mcp";

// The demo's example code tool (clients/demo/tools/code/open_invoices), which builders copy to
// learn the flow: its folder derives a definition the instance takes, its schema is the one
// main.py's hints say, and a run against an answer of the real sample server shows the display.
// The instance is stubbed as in tool-sdk-folders.test.ts; the Connection's answer is the one
// the sample server gives, in the shape the MCP connector hands on.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const folder = resolve(root, "clients/demo/tools/code/open_invoices");
const CONNECTION = "sample-business";
const OPERATION = "get_customer";
const CUSTOMER = "C-0001";
const KEY = "example-tool-sample-key-0123456789";

const toolPath = apiOperations["assets.put"].buildPath({
  params: { kind: "tool", name: "open_invoices" }
});
const triesPath = apiOperations["connections.try_call"].buildPath({
  params: { name: CONNECTION, operation: OPERATION }
});

type SampleServer = ReturnType<typeof createSampleMcpServer>;
let server: SampleServer | undefined;
/** What the sample server answers for the customer, as the Connection hands it to the tool. */
let answer: { content: unknown[]; structuredContent: z.infer<typeof outputSchemas.get_customer> };

beforeAll(async () => {
  server = createSampleMcpServer({ key: KEY, anchor: "2026-06" });
  const { port } = await server.listen(0, "127.0.0.1");
  const client = await connectSampleMcpClient({ url: `http://127.0.0.1:${port}/mcp`, key: KEY });
  try {
    const result = await client.callTool({ name: OPERATION, arguments: { id: CUSTOMER } });
    answer = {
      content: z.array(z.unknown()).parse(result.content),
      structuredContent: outputSchemas.get_customer.parse(result.structuredContent)
    };
  } finally {
    await client.close();
  }
});

afterAll(async () => {
  await server?.close();
});

/** A stubbed instance: an unknown tool for `put`, the sample answer for a Connection call. */
function instance() {
  const received: { path: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { pathname } = new URL(request.url);
    if (pathname === apiOperations["access_tokens.exchange"].path) {
      return Response.json({
        accessToken: "test-access-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }
    const body: unknown = request.method === "GET" ? undefined : await request.json();
    received.push({ path: pathname, body });
    if (pathname === triesPath) return Response.json({ target: "test", output: answer });
    if (request.method === "GET") {
      return Response.json({ error: { code: "NOT_FOUND", message: "No" } }, { status: 404 });
    }
    return Response.json({ version: 1, revision: 1, warnings: [] });
  };
  return { fetchImpl, received };
}

async function cli(args: string[], options: CliRuntimeOptions) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args, "--instance", "https://catalyst.test"], {
    cwd: tmpdir(),
    env: { CATALYST_API_KEY: "test-cli-key", PATH: process.env.PATH ?? "" },
    stdin: Readable.from([]),
    ...options,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text)
  });
  return { code, out: out.join(""), err: err.join("") };
}

const putBodySchema = z.object({ config: toolAssetConfigSchema });
const runAnswerSchema = z.object({
  output: z.string(),
  display: z.object({
    type: z.literal("data"),
    kind: z.string(),
    title: z.string(),
    data: z.record(z.string(), z.unknown())
  }),
  simulatedCalls: z.number()
});

const euros = (cents: number) => Math.round(cents) / 100;

describe("the demo's example code tool", () => {
  it("derives a definition the instance takes, its schema from main.py's hints", async () => {
    const { fetchImpl, received } = instance();
    const put = await cli(["tool", "put", folder], { fetchImpl });
    expect(put.code, put.err).toBe(0);
    expect(put.out).toContain("catalyst tool publish open_invoices --revision 1");

    const body = received.find((request) => request.path === toolPath && request.body);
    const { config } = putBodySchema.parse(body?.body);
    expect(config).toMatchObject({
      type: "code",
      name: "open_invoices",
      title: { en: "Open invoices", de: "Offene Rechnungen" },
      icon: "document",
      runtime: "python",
      entry: "main.py",
      timeoutSeconds: 20,
      connections: [`connection.${CONNECTION}.${OPERATION}`]
    });
    expect(config.description).toMatch(/^Sums the unpaid invoices of one customer/u);
    expect(config.type === "code" && config.files.map((file) => file.path)).toEqual([
      "README.md",
      "main.py"
    ]);
    expect(config.input).toEqual({
      type: "object",
      properties: {
        customer_id: {
          type: "string",
          description:
            "The customer's id, such as C-0001, from connection.sample-business.list_customers."
        },
        overdue_only: {
          type: "boolean",
          description: "Only the invoices whose due date has passed.",
          default: false
        }
      },
      required: ["customer_id"],
      additionalProperties: false
    });
  });

  it("calls an operation the demo's Connection has, open to a run from the CLI", async () => {
    const config = await loadClientInstanceConfigFromFile(
      resolve(root, "clients/demo/config/app.yaml")
    );
    const connection = releaseConnectionConfigSchema.parse(config.connections[CONNECTION]);
    const operation = connection.operations.find(({ name }) => name === OPERATION);
    expect(operation).toMatchObject({ effect: "reading" });
    expect(operation?.exposure).toEqual(expect.arrayContaining(["agent", "outside"]));
  });

  it("runs against the sample server's answer and shows the invoices as a data display", async () => {
    const unpaid = [...answer.structuredContent.openInvoices].sort((left, right) =>
      left.dueDate.localeCompare(right.dueDate)
    );
    const overdue = unpaid.filter((invoice) => invoice.status === "overdue");
    // The sample gives the first customer invoices of both kinds, so the sums say something.
    expect(overdue.length).toBeGreaterThan(0);
    expect(overdue.length).toBeLessThan(unpaid.length);
    const sum = (rows: typeof unpaid) => rows.reduce((total, row) => total + row.totalCents, 0);
    const { customer } = answer.structuredContent;

    const { fetchImpl, received } = instance();
    const ran = await cli(
      ["tool", "run", folder, "--input", JSON.stringify({ customer_id: CUSTOMER }), "--json"],
      { fetchImpl }
    );
    expect(ran.code, ran.err).toBe(0);
    expect(received).toEqual([{ path: triesPath, body: { input: { id: CUSTOMER } } }]);
    const result = runAnswerSchema.parse(JSON.parse(ran.out));
    expect(result.simulatedCalls).toBe(0);
    expect(result.output).toBe(
      `${customer.name} has ${String(unpaid.length)} unpaid invoices over ${euros(sum(unpaid)).toFixed(2)} EUR, ` +
        `${euros(sum(overdue)).toFixed(2)} EUR of it overdue. The oldest was due on ${unpaid[0]?.dueDate ?? ""}. ` +
        "The invoices are shown beside the chat."
    );
    expect(result.display).toEqual({
      type: "data",
      kind: "sample_business.open_invoices",
      title: `Open invoices: ${customer.name}`,
      data: {
        customer: customer.name,
        city: customer.city,
        unpaidInvoices: unpaid.length,
        openEur: euros(sum(unpaid)),
        overdueEur: euros(sum(overdue)),
        oldestDue: unpaid[0]?.dueDate,
        invoices: unpaid.map((invoice) => ({
          invoice: invoice.id,
          dueDate: invoice.dueDate,
          status: invoice.status,
          amountEur: euros(invoice.totalCents)
        }))
      }
    });
    const page = /open (\S+display\.html)/u.exec(ran.err)?.[1];
    expect(page).toBeDefined();
    expect(await readFile(page ?? "", "utf8")).toContain("sample_business.open_invoices");
    await rm(dirname(page ?? ""), { recursive: true, force: true });

    // overdue_only keeps the overdue ones.
    const onlyOverdue = await cli(
      [
        "tool",
        "run",
        folder,
        "--input",
        JSON.stringify({ customer_id: CUSTOMER, overdue_only: true }),
        "--json"
      ],
      { fetchImpl }
    );
    expect(onlyOverdue.code, onlyOverdue.err).toBe(0);
    const narrowed = runAnswerSchema.parse(JSON.parse(onlyOverdue.out));
    expect(narrowed.display.data).toMatchObject({
      unpaidInvoices: overdue.length,
      openEur: euros(sum(overdue)),
      overdueEur: euros(sum(overdue))
    });
    const shown = /open (\S+display\.html)/u.exec(onlyOverdue.err)?.[1];
    if (shown) await rm(dirname(shown), { recursive: true, force: true });
  });
});
