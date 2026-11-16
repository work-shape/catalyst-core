import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { runCli, type CliRuntimeOptions } from "@work-shape/catalyst-cli";
import platformContext from "./fixtures/cli-platform-context.json";

// A refusal because the key lacks a right its owner holds (`outside_key_scope`) says why: a key
// carries only the rights ticked when it was issued, so a right given since is missing from it,
// and says how to get a new key. Any other refusal is printed as it came.

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function run(args: string[], options: CliRuntimeOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "cli-key-scope-"));
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

const agentKind = {
  kind: "agent",
  plural: "agents",
  lifecycle: "active",
  representation: "config",
  owners: ["instance", "workspace"],
  actions: {
    read: "agent.read",
    write: "agent.write",
    delete: "agent.delete",
    publish: "agent.publish"
  }
};

function refusing(details: Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === apiOperations["access_tokens.exchange"].path) {
      return Response.json({
        accessToken: "test-access-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }
    if (path === apiOperations["platform.context.get"].path) {
      return Response.json({ ...platformContext, kinds: [agentKind] });
    }
    return Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "The API key of this call does not cover 'agent.publish' here",
          correlationId: "corr-x",
          details
        }
      },
      { status: 403 }
    );
  };
}

const NEW_KEY = "Run 'catalyst login' and confirm a new key with the right ticked";

describe("a refusal for a right the key does not carry", () => {
  it("says the key was issued without the right and how to get a new key", async () => {
    const outside = refusing({ action: "agent.publish", reason: "outside_key_scope" });
    const published = await run(["agent", "publish", "helper", "--revision", "2"], {
      fetchImpl: outside
    });
    expect(published.code).toBe(1);
    expect(published.err).toContain(
      "Your account holds the right 'agent.publish', but this API key does not carry it"
    );
    expect(published.err).toContain("a right you were given after that is missing from it");
    expect(published.err).toContain(NEW_KEY);
    expect(published.err).toContain("CATALYST_API_KEY");
    // Said once, not again by the hint of an agent's publish.
    expect(published.err.split(NEW_KEY)).toHaveLength(2);

    const listed = await run(["jobs", "summary"], { fetchImpl: outside });
    expect(listed.code).toBe(1);
    expect(listed.err).toContain(NEW_KEY);
  });

  it("adds nothing to a refusal for a right the account does not hold", async () => {
    const result = await run(["jobs", "summary"], {
      fetchImpl: refusing({ action: "system.view", reason: "no_grant" })
    });
    expect(result.code).toBe(1);
    expect(result.err).not.toContain("catalyst login");
  });
});
