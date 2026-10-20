import { createTestFetch } from "../support/test-instance";
import { testOperations } from "../support/operations";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  parseAgentYaml,
  readStateFile,
  runConfigCommand,
  serializeAgentYaml
} from "@work-shape/catalyst-cli";
import { applyAtCurrentRevisions } from "../support/asset-revisions";
import {
  createTemporaryDirectory,
  createFixture,
  writeMinimalManifest,
  recordFetch,
  agentConfig,
  jsonResponse,
  emptyInstanceBehind
} from "../support/config-cli";

describe("config CLI command flows", () => {
  it("prefers API-key exchange, then pulls, pushes, and reports a stale asset", async () => {
    const fixture = await createFixture();
    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "assistant",
          config: agentConfig("Remote instructions")
        },
        { type: "setDefaultAgent", agentName: "assistant" }
      ]
    });
    const url = "https://catalyst.test";
    const directory = await createTemporaryDirectory();
    await writeFile(
      resolve(directory, "catalyst.yaml"),
      `# Keep this manifest comment
instances:
  local:
    url: ${url}
defaultInstance: local
defaultAgentName: stale_default
agents:
  - agents/*.agent.yaml
skills:
  - skills/*/SKILL.md
`,
      "utf8"
    );
    const obsoleteAgentPath = resolve(directory, "agents", "obsolete.agent.yaml");
    await mkdir(resolve(directory, "agents"), { recursive: true });
    await writeFile(
      obsoleteAgentPath,
      serializeAgentYaml(agentConfig("Obsolete", { name: "obsolete" })),
      "utf8"
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const commandOptions = {
      cwd: directory,
      env: {
        CATALYST_API_KEY: fixture.apiKey,
        // A server credential in the environment is ignored: the CLI signs in with a key only.
        CATALYST_SERVER_CREDENTIAL: "server-credential"
      },
      fetchImpl: recordFetch(createTestFetch(fixture.server), requests),
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text)
    };

    expect(await runConfigCommand("pull", commandOptions)).toBe(0);
    expect(requests[0]?.url).toBe(`${url}${testOperations["access_tokens.exchange"].path}`);
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${fixture.apiKey}`
    );
    expect(requests[0]?.init?.body).toBeUndefined();
    expect(requests[1]?.url).toBe(`${url}${testOperations["config_assets.get_overview"].path}`);
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).toMatch(/^Bearer /u);
    expect(new Headers(requests[1]?.init?.headers).get("authorization")).not.toBe(
      `Bearer ${fixture.apiKey}`
    );
    expect(requests.some((request) => request.url.includes("session-tokens"))).toBe(false);
    const agentPath = resolve(directory, "agents", "assistant.agent.yaml");
    const pulledAgent = parseAgentYaml(await readFile(agentPath, "utf8"));
    expect(pulledAgent.instructions).toBe("Remote instructions");
    await expect(readFile(obsoleteAgentPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readStateFile(resolve(directory, STATE_FILENAME))).toMatchObject({
      instances: {
        local: {
          lastPulledVersion: 1,
          assets: { "agent:assistant": { revision: 1, hash: expect.any(String) } },
          defaultAgentName: "assistant"
        }
      }
    });
    expect(await readFile(resolve(directory, "catalyst.yaml"), "utf8")).toContain(
      "# Keep this manifest comment"
    );
    expect(await readFile(resolve(directory, "catalyst.yaml"), "utf8")).toContain(
      "defaultAgentName: assistant"
    );
    expect(stdout.join("")).toContain("Pulled 1 agent, 0 skills, version 1.");

    await writeFile(
      agentPath,
      serializeAgentYaml({ ...pulledAgent, instructions: "Local instructions" }),
      "utf8"
    );
    stdout.length = 0;
    expect(await runConfigCommand("push", commandOptions)).toBe(0);
    expect(stdout.join("")).toContain("Pushed 1 agent, 0 skills, version 1.");
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "agent",
        name: "assistant"
      })
    ).toMatchObject({ config: { instructions: "Remote instructions" } });

    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "assistant",
          config: agentConfig("New remote instructions")
        }
      ]
    });
    await writeFile(
      agentPath,
      serializeAgentYaml({ ...pulledAgent, instructions: "Stale local instructions" }),
      "utf8"
    );
    stderr.length = 0;
    expect(await runConfigCommand("push", commandOptions)).toBe(1);
    expect(stderr.join("")).toContain("agent:assistant: revision 2, changed by");
    expect(stderr.join("")).toContain("catalyst config pull --only agent:assistant");
    expect(stderr.join("")).toContain("Commit or stash local edits in git first");
    expect(stderr.join("")).toContain("catalyst config diff");
    expect(stderr.join("")).not.toContain("--force");

    // Fails without the change: --force pushed the local file over revision 3.
    stderr.length = 0;
    expect(await runConfigCommand("push", { ...commandOptions, force: true })).toBe(1);
    expect(stderr.join("")).toContain("'catalyst config push --force' no longer exists");
    expect(stderr.join("")).toContain("catalyst config pull --only <kind>:<name>");
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "agent",
        name: "assistant"
      })
    ).toMatchObject({ revision: 2, config: { instructions: "New remote instructions" } });
  });

  it("reports missing credentials separately from exchange and API failures", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const missingStderr: string[] = [];

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: {},
        stderr: (text) => missingStderr.push(text)
      })
    ).toBe(1);
    expect(missingStderr.join("")).toContain("Not logged in to https://catalyst.test");
    expect(missingStderr.join("")).toContain("CATALYST_API_KEY");

    // The server credential no longer signs the CLI in, and no request leaves the process.
    const serverCredentialStderr: string[] = [];
    const serverCredentialRequests: string[] = [];
    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: {
          CATALYST_SERVER_CREDENTIAL: "server-credential",
          CHAT_SERVER_CREDENTIAL: "server-credential"
        },
        fetchImpl: async (input) => {
          serverCredentialRequests.push(input instanceof Request ? input.url : String(input));
          return jsonResponse(500, {});
        },
        stderr: (text) => serverCredentialStderr.push(text)
      })
    ).toBe(1);
    expect(serverCredentialStderr.join("")).toContain("Not logged in");
    expect(serverCredentialStderr.join("")).not.toContain("SERVER_CREDENTIAL");
    expect(serverCredentialRequests).toEqual([]);

    const apiKey = "cat_test_secret-never-print-this";
    const exchangeStderr: string[] = [];
    const exchangeRequests: string[] = [];
    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: {
          CATALYST_API_KEY: apiKey,
          CATALYST_SERVER_CREDENTIAL: "must-not-be-used"
        },
        fetchImpl: async (input) => {
          exchangeRequests.push(input instanceof Request ? input.url : String(input));
          return jsonResponse(401, {
            error: { code: "UNAUTHENTICATED", message: `Invalid API key ${apiKey}` }
          });
        },
        stderr: (text) => exchangeStderr.push(text)
      })
    ).toBe(1);
    expect(exchangeStderr.join("")).toContain("API key exchange failed (HTTP 401)");
    expect(exchangeStderr.join("")).not.toContain(apiKey);
    expect(exchangeRequests).toEqual(["https://catalyst.test/api/v1/auth/access-token"]);

    const apiStderr: string[] = [];
    let requestCount = 0;
    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_API_KEY: apiKey },
        fetchImpl: async () => {
          requestCount += 1;
          return requestCount === 1
            ? jsonResponse(200, {
                accessToken: "short-lived-access-token",
                expiresAt: "2030-01-01T00:00:00.000Z"
              })
            : jsonResponse(503, {
                error: { code: "UNAVAILABLE", message: "Config API unavailable" }
              });
        },
        stderr: (text) => apiStderr.push(text)
      })
    ).toBe(1);
    expect(apiStderr.join("")).toContain("UNAVAILABLE: Config API unavailable");
    expect(apiStderr.join("")).not.toContain("API key exchange failed");
    expect(apiStderr.join("")).not.toContain(apiKey);
  });

  it("uses API-key auth with a direct --instance URL", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "http://manifest-instance.test");
    const requests: string[] = [];
    const fetchImpl = await emptyInstanceBehind(
      "https://direct-instance.example.test/base",
      requests
    );

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        instance: "https://direct-instance.example.test/base/",
        env: { CATALYST_API_KEY: "cat_direct_key" },
        fetchImpl
      })
    ).toBe(0);
    expect(requests).toEqual([
      "https://direct-instance.example.test/base/api/v1/auth/access-token",
      "https://direct-instance.example.test/base/api/v1/instance/config/assets",
      "https://direct-instance.example.test/base/api/v1/assets/agent?limit=200",
      "https://direct-instance.example.test/base/api/v1/assets/skill?limit=200"
    ]);
  });

  it("refuses API-key exchange over remote plain HTTP before fetching", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "http://remote.example.test");
    const stderr: string[] = [];
    let fetchCount = 0;
    const apiKey = "cat_remote_secret";

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_API_KEY: apiKey },
        fetchImpl: async () => {
          fetchCount += 1;
          return jsonResponse(500, {});
        },
        stderr: (text) => stderr.push(text)
      })
    ).toBe(1);
    expect(fetchCount).toBe(0);
    expect(stderr.join("")).toContain("Refusing to send CATALYST_API_KEY over plain HTTP");
    expect(stderr.join("")).toContain("Use HTTPS");
    expect(stderr.join("")).not.toContain(apiKey);
  });

  it.each(["http://localhost:4100/", "http://127.42.0.8:4100/", "http://[::1]:4100/"])(
    "allows API-key exchange for loopback direct URL %s",
    async (instance) => {
      const directory = await createTemporaryDirectory();
      await writeMinimalManifest(directory, "https://manifest-instance.test");
      const requests: string[] = [];
      const baseUrl = instance.replace(/\/$/u, "");

      expect(
        await runConfigCommand("pull", {
          cwd: directory,
          instance,
          env: { CATALYST_API_KEY: "cat_loopback_key" },
          fetchImpl: await emptyInstanceBehind(baseUrl, requests)
        })
      ).toBe(0);
      expect(requests.slice(0, 2)).toEqual([
        `${baseUrl}${testOperations["access_tokens.exchange"].path}`,
        `${baseUrl}${testOperations["config_assets.get_overview"].path}`
      ]);
    }
  );
});
