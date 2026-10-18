import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { runCli, type CliRuntimeOptions } from "@work-shape/catalyst-cli";
import platformContext from "./fixtures/cli-platform-context.json";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const sources = {
  revision: 7,
  audience: {
    workspace: { title: "Kai Spezis", members: 14 },
    holders: [],
    hiddenHolders: 2
  },
  stores: [
    {
      name: "customers",
      title: "Kunden",
      actions: ["list_customers"],
      rows: { estimate: 312, tables: 1, measuredAt: "2026-10-18T00:00:00.000Z" },
      fillers: [
        { kind: "workflow", name: "nightly", title: "Nachtimport", connections: ["Exampledata"] }
      ]
    }
  ],
  truncated: false
};

async function publish(options: { json?: boolean; response?: unknown; status?: number } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "cli-app-data-"));
  directories.push(cwd);
  const requests: Request[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    switch (url.pathname) {
      case apiOperations["access_tokens.exchange"].path:
        return Response.json({
          accessToken: "test-access-token",
          expiresAt: "2099-01-01T00:00:00Z"
        });
      case apiOperations["platform.context.get"].path:
        return Response.json(platformContext);
      case apiOperations["assets.get"].path.replace(":kind", "app").replace(":name", "report"):
        return Response.json({
          id: "app-report",
          kind: "app",
          name: "report",
          scope: { kind: "workspace", workspaceId: "w1" },
          revision: 9,
          draftRevision: 9,
          contentRevision: 7,
          config: {
            manifest: {
              actions: [
                { name: "list_customers", kind: "sql", effect: "reading", dataStore: "customers" }
              ]
            }
          },
          updatedAt: "2026-10-18T00:00:00.000Z"
        });
      case apiOperations["data_stores.app_sources"].path:
        return Response.json(options.response ?? sources, { status: options.status ?? 200 });
      default:
        throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    }
  };
  const runtime: CliRuntimeOptions = {
    cwd,
    env: { CATALYST_API_KEY: "test-cli-key" },
    fetchImpl,
    prompt: async (question) => {
      questions.push(question);
      return "n";
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text)
  };
  const code = await runCli(
    [
      "app",
      "publish",
      "report",
      "--workspace",
      "w1",
      "--revision",
      "7",
      "--instance",
      "https://catalyst.test",
      ...(options.json ? ["--json"] : [])
    ],
    runtime
  );
  return { code, out: out.join(""), err: err.join(""), questions, requests };
}

describe("the App publish question's stored data", () => {
  it.each([false, true])(
    "shows the selected revision's audience and sources before asking (json=%s)",
    async (json) => {
      const result = await publish({ json });
      expect(result.code, result.err).toBe(1);
      const review = json ? result.err : result.out;
      expect(review).toContain("Everyone in Kai Spezis (14 people)");
      expect(review).toContain("2 additional grant holders (not a count of people)");
      expect(review).toContain("Kunden: list_customers");
      expect(review).toContain("Whole store: about 312 rows in 1 table");
      expect(review).toContain("not the number these actions select");
      expect(review).toContain("Copied by Workflow Nachtimport from Exampledata");
      expect(review).toContain("checked against the publisher, not each viewer");
      expect(result.questions).toHaveLength(1);
      const request = result.requests.find(
        (request) => new URL(request.url).pathname === apiOperations["data_stores.app_sources"].path
      );
      expect(request && new URL(request.url).searchParams.get("revision")).toBe("7");
      expect(result.requests.some((request) => request.url.includes("/publish"))).toBe(false);
      if (json) expect(result.out).toBe("");
    }
  );

  it("says a store the App may not reach is not available, and tells nothing more of it", async () => {
    const result = await publish({
      response: {
        ...sources,
        stores: [{ name: "lohn", title: "lohn", unavailable: true, fillers: [], actions: ["peek"] }]
      }
    });
    expect(result.out).toContain("lohn: peek.");
    expect(result.out).toContain("No Data Store of this name is available to the App");
    expect(result.out).not.toContain("Whole store");
  });

  it.each([
    { response: { ...sources, revision: 9 } },
    { response: { error: { code: "FORBIDDEN", message: "App is not available" } }, status: 403 }
  ])(
    "asks nothing and publishes nothing when its disclosure is unavailable or mismatched",
    async (options) => {
      const result = await publish(options);
      expect(result.code).toBe(1);
      expect(result.questions).toEqual([]);
      expect(result.requests.some((request) => request.url.includes("/publish"))).toBe(false);
    }
  );
});
