import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations, MAX_LIST_LIMIT, type ApiOperationName } from "@vivd-catalyst/api-contract";
import { runCli, type CliRuntimeOptions } from "@work-shape/catalyst-cli";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function run(args: string[], options: CliRuntimeOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "cli-named-"));
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
const workflowRun = {
  id: "run-1",
  workflow: "month-end",
  definitionRevisionId: "revision-1",
  mode: "test",
  trigger: "manual",
  status: "queued",
  principal: { id: "principal-1", name: "processor", displayLabel: "Processor" },
  startedBy: { kind: "user", id: "kai", label: "Kai" },
  stepRunCount: 0,
  deadlineAt: at,
  createdAt: at
};
const stepRun = {
  id: "step-1",
  runId: "run-1",
  stepId: "read",
  stepType: "operation",
  key: "read",
  status: "done",
  attempt: 1,
  createdAt: at
};

interface CommandCase {
  args: string[];
  operation: ApiOperationName;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  response: unknown;
  items?: unknown[];
}

const cases: CommandCase[] = [
  {
    args: ["workflow", "test", "month-end"],
    operation: "workflows.test",
    params: { workflow: "month-end" },
    body: {},
    response: workflowRun
  },
  {
    args: ["workflow", "runs", "month-end"],
    operation: "workflows.list_runs",
    params: { workflow: "month-end" },
    response: { items: [workflowRun], hasMore: false },
    items: [workflowRun]
  },
  {
    args: ["workflow", "run", "run-1"],
    operation: "workflows.get_run",
    params: { runId: "run-1" },
    response: workflowRun
  },
  {
    args: ["workflow", "steps", "run-1"],
    operation: "workflows.list_step_runs",
    params: { runId: "run-1" },
    response: { items: [stepRun], hasMore: false },
    items: [stepRun]
  },
  {
    args: ["workflow", "cancel", "run-1"],
    operation: "workflows.cancel_run",
    params: { runId: "run-1" },
    response: { ...workflowRun, status: "cancelled" }
  },
  {
    args: ["guardrail", "hits", "iban-check"],
    operation: "guardrails.list_hits",
    params: { name: "iban-check" },
    response: {
      items: [
        {
          id: "hit-1",
          event: "asset.before_write",
          outcome: "block",
          message: "Found IBAN",
          subjectKind: "skill",
          createdAt: at
        }
      ],
      hasMore: false,
      counts: { last7Days: 1, last30Days: 1 }
    }
  },
  {
    args: ["knowledge-base", "check", "accounts"],
    operation: "knowledge_bases.check",
    params: { knowledgeBase: "accounts" },
    response: {
      id: "kb-1",
      name: "accounts",
      status: "ok",
      checkedAt: at,
      tables: [{ name: "bookings", readable: true }]
    }
  },
  {
    args: ["data-store", "describe", "reporting"],
    operation: "data_stores.describe",
    params: { store: "reporting" },
    response: {
      schemaLevel: 1,
      tables: [
        {
          name: "bookings",
          rowEstimate: 10,
          columns: [
            { name: "id", type: "integer", nativeType: "int4", nullable: false, primaryKey: true }
          ]
        }
      ]
    }
  },
  {
    args: ["data-store", "used-by", "reporting"],
    operation: "data_stores.used_by",
    params: { store: "reporting" },
    response: {
      apps: [{ id: "app-1", name: "offers", title: "Offers" }],
      workflows: [],
      hidden: { apps: 2, workflows: 0 },
      truncated: false
    }
  },
  {
    args: ["app", "actions", "offers"],
    operation: "apps.actions.list",
    query: { app: "offers" },
    response: {
      apps: [{ name: "offers", title: "Offers", view: "published", revision: 1, actions: [] }],
      truncated: false
    }
  },
  {
    args: ["keys", "list"],
    operation: "me.api_keys.list",
    response: {
      items: [
        {
          id: "key-1",
          ownerUserId: "kai",
          name: "CLI",
          keyPrefix: "cat_prefix",
          scopes: ["agent.read"],
          createdAt: at,
          expiresAt: at
        }
      ],
      hasMore: false
    },
    items: [
      {
        id: "key-1",
        ownerUserId: "kai",
        name: "CLI",
        keyPrefix: "cat_prefix",
        scopes: ["agent.read"],
        createdAt: at,
        expiresAt: at
      }
    ]
  },
  {
    args: ["instance", "workspaces"],
    operation: "instance.workspaces.list",
    response: { items: [{ id: "workspace-1", name: "Team", createdAt: at }], hasMore: false },
    items: [{ id: "workspace-1", name: "Team", createdAt: at }]
  }
];

describe("named CLI operation faces", () => {
  it("reserves workspace list and lists the instance command in help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("instance workspaces (instance.workspaces.list)");
    expect(result.out).not.toContain("workspace list");
  });

  it.each(cases)("$args calls $operation with readable output and --json", async (entry) => {
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
      if (json) expect(JSON.parse(result.out)).toEqual(entry.items ?? entry.response);
      else {
        expect(result.out).toContain(": ");
        expect(result.out.trimStart()).not.toMatch(/^[{[]/u);
      }
    }
    // No context/kind discovery or new endpoint: each face makes exactly its operation call.
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(request.method).toBe(operation.method);
      expect(url.pathname).toBe(operation.buildPath({ params: entry.params }));
      expect(Object.fromEntries(url.searchParams)).toEqual(
        entry.items ? { limit: String(MAX_LIST_LIMIT) } : (entry.query ?? {})
      );
      expect(request.headers.get("authorization")).toBe("Bearer test-access-token");
      expect(Boolean(request.headers.get("idempotency-key"))).toBe(operation.effect === "changing");
      expect(await request.text()).toBe(entry.body === undefined ? "" : JSON.stringify(entry.body));
    }
  });

  it("reads workflow test input from a file or explicit stdin before calling the operation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-test-input-"));
    directories.push(cwd);
    const input = { input: { month: "2026-10" } };
    await writeFile(join(cwd, "input.json"), JSON.stringify(input));
    const bodies: unknown[] = [];
    const fetchImpl = apiFetch(async (request) => {
      bodies.push(await request.json());
      return Response.json(workflowRun);
    });
    for (const source of ["input.json", "-"]) {
      expect(
        (
          await run(["workflow", "test", "month-end", "--from", source], {
            cwd,
            stdin: Readable.from([JSON.stringify(input)]),
            fetchImpl
          })
        ).code
      ).toBe(0);
    }
    expect(bodies).toEqual([input, input]);
  });

  it("lists every published App's actions when no name is given", async () => {
    let query: string | undefined;
    const result = await run(["app", "actions", "--json"], {
      fetchImpl: apiFetch((request) => {
        query = new URL(request.url).search;
        return Response.json({ apps: [], truncated: false });
      })
    });
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ apps: [], truncated: false });
    expect(query).toBe("");
  });

  it.each(cases.filter((entry) => entry.items !== undefined))(
    "$args reads all pages",
    async (entry) => {
      const cursors: (string | null)[] = [];
      const result = await run([...entry.args, "--json"], {
        fetchImpl: apiFetch((request) => {
          cursors.push(new URL(request.url).searchParams.get("cursor"));
          return Response.json({
            items: entry.items,
            hasMore: cursors.length === 1,
            ...(cursors.length === 1 ? { nextCursor: "next-page" } : {})
          });
        })
      });
      expect(result.code, result.err).toBe(0);
      expect(cursors).toEqual([null, "next-page"]);
      expect(JSON.parse(result.out)).toEqual([...(entry.items ?? []), ...(entry.items ?? [])]);
    }
  );

  it.each(cases)(
    "$args rejects missing/extra arguments and unsupported flags before contacting the instance",
    async (entry) => {
      const fetchImpl = vi.fn<typeof fetch>();
      const invalid = entry.params ? entry.args.slice(0, 2) : [...entry.args, "extra", "extra"];
      for (const args of [
        invalid,
        [...entry.args, "--workspace", "workspace-1"],
        [...entry.args, "--unexpected"]
      ]) {
        expect((await run(args, { fetchImpl })).code).toBe(2);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it("reports a missing workflow input file as a file error before sending anything", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await run(["workflow", "test", "month-end", "--from", "missing.json"], {
      fetchImpl
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("ENOENT");
    expect(result.err).toContain("missing.json");
    expect(result.err).not.toContain("must be a JSON object");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed workflow input before sending anything", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const input of ["invalid JSON", "[]", '{"input": []}']) {
      expect(
        (
          await run(["workflow", "test", "month-end", "--from", "-"], {
            stdin: Readable.from([input]),
            fetchImpl
          })
        ).code
      ).toBe(2);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints the instance's refusal and exits 1", async () => {
    const result = await run(["instance", "workspaces"], {
      fetchImpl: apiFetch(() =>
        Response.json(
          { error: { code: "FORBIDDEN", message: "Missing the right 'agent.write'" } },
          { status: 403 }
        )
      )
    });
    expect(result).toEqual({
      code: 1,
      out: "",
      err: "Refused by the instance (HTTP 403 FORBIDDEN): Missing the right 'agent.write'\n"
    });
  });

  it("returns 3 for a held change in both output modes without claiming it ran", async () => {
    const pending = {
      id: "operation-run-1",
      operation: "workflows.test",
      effect: "changing",
      status: "pending_approval",
      actor: { kind: "user", id: "kai", label: "Kai" },
      origin: { kind: "cli" },
      target: "live",
      inputHash: "hash",
      attempt: 1,
      correlationId: "correlation",
      createdAt: at,
      href: apiOperations["operations.get_run"].buildPath({ params: { runId: "operation-run-1" } })
    };
    const fetchImpl = apiFetch(() => Response.json(pending, { status: 202 }));
    const human = await run(["workflow", "test", "month-end"], { fetchImpl });
    expect(human).toEqual({
      code: 3,
      out: "",
      err: "Waits for an approval on the instance; nothing has changed yet (Operation Run operation-run-1).\n"
    });
    const json = await run(["workflow", "test", "month-end", "--json"], { fetchImpl });
    expect(json.code, json.err).toBe(3);
    expect(JSON.parse(json.out)).toEqual({ status: "pending_approval", run: pending });
  });
});
