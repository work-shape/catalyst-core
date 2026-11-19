import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { toolAssetConfigSchema } from "@work-shape/catalyst-core";
import { runCli, type CliRuntimeOptions } from "@work-shape/catalyst-cli";

// A code tool as a folder (TOOL-2d, platform-access.md, section 3a): `catalyst tool put`
// derives the input schema and the description from the handler on this computer, and `catalyst
// tool run` runs the handler as the sandbox does, its Connection calls sent to the instance.
// The instance is stubbed here; tool-sdk-e2e.test.ts writes and calls a tool on a real one.

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function folderOf(files: Record<string, string>): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "tool-sdk-folder-"));
  directories.push(folder);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), content);
  }
  return folder;
}

/** A TypeScript tool's folder, with the SDK and Zod installed as a workspace links them. */
async function typescriptFolder(files: Record<string, string>): Promise<string> {
  const folder = await folderOf(files);
  const sdk = join(repository, "packages/tool-sdk");
  await mkdir(join(folder, "node_modules/@work-shape"), { recursive: true });
  await symlink(sdk, join(folder, "node_modules/@work-shape/catalyst-tool-sdk"), "dir");
  await symlink(
    await realpath(join(sdk, "node_modules/zod")),
    join(folder, "node_modules/zod"),
    "dir"
  );
  return folder;
}

/** What the stubbed instance is asked, and how it answers. */
function instance(answer: (request: Request, body: unknown) => Response) {
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
    return answer(request, body);
  };
  return { fetchImpl, received };
}

async function run(args: string[], options: CliRuntimeOptions = {}) {
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

/** A stubbed instance that has no such tool yet and takes the write as revision 1. */
function freshInstance() {
  return instance((request) => {
    if (request.method === "GET") {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "No such asset" } },
        { status: 404 }
      );
    }
    return Response.json({ version: 1, revision: 1, warnings: [] });
  });
}

const toolPath = (name: string) =>
  apiOperations["assets.put"].buildPath({ params: { kind: "tool", name } });
const triesPath = apiOperations["connections.try_call"].buildPath({
  params: { name: "crm", operation: "search" }
});

const putBodySchema = z.object({
  config: toolAssetConfigSchema,
  expectedRevision: z.number().nullable()
});

const PYTHON_TOOL = `
from dataclasses import dataclass, field
from typing import List, Literal, Optional, TypedDict
from catalyst_tools import tool


class Address(TypedDict):
    """Where a contact lives."""
    city: str
    zip_code: str


@dataclass
class Window:
    """A span of days."""
    days: int = field(default=7, metadata={"description": "How many days back"})


@tool
def find_contact(
    ctx,
    query: str,
    kinds: List[Literal["person", "company"]],
    limit: int = 5,
    score: float = 0.5,
    exact: bool = False,
    address: Optional[Address] = None,
    window: Optional[Window] = None,
):
    """Finds contacts by name in the CRM.

    Answers at most \`limit\` contacts.

    Args:
        query: The name or part of it.
        kinds: Which contacts to look at.
        limit: How many to answer.
        score: The least match score,
            from 0 to 1.
    """
    ctx.log("looking for", query)
    found = ctx.connection("crm").call("search", {"q": query})
    ctx.display.data("contact_list", {"items": found}, "Contacts")
    return {"query": query, "limit": limit, "window": window, "address": address, "found": found}
`;

describe("catalyst tool put <folder>", () => {
  it("derives a Python tool's input schema from its type hints and its description from its docstring", async () => {
    const folder = await folderOf({
      "tool.yaml": [
        "title: Find contact",
        "summary: Looks up contacts in the CRM",
        "icon: users",
        "connections: [crm.search]",
        "timeout: 20",
        ""
      ].join("\n"),
      "main.py": PYTHON_TOOL,
      "helpers/__init__.py": "",
      "__pycache__/main.cpython-313.pyc": "cached",
      ".env": "SECRET=1"
    });
    const { fetchImpl, received } = freshInstance();
    const result = await run(["tool", "put", folder], { fetchImpl });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Wrote tool 'find_contact' as revision 1");
    expect(result.out).toContain("catalyst tool publish find_contact --revision 1");

    const put = received.find(
      (request) => request.path === toolPath("find_contact") && request.body !== undefined
    );
    const { config, expectedRevision } = putBodySchema.parse(put?.body);
    expect(expectedRevision).toBeNull();
    expect(config).toMatchObject({
      type: "code",
      name: "find_contact",
      title: "Find contact",
      summary: "Looks up contacts in the CRM",
      icon: "users",
      description: "Finds contacts by name in the CRM.\n\nAnswers at most `limit` contacts.",
      runtime: "python",
      entry: "main.py",
      timeoutSeconds: 20,
      connections: ["connection.crm.search"]
    });
    expect(config.type === "code" && config.files.map((file) => file.path)).toEqual([
      "helpers/__init__.py",
      "main.py"
    ]);
    expect(config.input).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "The name or part of it." },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["person", "company"] },
          description: "Which contacts to look at."
        },
        limit: { type: "integer", description: "How many to answer.", default: 5 },
        score: { type: "number", description: "The least match score, from 0 to 1.", default: 0.5 },
        exact: { type: "boolean", default: false },
        address: {
          type: ["object", "null"],
          properties: { city: { type: "string" }, zip_code: { type: "string" } },
          required: ["city", "zip_code"],
          additionalProperties: false
        },
        window: {
          type: ["object", "null"],
          properties: {
            days: { type: "integer", description: "How many days back", default: 7 }
          },
          additionalProperties: false
        }
      },
      required: ["query", "kinds"],
      additionalProperties: false
    });
  });

  it("bundles a TypeScript defineTool into one ES module, its own fields over tool.yaml", async () => {
    const folder = await typescriptFolder({
      "tool.yaml":
        "name: other_name\ntitle: From the file\nsummary: Adds numbers\nconnections: [crm.search]\n",
      "index.ts": SUM_TOOL,
      "add.ts": "export const add = (a: number, b: number): number => a + b;\n"
    });
    const { fetchImpl, received } = freshInstance();
    const result = await run(["tool", "put", folder], { fetchImpl });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const put = received.find(
      (request) => request.path === toolPath("sum_numbers") && request.body !== undefined
    );
    const { config } = putBodySchema.parse(put?.body);
    expect(config).toMatchObject({
      type: "code",
      name: "sum_numbers",
      title: "Sum numbers",
      summary: "Adds numbers",
      description: "Adds the numbers given.",
      runtime: "node",
      entry: "tool.mjs",
      connections: ["connection.crm.search"],
      input: {
        type: "object",
        properties: { numbers: { type: "array", items: { type: "number" } } },
        required: ["numbers"]
      }
    });
    if (config.type !== "code") throw new Error("A code tool");
    expect(config.files).toHaveLength(1);
    const bundle = config.files[0]?.content ?? "";
    // One module: the handler, its own files and the SDK, with the library left to the sandbox.
    expect(bundle).toMatch(/from\s*"catalyst-tools"/u);
    expect(bundle).not.toMatch(/from\s*"(?:zod|\.\/add|@work-shape)/u);
  });

  it("refuses a folder without tool.yaml and sends nothing", async () => {
    const folder = await folderOf({ "main.py": PYTHON_TOOL });
    const { fetchImpl, received } = freshInstance();
    const result = await run(["tool", "put", folder], { fetchImpl });
    expect(result.code).toBe(1);
    expect(result.err).toContain("holds no tool.yaml");
    expect(received).toEqual([]);
  });
});

const SUM_TOOL = `
import { z } from "zod";
import { defineTool } from "@work-shape/catalyst-tool-sdk/code";
import { add } from "./add";

export default defineTool({
  name: "sum_numbers",
  title: "Sum numbers",
  description: "Adds the numbers given.",
  effect: "reading",
  inputSchema: z.object({ numbers: z.array(z.number()) }),
  async execute(input, ctx) {
    ctx.log("summing", input.numbers.length);
    const looked = await ctx.connection("crm").call("search", { q: "sum" });
    ctx.display.html("<b>" + input.numbers.join(" + ") + "</b>", "Sum");
    let refused = "";
    try {
      await ctx.connection("mail").call("send", {});
    } catch (error) {
      refused = (error as { code?: string }).code ?? "";
    }
    return { sum: input.numbers.reduce(add, 0), looked, refused };
  }
});
`;

const answerSchema = z.object({
  output: z.unknown(),
  display: z.looseObject({ type: z.string() }).optional()
});

/** A stubbed instance whose Connection calls answer from the test credential. */
function connectionInstance(target: "test" | "dry_run") {
  return instance((request, body) => {
    const { pathname } = new URL(request.url);
    if (pathname === triesPath) {
      return Response.json({
        target,
        output: target === "dry_run" ? null : { found: [{ name: "Ada" }], asked: body }
      });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "No" } }, { status: 404 });
  });
}

describe("catalyst tool run <folder>", () => {
  it("runs a Python handler locally, its Connection calls sent to the instance as draft calls", async () => {
    const folder = await folderOf({
      "tool.yaml": "connections: [connection.crm.search]\n",
      "main.py": PYTHON_TOOL
    });
    const { fetchImpl, received } = connectionInstance("test");
    const result = await run(
      ["tool", "run", folder, "--input", '{"query":"Ada","kinds":["person"],"window":{"days":3}}'],
      { fetchImpl }
    );
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual({
      query: "Ada",
      limit: 5,
      window: { days: 3 },
      address: null,
      found: { found: [{ name: "Ada" }], asked: { input: { q: "Ada" } } }
    });
    expect(received.map((request) => request.path)).toEqual([triesPath]);
    expect(result.err).toContain("looking for Ada");
    const page = /open (\S+display\.html)/u.exec(result.err)?.[1];
    expect(page).toBeDefined();
    const html = await readFile(page ?? "", "utf8");
    expect(html).toContain("contact_list");
    expect(html).toContain("Contacts");
    await rm(dirname(page ?? ""), { recursive: true, force: true });
  });

  it("runs a TypeScript tool from its source and refuses an operation it does not declare", async () => {
    const folder = await typescriptFolder({
      "tool.yaml": "connections: [crm.search]\n",
      "index.ts": SUM_TOOL,
      "add.ts": "export const add = (a: number, b: number): number => a + b;\n"
    });
    const { fetchImpl, received } = connectionInstance("dry_run");
    const result = await run(["tool", "run", folder, "--input", '{"numbers":[1,2,3]}', "--json"], {
      fetchImpl
    });
    expect(result.code, result.err).toBe(0);
    const answer = answerSchema.parse(JSON.parse(result.out));
    expect(answer.output).toEqual({ sum: 6, looked: null, refused: "connection_not_declared" });
    expect(answer.display).toEqual({ type: "html", title: "Sum", html: "<b>1 + 2 + 3</b>" });
    // Only the declared operation reached the instance.
    expect(received).toHaveLength(1);
    const page = /open (\S+display\.html)/u.exec(result.err)?.[1];
    expect(await readFile(page ?? "", "utf8")).toBe("<b>1 + 2 + 3</b>");
    await rm(dirname(page ?? ""), { recursive: true, force: true });
  });

  it("fails where the input does not fit the tool's schema, and calls nothing", async () => {
    const folder = await typescriptFolder({
      "tool.yaml": "connections: [crm.search]\n",
      "index.ts": SUM_TOOL,
      "add.ts": "export const add = (a: number, b: number): number => a + b;\n"
    });
    const { fetchImpl, received } = connectionInstance("test");
    const result = await run(["tool", "run", folder, "--input", '{"numbers":"x"}'], {
      fetchImpl
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("does not fit the tool's schema");
    expect(result.err).toContain("The handler failed");
    expect(received).toEqual([]);
  });
});
