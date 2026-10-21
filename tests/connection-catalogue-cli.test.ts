import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { runCli } from "@work-shape/catalyst-cli";
import {
  createCatalogue,
  createHttpApiConnectorType,
  loadCatalogueEntries
} from "@work-shape/catalyst-connections";
import { createConnectorTypeRegistry } from "@work-shape/catalyst-core";
import type { CatalogueEntryView } from "@work-shape/catalyst-connections";
import { required } from "./support/assertions";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const catalogue = createCatalogue({
  entries: loadCatalogueEntries(new URL("../clients/demo/catalogue", import.meta.url)),
  named: ["sample-accounting"],
  connectorTypes: createConnectorTypeRegistry([createHttpApiConnectorType()])
});

async function run(
  args: string[],
  entries: readonly CatalogueEntryView[] = catalogue.entries,
  cwd?: string
) {
  const root = cwd ?? (await mkdtemp(join(tmpdir(), "cli-catalogue-")));
  if (cwd === undefined) directories.push(root);
  const out: string[] = [],
    err: string[] = [],
    calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (path === apiOperations["access_tokens.exchange"].path)
      return Response.json({
        accessToken: "cli-access-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    if (path === apiOperations["connections.connector_types"].path)
      return Response.json({ types: [], entries });
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  });
  const code = await runCli([...args, "--instance", "https://catalyst.test"], {
    cwd: root,
    env: { CATALYST_API_KEY: "test-cli-key" },
    fetchImpl,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text)
  });
  return { code, out: out.join(""), err: err.join(""), root, calls, fetchImpl };
}

describe("catalogue CLI (CAT-2)", () => {
  it("initializes an ordinary local Connection with defaults and provenance, with no remote write", async () => {
    const result = await run(["connection", "init", "books", "--from", "sample-accounting"]);
    expect(result.code, result.err).toBe(0);
    const text = await readFile(join(result.root, "connections/books/connection.yaml"), "utf8");
    const config: unknown = parseYaml(text);
    expect(config).toMatchObject({
      name: "books",
      service: "sample-accounting",
      connectorType: "http_api",
      authScheme: "bearer",
      catalogue: { entry: "sample-accounting", part: "tools", version: 1 },
      settings: {
        baseUrl: "http://sample-mcp:8787/rest",
        headers: { "x-client-instance-id": "demo-local" }
      },
      operations: [
        { name: "listClients", enabled: false, exposure: [] },
        { name: "listFiscalYears", enabled: false, exposure: [] },
        { name: "listAccountPostings", enabled: false, exposure: [] }
      ],
      credentialMode: "shared",
      origin: "runtime"
    });
    expect(text).not.toContain("recommended:");
    expect(result.calls).toEqual([
      `POST ${apiOperations["access_tokens.exchange"].path}`,
      `GET ${apiOperations["connections.connector_types"].path}`
    ]);
    expect(result.out).toContain("catalyst connection put books");
    const again = await run(
      ["connection", "init", "books", "--from", "sample-accounting"],
      catalogue.entries,
      result.root
    );
    expect(again.code).toBe(1);
    expect(await readFile(join(result.root, "connections/books/connection.yaml"), "utf8")).toBe(
      text
    );
  });

  it("respects --dir and an explicit part", async () => {
    const result = await run([
      "connection",
      "init",
      "books",
      "--from",
      "sample-accounting",
      "--part",
      "tools",
      "--dir",
      "copy"
    ]);
    expect(result.code, result.err).toBe(0);
    expect((await stat(join(result.root, "copy/connections/books/connection.yaml"))).isFile()).toBe(
      true
    );
  });

  it("requires an explicit part for two parts and writes a source without operations", async () => {
    const entry = required(catalogue.entries[0]);
    const tools = required(entry.parts[0]);
    const entries = [
      {
        ...entry,
        parts: [tools, { ...tools, part: "source" as const, documentSource: true, operations: [] }]
      }
    ];
    const ambiguous = await run(["connection", "init", "books", "--from", entry.id], entries);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain("choose --part tools or --part source");
    const source = await run(
      ["connection", "init", "files", "--from", entry.id, "--part", "source"],
      entries
    );
    expect(source.code, source.err).toBe(0);
    expect(
      parseYaml(await readFile(join(source.root, "connections/files/connection.yaml"), "utf8"))
    ).toMatchObject({
      catalogue: { entry: entry.id, part: "source", version: entry.version },
      operations: []
    });
  });

  it("refuses unknown entries, unoffered entries and unavailable parts without writing a file", async () => {
    for (const [from, part, entries, message] of [
      ["unknown", "tools", catalogue.entries, "Unknown catalogue entry 'unknown'"],
      [
        "sample-accounting",
        "tools",
        catalogue.entries.map((entry) => ({ ...entry, offered: false })),
        "not offered by this instance"
      ],
      ["sample-accounting", "source", catalogue.entries, "the 'source' part is not offered"]
    ] as const) {
      const result = await run(
        ["connection", "init", "books", "--from", from, "--part", part],
        entries
      );
      expect(result.code).toBe(1);
      expect(result.err).toContain(message);
      await expect(stat(join(result.root, "connections"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  });

  it("lists entries including whether they are offered, and supports JSON", async () => {
    const result = await run(["catalogue", "list"]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("sample-accounting\toffered\ttools");
    const json = await run(["catalogue", "list", "--json"]);
    expect(JSON.parse(json.out)).toEqual(catalogue.entries);
  });

  it("rejects invalid arguments before contacting the instance and has offline help", async () => {
    for (const args of [
      ["connection", "init", "books"],
      ["connection", "init", "../escape", "--from", "sample-accounting"],
      ["connection", "init", "books", "--from", "sample-accounting", "--part", "bad"],
      ["connection", "init", "books", "--unknown"],
      ["catalogue", "list", "extra"]
    ]) {
      const result = await run(args);
      expect(result.code, result.err).toBe(2);
      expect(result.fetchImpl).not.toHaveBeenCalled();
    }
    const help = await run(["connection", "init", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("--from <entry>");
    expect(help.fetchImpl).not.toHaveBeenCalled();
  });
});
