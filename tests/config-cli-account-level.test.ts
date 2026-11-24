import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  apiOperations,
  MAX_LIST_LIMIT,
  type ApiOperationName
} from "@work-shape/catalyst-api-contract";
import { runCli, type CliRuntimeOptions } from "@work-shape/catalyst-cli";

// CLI-PARITY-5: the commands of a key's account and workspaces level. Each command calls its one
// operation with the path, query and body it names; the rights stay in the instance, whose
// refusal reaches the person as it came.

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function run(args: string[], options: CliRuntimeOptions & { cwd?: string } = {}) {
  const cwd = options.cwd ?? (await mkdtemp(join(tmpdir(), "cli-account-level-")));
  directories.push(cwd);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args, "--instance", "https://catalyst.test"], {
    env: { CATALYST_API_KEY: "test-cli-key" },
    stdin: Readable.from([]),
    ...options,
    cwd,
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
const user = {
  id: "kai",
  externalUserId: "kai",
  displayLabel: "Kai",
  roles: [],
  permissionRefs: [],
  permissions: [],
  clientInstanceId: "demo",
  authSource: "password"
};
const preference = { modelBindingId: "fast", reasoningEfforts: { fast: "low" } };
const key = {
  id: "key-1",
  ownerUserId: "kai",
  name: "laptop",
  keyPrefix: "cat_abc",
  scopes: ["account.manage"],
  createdAt: at,
  expiresAt: at,
  revokedAt: at
};
const workspace = {
  id: "ws-1",
  clientInstanceId: "demo",
  kind: "shared",
  name: "Finance",
  description: null,
  visibility: "discoverable",
  defaultConversationVisibility: "workspace",
  emoji: null,
  accentColor: null,
  personalUserId: null,
  createdAt: at,
  updatedAt: at,
  role: "owner",
  membershipRole: "owner",
  pendingAccessRequestCount: 0
};
const membership = {
  collaborationWorkspaceId: "ws-1",
  clientInstanceId: "demo",
  userId: "lena",
  role: "member",
  createdAt: at,
  updatedAt: at
};

interface CommandCase {
  args: string[];
  operation: ApiOperationName;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  response: unknown;
  /** What `--json` prints, where it is not the answer as it came: a list prints its items. */
  printed?: unknown;
}

const page = <T>(item: T) => ({ response: { items: [item] }, printed: [item] });
const listed = { limit: String(MAX_LIST_LIMIT) };

const cases: CommandCase[] = [
  {
    args: ["me", "update", "--name", "Kai Neu", "--locale", "de"],
    operation: "me.update",
    body: { displayLabel: "Kai Neu", locale: "de" },
    response: { ...user, displayLabel: "Kai Neu", locale: "de" }
  },
  {
    args: ["keys", "revoke", "key-1"],
    operation: "me.api_keys.revoke",
    params: { keyId: "key-1" },
    response: key
  },
  { args: ["workspace", "list"], operation: "workspaces.list", query: listed, ...page(workspace) },
  {
    args: ["workspace", "delete", "ws-1", "--confirm-name", "Finance"],
    operation: "workspaces.delete",
    params: { collaborationWorkspaceId: "ws-1" },
    body: { confirmName: "Finance" },
    response: { state: "deleting" }
  },
  {
    args: ["workspace", "members", "candidates", "ws-1", "--search", "le"],
    operation: "workspaces.member_candidates.list",
    params: { collaborationWorkspaceId: "ws-1" },
    query: { ...listed, q: "le" },
    ...page({
      userId: "lena",
      displayLabel: "Lena",
      email: "lena@example.test",
      hasPendingAccessRequest: false
    })
  },
  {
    args: ["workspace", "members", "role", "ws-1", "lena", "--role", "admin"],
    operation: "workspaces.members.update_role",
    params: { collaborationWorkspaceId: "ws-1", userId: "lena" },
    body: { role: "admin" },
    response: { ...membership, role: "admin" }
  }
];

/** The operation scope a key needs for the operation, where it is not the operation's own. */
function personalKeyScopeOf(name: ApiOperationName): unknown {
  const operation = apiOperations[name];
  return "personalKeyScope" in operation ? operation.personalKeyScope : undefined;
}

/** What a key without the level is refused, and the level's text the refusal names. */
function keyRefusal(operation: ApiOperationName) {
  const action =
    personalKeyScopeOf(operation) === "workspaces:manage"
      ? "collaboration_workspace.manage"
      : "account.manage";
  return {
    action,
    response: Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: `The API key of this call does not carry the account and workspaces level, which '${operation}' needs: its scopes must name '${action}'.`,
          correlationId: "corr-x",
          details: { action, reason: "outside_key_scope" }
        }
      },
      { status: 403 }
    )
  };
}

describe("the commands of a key's account and workspaces level", () => {
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
      else expect(result.out.trimStart()).not.toMatch(/^[{[]/u);
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(request.method).toBe(operation.method);
      expect(url.pathname).toBe(operation.buildPath({ params: entry.params ?? {} }));
      expect(Object.fromEntries(url.searchParams)).toEqual(entry.query ?? {});
      expect(request.headers.get("authorization")).toBe("Bearer test-access-token");
      const text = await request.text();
      if (entry.body === undefined) expect(text === "" ? undefined : JSON.parse(text)).toBeFalsy();
      else expect(JSON.parse(text)).toEqual(entry.body);
    }
  });

  it("sets a flag over the file's field for me update", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-account-level-"));
    await writeFile(join(cwd, "me.json"), JSON.stringify({ displayLabel: "Old", locale: "en" }));
    let body: unknown;
    const result = await run(["me", "update", "--from", "me.json", "--name", "Kai"], {
      cwd,
      fetchImpl: apiFetch(async (request) => {
        body = await request.json();
        return Response.json(user);
      })
    });
    expect(result.code, result.err).toBe(0);
    expect(body).toEqual({ displayLabel: "Kai", locale: "en" });
  });

  it("sends the model preference from a file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cli-account-level-"));
    await writeFile(join(cwd, "preference.json"), JSON.stringify(preference));
    let request: Request | undefined;
    const result = await run(["me", "set-model-preference", "--from", "preference.json"], {
      cwd,
      fetchImpl: apiFetch((answer) => {
        request = answer;
        return Response.json(preference);
      })
    });
    expect(result.code, result.err).toBe(0);
    expect(request?.method).toBe("PUT");
    expect(await request?.json()).toEqual(preference);
  });

  it.each(
    cases
      .filter((entry) =>
        ["me.api_keys.revoke", "workspaces.members.update_role"].includes(entry.operation)
      )
      .map((entry) => [entry.args.join(" "), entry] as const)
  )("%s: a key without the level is refused with the right named, exit 1", async (_name, entry) => {
    const { action, response } = keyRefusal(entry.operation);
    for (const json of [false, true]) {
      const result = await run([...entry.args, ...(json ? ["--json"] : [])], {
        fetchImpl: apiFetch(() => response.clone())
      });
      expect(result.code).toBe(1);
      expect(result.out).toBe("");
      expect(result.err).toContain(action);
      expect(result.err).toContain("account and workspaces level");
    }
  });

  it("passes the workspace's own refusal of a member change through, exit 1", async () => {
    const result = await run(["workspace", "members", "role", "ws-1", "lena", "--role", "owner"], {
      fetchImpl: apiFetch(() =>
        Response.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Only an Owner can make someone an Owner.",
              correlationId: "corr-y"
            }
          },
          { status: 403 }
        )
      )
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("Only an Owner can make someone an Owner.");
  });

  it.each([
    ["a missing workspace", ["workspace", "show"]],
    ["a missing key", ["keys", "revoke"]],
    ["an unknown role", ["workspace", "members", "role", "ws-1", "lena", "--role", "boss"]],
    ["a query flag for a change", ["workspace", "members", "leave", "ws-1", "--search", "x"]]
  ])("exits 2 with the usage for %s and calls nothing", async (_name, args) => {
    let calls = 0;
    const result = await run(args, {
      fetchImpl: apiFetch(() => {
        calls += 1;
        return Response.json({});
      })
    });
    expect(result.code, result.err).toBe(2);
    expect(calls).toBe(0);
  });
});
