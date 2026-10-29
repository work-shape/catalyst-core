import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { apiOperations, type ApiOperationName } from "@work-shape/catalyst-api-contract";
import { runCli, type CliRuntimeOptions } from "@work-shape/catalyst-cli";

// CLI-PARITY-6a: the read-only commands of a key's instance level. Each command calls its one
// read operation and nothing else; a key without the level is refused by the instance and the
// refusal reaches the person as it came, naming the right.

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function run(args: string[], options: CliRuntimeOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "cli-instance-read-"));
  directories.push(cwd);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args, "--instance", "https://catalyst.test"], {
    cwd,
    env: { CATALYST_API_KEY: "test-cli-key" },
    stdin: Readable.from([]),
    ...options,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text)
  });
  return { code, out: out.join(""), err: err.join("") };
}

function apiFetch(answer: (request: Request) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === apiOperations["access_tokens.exchange"].path) {
      return Response.json({
        accessToken: "test-access-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }
    return answer(request);
  };
}

const at = "2026-10-15T10:00:00.000Z";
const window = {
  modelCallCount: 2,
  inputTokens: 100,
  cachedInputTokens: 0,
  outputTokens: 50,
  totalTokens: 150,
  webSearchCallCount: 0,
  cost: {
    status: "settled",
    complete: true,
    webSearchCostVisible: false,
    settledModelCallCount: 2,
    incompleteModelCallCount: 0,
    settledWebSearchCallCount: 0,
    incompleteWebSearchCallCount: 0
  }
};
const auditEvent = {
  id: "audit-1",
  clientInstanceId: "demo",
  type: "assets.published",
  status: "success",
  correlationId: "corr-1",
  createdAt: at,
  metadata: { kind: "agent", revision: 3 }
};
const operationRun = {
  id: "run-1",
  operation: "assets.put",
  effect: "changing",
  status: "done",
  actor: { kind: "user", id: "kai", label: "Kai" },
  origin: { kind: "cli" },
  target: "live",
  inputHash: "hash-1",
  attempt: 1,
  correlationId: "corr-1",
  createdAt: at,
  href: apiOperations["operations.get_run"].buildPath({ params: { runId: "run-1" } })
};
const job = {
  id: "job-1",
  kind: "knowledge.sync",
  status: "failed",
  attempts: 3,
  maxAttempts: 3,
  errorCode: "INTERNAL",
  createdAt: at,
  retryable: true
};

/** The nine reads of the level, each with the right it asks of the key and of its owner. */
const RIGHTS = {
  "usage.get_summary": "usage.view",
  "usage.breakdown.get": "usage.view",
  "audit_events.list": "audit.view",
  "audit_activities.list": "audit.view",
  "instance.jobs.summary": "system.view",
  "instance.jobs.list": "system.view",
  "operations.list_runs": "system.view",
  "instance.modules.list": "system.view",
  "instance.infrastructure.get": "system.view"
} as const satisfies Partial<Record<ApiOperationName, string>>;

interface ReadCase {
  args: string[];
  operation: keyof typeof RIGHTS;
  query?: Record<string, string>;
  response: unknown;
  /** What `--json` prints, where the client reads less than the answer says. */
  printed?: unknown;
}

const cases: ReadCase[] = [
  {
    args: ["usage", "show"],
    operation: "usage.get_summary",
    response: {
      generatedAt: at,
      spendBudget: { currency: "EUR", monthlySpentMicros: 1_000_000 },
      safeguards: { modelCallsPerDay: 500 },
      today: window,
      currentMonth: window,
      allTime: window,
      dailyUsage: [{ ...window, date: "2026-10-15" }],
      monthlyUsage: [{ ...window, month: "2026-10" }],
      recentEvents: []
    }
  },
  {
    args: [
      "usage",
      "breakdown",
      "--start",
      "2026-10-01",
      "--end",
      "2026-10-08",
      "--group-by",
      "model",
      "--agent",
      "helper"
    ],
    operation: "usage.breakdown.get",
    query: { from: "2026-10-01", to: "2026-10-08", groupBy: "model", agent: "helper" },
    response: {
      from: "2026-10-01",
      to: "2026-10-08",
      groupBy: "model",
      personalWorkspacesKey: "personal",
      total: window,
      rows: [{ ...window, key: "gpt" }]
    }
  },
  {
    args: ["audit", "events", "--limit", "2", "--cursor", "c1"],
    operation: "audit_events.list",
    query: { limit: "2", cursor: "c1" },
    response: { items: [auditEvent], nextCursor: "c2" }
  },
  {
    args: ["audit", "activities"],
    operation: "audit_activities.list",
    response: {
      items: [
        {
          correlationId: "corr-1",
          at,
          type: "assets.published",
          tier: "governance",
          outcome: "success",
          actor: { kind: "user", label: "Kai" },
          eventCount: 1,
          repeatCount: 0,
          evidence: [auditEvent]
        }
      ]
    }
  },
  {
    args: ["jobs", "summary"],
    operation: "instance.jobs.summary",
    response: { items: [{ kind: "knowledge.sync", queued: 1, running: 0, failed: 2, dead: 0 }] }
  },
  {
    args: ["jobs", "list", "--kind", "knowledge.sync", "--status", "failed,dead", "--limit", "5"],
    operation: "instance.jobs.list",
    query: { kind: "knowledge.sync", status: "failed,dead", limit: "5" },
    response: { items: [job] }
  },
  {
    args: [
      "operation",
      "runs",
      "--operation",
      "assets.put",
      "--effect",
      "changing",
      "--status",
      "done",
      "--actor",
      "kai",
      "--origin",
      "cli",
      "--workspace",
      "ws-1",
      "--since",
      at
    ],
    operation: "operations.list_runs",
    query: {
      operation: "assets.put",
      effect: "changing",
      status: "done",
      actor: "kai",
      origin: "cli",
      workspaceId: "ws-1",
      since: at
    },
    response: { items: [operationRun], nextCursor: "more" }
  },
  {
    args: ["modules", "list"],
    operation: "instance.modules.list",
    response: {
      items: [
        {
          name: "knowledge",
          enabled: true,
          shipped: true,
          configKey: "modules.knowledge",
          requires: [],
          kinds: ["knowledge_base"],
          operationCount: 12,
          jobKinds: ["knowledge.sync"],
          toolCount: 1
        }
      ]
    }
  },
  {
    args: ["infrastructure", "show"],
    operation: "instance.infrastructure.get",
    response: {
      items: [
        {
          id: "database",
          class: "database",
          type: "postgres",
          origin: "operator",
          external: false,
          secrets: [],
          check: { status: "ok", checkedAt: at }
        }
      ],
      checkIntervalSeconds: 60
    }
  }
];

describe("the read commands of a key's instance level", () => {
  it.each(cases)("$args calls $operation and prints it readably and as JSON", async (entry) => {
    const operation = apiOperations[entry.operation];
    const requests: Request[] = [];
    const fetchImpl = apiFetch((request) => {
      requests.push(request);
      return Response.json(entry.response);
    });
    for (const json of [false, true]) {
      const result = await run([...entry.args, ...(json ? ["--json"] : [])], { fetchImpl });
      expect(result.code, result.err).toBe(0);
      expect(result.err).toBe("");
      if (json) expect(JSON.parse(result.out)).toEqual(entry.printed ?? entry.response);
      else {
        expect(result.out).toContain(": ");
        expect(result.out.trimStart()).not.toMatch(/^[{[]/u);
      }
    }
    // Exactly the one read, once per run, even where the answer offers a next page.
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(operation.effect).toBe("reading");
      expect(url.pathname).toBe(operation.buildPath());
      expect(Object.fromEntries(url.searchParams)).toEqual(entry.query ?? {});
      expect(request.headers.get("authorization")).toBe("Bearer test-access-token");
      expect(request.headers.get("idempotency-key")).toBeNull();
      expect(await request.text()).toBe("");
    }
  });

  it("prints one page of a feed with its next cursor and never reads to its end", async () => {
    let calls = 0;
    const result = await run(["audit", "events", "--json"], {
      fetchImpl: apiFetch(() => {
        calls += 1;
        return Response.json({ items: [auditEvent], nextCursor: "next-page" });
      })
    });
    expect(result.code, result.err).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ items: [auditEvent], nextCursor: "next-page" });
  });

  it("prints the governance event as the instance minimized it, with nothing of its own added", async () => {
    const result = await run(["audit", "events", "--json"], {
      fetchImpl: apiFetch(() => Response.json({ items: [auditEvent] }))
    });
    const events = z.object({ items: z.array(z.record(z.string(), z.unknown())) });
    const [event] = events.parse(JSON.parse(result.out)).items;
    expect(Object.keys(event ?? {}).sort()).toEqual(Object.keys(auditEvent).sort());
    const runs = await run(["operation", "runs", "--json"], {
      fetchImpl: apiFetch(() => Response.json({ items: [operationRun] }))
    });
    const [item] = events.parse(JSON.parse(runs.out)).items;
    expect(item).toHaveProperty("inputHash");
    expect(item).not.toHaveProperty("input");
    expect(item).not.toHaveProperty("result");
  });

  it.each(cases.map((entry) => [entry.args.slice(0, 2).join(" "), entry] as const))(
    "%s: a key without the instance level is refused with the right named, exit 1",
    async (_name, entry) => {
      const operation = apiOperations[entry.operation];
      const right = RIGHTS[entry.operation];
      // The command names the right the operation itself asks.
      expect(operation.requires).toEqual([right]);
      const message = `The API key of this call does not carry the instance level, which '${operation.id}' needs: its scopes must name '${right}'. Use a key with the instance level`;
      for (const json of [false, true]) {
        const result = await run([...entry.args, ...(json ? ["--json"] : [])], {
          fetchImpl: apiFetch(() =>
            Response.json(
              {
                error: {
                  code: "FORBIDDEN",
                  message,
                  correlationId: "corr-x",
                  details: { action: right, reason: "outside_key_scope" }
                }
              },
              { status: 403 }
            )
          )
        });
        expect(result.code).toBe(1);
        expect(result.out).toBe("");
        expect(result.err).toContain(right);
        expect(result.err).toContain("instance level");
      }
    }
  );

  it.each([
    ["a flag of another command", ["audit", "events", "--kind", "x"]],
    ["a positional argument", ["modules", "list", "extra"]],
    ["a missing period", ["usage", "breakdown", "--start", "2026-10-01", "--group-by", "model"]],
    ["a missing dimension", ["usage", "breakdown", "--start", "2026-10-01", "--end", "2026-10-02"]],
    ["a body", ["jobs", "list", "--from", "-"]],
    ["a statement", ["usage", "show", "--sql", "select 1"]],
    ["the rows' own flag", ["operation", "runs", "--table", "t"]],
    ["an unknown flag", ["jobs", "summary", "--retry"]]
  ])("exits 2 with the usage for %s and calls nothing", async (_name, args) => {
    let calls = 0;
    const result = await run(args, {
      fetchImpl: apiFetch(() => {
        calls += 1;
        return Response.json({});
      })
    });
    expect(result.code).toBe(2);
    expect(result.err).toContain("Usage: catalyst");
    expect(calls).toBe(0);
  });

  it("lists the commands in help with their operation and says what the key needs", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    for (const entry of cases) {
      expect(result.out).toContain(`(${entry.operation})`);
    }
    expect(result.out).toMatch(/read-only instance\s+level/u);
    expect(result.out).toContain("catalyst setup creates does not carry it");
    // None of the retrying or deciding operations has a command here.
    for (const operation of ["instance.jobs.retry", "operations.decide", "usage.users.list"]) {
      expect(result.out).not.toContain(`(${operation})`);
    }
  });

  it("keeps `operation show` and its bare usage with the asset commands", async () => {
    const bare = await run(["operation"]);
    expect(bare.code).toBe(2);
    expect(bare.err).toContain("catalyst operation show <run-id>");
  });
});
