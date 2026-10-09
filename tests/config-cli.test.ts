import { createTestFetch, createTestInstance, type TestInstance } from "./support/test-instance";
import { testOperations } from "./support/operations";

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUTH_MOUNT_PATH } from "@vivd-catalyst/api-client";
import { afterEach, describe, expect, it } from "vitest";

import {
  ApiKeyAccessTokenExchange,
  CompositeAuthAdapter,
  HmacServiceAccessTokenAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  IdentityResolvingAuthAdapter
} from "@vivd-catalyst/auth";

import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  type AgentRuntime,
  type RuntimeCallContext
} from "@vivd-catalyst/core";

import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import {
  STATE_FILENAME,
  canonicalBundleFiles,
  canonicalizeAgentConfig,
  canonicalizeSkillConfig,
  createConfigApi,
  createUnifiedDiff,
  parseAgentYaml,
  parseManifest,
  parseSkillFile,
  readManifest,
  readWorkingCopy,
  readStateFile,
  resolveSkillResourceTarget,
  resolveInstance,
  runCli,
  runConfigCommand,
  serializeAgentYaml,
  serializeSkillMarkdown,
  writeStateFile,
  updateManifestDefaultAgent
} from "../packages/config-cli/src/index";

const servers: TestInstance[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("config CLI serialization", () => {
  it("deterministically round-trips agent YAML and ignores provenance comments", () => {
    const input = {
      ...agentConfig("First line\nSecond line"),
      description: { en: "Help with documents.", de: "Hilfe bei Unterlagen." },
      reasoningEffort: "xhigh" as const
    };
    const serialized = serializeAgentYaml(input, { instance: "local", version: 12 });

    expect(serialized).toMatch(/^# Pulled from local \(config version 12\)\./u);
    expect(serialized).toMatch(/instructions: \|[-+]?\n/u);
    expect(parseAgentYaml(serialized)).toEqual(canonicalizeAgentConfig(input));
    expect(parseAgentYaml(serialized).description).toEqual(input.description);
    expect(serializeAgentYaml(parseAgentYaml(serialized))).toBe(
      serializeAgentYaml(canonicalizeAgentConfig(input))
    );
    expect(Object.keys(canonicalizeAgentConfig(input))).toEqual([
      "name",
      "displayName",
      "description",
      "instructions",
      "modelProviderId",
      "reasoningEffort",
      "toolNames",
      "skillNames",
      "initialPrompts"
    ]);
  });

  it("round-trips fastMode and leaves it out of the YAML when it is off", () => {
    const fast = { ...agentConfig("Fast"), modelBindingId: "primary", fastMode: true };
    const serialized = serializeAgentYaml(fast);

    expect(serialized).toContain("fastMode: true\n");
    expect(parseAgentYaml(serialized)).toMatchObject({ fastMode: true });
    expect(serializeAgentYaml(parseAgentYaml(serialized))).toBe(serialized);
    expect(serializeAgentYaml({ ...fast, fastMode: false })).not.toContain("fastMode");
    expect(serializeAgentYaml({ ...fast, fastMode: false })).toBe(
      serializeAgentYaml({ ...agentConfig("Fast"), modelBindingId: "primary" })
    );
  });

  it("round-trips userSelectableModelBindingIds and leaves an empty list out of the YAML", () => {
    const agent = { ...agentConfig("Chooser"), modelBindingId: "primary" };
    const serialized = serializeAgentYaml({
      ...agent,
      userSelectableModelBindingIds: ["fast", "cheap"]
    });

    expect(serialized).toContain("userSelectableModelBindingIds:\n  - fast\n  - cheap\n");
    expect(parseAgentYaml(serialized)).toMatchObject({
      userSelectableModelBindingIds: ["fast", "cheap"]
    });
    expect(serializeAgentYaml(parseAgentYaml(serialized))).toBe(serialized);
    expect(serializeAgentYaml({ ...agent, userSelectableModelBindingIds: [] })).toBe(
      serializeAgentYaml(agent)
    );

    const withEfforts = serializeAgentYaml({
      ...agent,
      userSelectableModelBindingIds: ["fast", "cheap"],
      modelReasoningEfforts: { fast: "low" }
    });
    expect(withEfforts).toContain("modelReasoningEfforts:\n  fast: low\n");
    expect(serializeAgentYaml(parseAgentYaml(withEfforts))).toBe(withEfforts);
    expect(serializeAgentYaml({ ...agent, modelReasoningEfforts: {} })).toBe(
      serializeAgentYaml(agent)
    );
  });

  it("round-trips SKILL.md with provenance comments inside frontmatter", () => {
    const skill = {
      name: "review",
      title: "Review",
      description: "Review a workflow",
      content: "# Review\n\nCheck the workflow."
    };
    const serialized = serializeSkillMarkdown(skill, { instance: "staging", version: 4 });

    expect(serialized).toContain("---\n# Pulled from staging (config version 4).\n");
    expect(parseSkillFile(serialized)).toEqual(skill);
    expect(serializeSkillMarkdown(parseSkillFile(serialized))).toBe(serializeSkillMarkdown(skill));
  });
});

describe("config CLI state and manifest", () => {
  it("reads and atomically writes state files", async () => {
    const directory = await createTemporaryDirectory();
    const path = resolve(directory, STATE_FILENAME);

    expect(await readStateFile(path)).toEqual({ instances: {} });
    await writeStateFile(path, {
      instances: {
        local: { lastPulledVersion: 12 },
        staging: { lastPulledVersion: 3 }
      }
    });

    expect(await readStateFile(path)).toEqual({
      instances: {
        local: { lastPulledVersion: 12 },
        staging: { lastPulledVersion: 3 }
      }
    });
    expect(await readFile(path, "utf8")).toContain('"lastPulledVersion": 12');
  });

  it("resolves named, default, and direct URL instances", () => {
    const manifest = parseManifest(`instances:
  local:
    url: http://127.0.0.1:4100/
defaultInstance: local
defaultAgentName: workflow_assistant
agents:
  - agents/*.agent.yaml
skills:
  - skills/*/SKILL.md
`);

    expect(resolveInstance(manifest)).toEqual({ key: "local", url: "http://127.0.0.1:4100" });
    expect(resolveInstance(manifest, "local")).toEqual({
      key: "local",
      url: "http://127.0.0.1:4100"
    });
    expect(resolveInstance(manifest, "https://catalyst.example.test/")).toEqual({
      key: "https://catalyst.example.test/",
      url: "https://catalyst.example.test"
    });
  });

  it("keeps resolved skill resources inside their package", () => {
    const skillDirectory = resolve("/tmp", "skills", "review");
    expect(resolveSkillResourceTarget(skillDirectory, "references/checks.md")).toBe(
      resolve(skillDirectory, "references/checks.md")
    );
    expect(() => resolveSkillResourceTarget(skillDirectory, "../outside.md")).toThrow(
      "must stay within its package"
    );
    expect(() => resolveSkillResourceTarget(skillDirectory, "C:/outside.md")).toThrow(
      "must stay within its package"
    );
    expect(() => resolveSkillResourceTarget(skillDirectory, "references/bad\u0001.md")).toThrow(
      "must stay within its package"
    );
  });
});

describe("config CLI diff", () => {
  it("prints a unified diff for a changed agent", () => {
    const remote = canonicalBundleFiles({
      defaultAgentName: "assistant",
      agents: [agentConfig("Remote instructions")],
      skills: []
    });
    const local = canonicalBundleFiles({
      defaultAgentName: "assistant",
      agents: [agentConfig("Local instructions")],
      skills: []
    });
    const path = "agents/assistant.agent.yaml";
    const output = createUnifiedDiff(
      { path, contents: remote.get(path) },
      { path, contents: local.get(path) }
    );

    expect(output).toContain(`diff --git a/${path} b/${path}`);
    expect(output).toContain("-instructions: Remote instructions");
    expect(output).toContain("+instructions: Local instructions");
  });
});

describe("config CLI command flows", () => {
  it("round-trips complete skill packages and rejects unsupported local resources", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const skillDirectory = resolve(directory, "skills", "review");
    await mkdir(resolve(skillDirectory, "references"), { recursive: true });
    await writeFile(
      resolve(skillDirectory, "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Review")),
      "utf8"
    );
    await writeFile(resolve(skillDirectory, "references", "checks.md"), "# Checks\n", "utf8");
    await writeFile(
      resolve(skillDirectory, "references", "schema.json"),
      '{"status":"ok"}\n',
      "utf8"
    );

    const local = await readWorkingCopy(directory, await readManifest(directory));
    expect(local.skills).toEqual([
      {
        ...skillConfig("review", "Review"),
        resources: [
          {
            path: "references/checks.md",
            mediaType: "text/markdown",
            content: "# Checks\n"
          },
          {
            path: "references/schema.json",
            mediaType: "application/json",
            content: '{"status":"ok"}\n'
          }
        ]
      }
    ]);
    expect(canonicalBundleFiles(local).get("skills/review/references/checks.md")).toBe(
      "# Checks\n"
    );

    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: { lastPulledVersion: 0, assets: {}, defaultAgentName: null } }
    });
    const pushed: unknown[] = [];
    expect(
      await runConfigCommand("push", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_package" },
        fetchImpl: configApiFetch({ version: 0, agents: [], skills: [] }, pushed, 1)
      })
    ).toBe(0);
    expect(pushed.at(-1)).toMatchObject({ skills: local.skills });

    await writeFile(resolve(skillDirectory, "references", "stale.md"), "stale", "utf8");
    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_package" },
        fetchImpl: configApiFetch({ version: 2, agents: [], skills: local.skills })
      })
    ).toBe(0);
    await expect(
      readFile(resolve(skillDirectory, "references", "stale.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(resolve(skillDirectory, "references", "checks.md"), "utf8")).toBe(
      "# Checks\n"
    );

    await writeFile(resolve(skillDirectory, "references", "binary.pdf"), "%PDF", "utf8");
    await expect(readWorkingCopy(directory, await readManifest(directory))).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Unsupported skill resource") })
      ])
    });
  });

  it("preserves the existing package and cleans temporary files when a package write fails", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const skillDirectory = resolve(directory, "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(resolve(skillDirectory, "SKILL.md"), "existing package\n", "utf8");
    const conflictingPackage = {
      ...skillConfig("review", "Replacement"),
      resources: [
        { path: "conflict.md", mediaType: "text/markdown", content: "file" },
        {
          path: "conflict.md/nested.txt",
          mediaType: "text/plain",
          content: "nested"
        }
      ]
    };
    const stderr: string[] = [];

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_package_failure" },
        fetchImpl: configApiFetch({ version: 2, agents: [], skills: [conflictingPackage] }),
        stderr: (text) => stderr.push(text)
      })
    ).toBe(1);
    expect(stderr.join("")).toBeTruthy();
    expect(await readFile(resolve(skillDirectory, "SKILL.md"), "utf8")).toBe("existing package\n");
    expect((await readdir(resolve(directory, "skills"))).sort()).toEqual(["review"]);
  });

  it("reports resource-only skill changes as updates in the push plan", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const skillDirectory = resolve(directory, "skills", "review");
    await mkdir(resolve(skillDirectory, "references"), { recursive: true });
    await writeFile(
      resolve(skillDirectory, "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Same root")),
      "utf8"
    );
    await writeFile(resolve(skillDirectory, "references", "checks.md"), "local\n", "utf8");
    const remoteSkill = {
      ...skillConfig("review", "Same root"),
      resources: [
        {
          path: "references/checks.md",
          mediaType: "text/markdown",
          content: "remote\n"
        }
      ]
    };
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: pulledBaseline(4, { agents: [], skills: [remoteSkill] }) }
    });
    const stdout: string[] = [];

    expect(
      await runConfigCommand("push", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_resource_plan" },
        fetchImpl: configApiFetch({ version: 4, agents: [], skills: [remoteSkill] }),
        stdout: (text) => stdout.push(text)
      })
    ).toBe(0);
    expect(stdout.join("")).toContain("Updated: 1");
    expect(stdout.join("")).toContain("Unchanged: 0");
  });

  it("prefers API-key exchange, then pulls, pushes, and reports a stale-version conflict", async () => {
    const fixture = await createFixture();
    await fixture.store.configAssets.applyConfigAssetMutations({
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
    expect(requests[1]?.url).toBe(`${url}${testOperations["config_assets.export"].path}`);
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
    expect(stdout.join("")).toContain("Pushed 1 agent, 0 skills, version 2.");
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "agent",
        name: "assistant"
      })
    ).toMatchObject({ config: { instructions: "Local instructions" } });

    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      baseVersion: 2,
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
    expect(stderr.join("")).toContain("agent:assistant: revision 3, update");
    expect(stderr.join("")).toContain("catalyst config pull --only agent:assistant");
    expect(stderr.join("")).toContain("Commit or stash local edits in git first");
    expect(stderr.join("")).toContain("catalyst config diff");
    expect(stderr.join("")).toContain("--force");
  });

  it("rejects noncanonical pull globs before writing or deleting assets", async () => {
    const fixture = await createFixture();
    await fixture.store.configAssets.applyConfigAssetMutations({
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
    const directory = await createTemporaryDirectory();
    await writeFile(
      resolve(directory, "catalyst.yaml"),
      `instances:
  local:
    url: https://catalyst.test
defaultInstance: local
defaultAgentName: unchanged
agents:
  - config/agents/*.yaml
skills:
  - skills/*/SKILL.md
`,
      "utf8"
    );
    const existingPath = resolve(directory, "config", "agents", "existing.yaml");
    await mkdir(resolve(directory, "config", "agents"), { recursive: true });
    await writeFile(existingPath, "existing contents\n", "utf8");
    const stderr: string[] = [];

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_API_KEY: fixture.apiKey },
        fetchImpl: createTestFetch(fixture.server),
        stderr: (text: string) => stderr.push(text)
      })
    ).toBe(1);
    expect(stderr.join("")).toContain("canonical layout");
    expect(stderr.join("")).toContain("adjust the manifest globs");
    await expect(readFile(existingPath, "utf8")).resolves.toBe("existing contents\n");
    await expect(
      readFile(resolve(directory, "agents", "assistant.agent.yaml"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(directory, STATE_FILENAME), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(resolve(directory, "catalyst.yaml"), "utf8")).toContain(
      "defaultAgentName: unchanged"
    );
  });

  it("prints merge and mirror push plans and names remote-only assets", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await mkdir(resolve(directory, "agents"), { recursive: true });
    await writeFile(
      resolve(directory, "agents", "assistant.agent.yaml"),
      serializeAgentYaml(agentConfig("Local update")),
      "utf8"
    );
    await writeFile(
      resolve(directory, "agents", "new.agent.yaml"),
      serializeAgentYaml(agentConfig("New", { name: "new" })),
      "utf8"
    );
    const remote = {
      version: 4,
      defaultAgentName: "assistant",
      agents: [
        agentConfig("Remote", { name: "assistant" }),
        agentConfig("Remote only", { name: "remote-only" })
      ],
      skills: []
    };
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: pulledBaseline(4, remote) }
    });
    const mergeRequests: unknown[] = [];
    const mergeStdout: string[] = [];
    expect(
      await runConfigCommand("push", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_plan" },
        fetchImpl: configApiFetch(remote, mergeRequests, 5),
        stdout: (text) => mergeStdout.push(text)
      })
    ).toBe(0);
    expect(mergeStdout.join("")).toContain(
      "Push plan (merge):\n  Added: 1\n  Updated: 1\n  Unchanged: 0"
    );
    expect(mergeStdout.join("")).toContain("- agent:remote-only");
    expect(mergeStdout.join("")).toContain("Use --prune to delete them.");
    expect(mergeRequests.at(-1)).toMatchObject({
      mode: "merge",
      baseVersion: null,
      baseRevisions: { "agent:assistant": 1, "agent:new": null }
    });

    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: pulledBaseline(4, remote) }
    });
    const pruneRequests: unknown[] = [];
    const pruneStdout: string[] = [];
    expect(
      await runConfigCommand("push", {
        cwd: directory,
        prune: true,
        env: { CATALYST_API_KEY: "cat_plan" },
        fetchImpl: configApiFetch(remote, pruneRequests, 5),
        stdout: (text) => pruneStdout.push(text)
      })
    ).toBe(0);
    expect(pruneStdout.join("")).toContain("Push plan (mirror):");
    expect(pruneStdout.join("")).toContain("Deleted: 1");
    expect(pruneStdout.join("")).toContain("Assets to delete:\n- agent:remote-only");
    expect(pruneRequests.at(-1)).toMatchObject({
      mode: "merge",
      baseVersion: null,
      deleteAssets: [{ kind: "agent", name: "remote-only" }]
    });
  });

  it("sends only selected assets on push and rejects --prune with --only", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await mkdir(resolve(directory, "agents"), { recursive: true });
    await mkdir(resolve(directory, "skills", "review"), { recursive: true });
    await writeFile(
      resolve(directory, "agents", "assistant.agent.yaml"),
      serializeAgentYaml(agentConfig("Selected")),
      "utf8"
    );
    await writeFile(
      resolve(directory, "agents", "other.agent.yaml"),
      serializeAgentYaml(agentConfig("Other", { name: "other" })),
      "utf8"
    );
    await writeFile(
      resolve(directory, "skills", "review", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Review")),
      "utf8"
    );
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: pulledBaseline(3, { agents: [agentConfig("Remote")], skills: [] }) }
    });
    const requests: unknown[] = [];
    expect(
      await runCli(["config", "push", "--only", "agent:assistant", "--only", "skill:review"], {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_scoped" },
        fetchImpl: configApiFetch(
          { version: 3, agents: [agentConfig("Remote")], skills: [] },
          requests,
          4
        )
      })
    ).toBe(0);
    expect(requests.at(-1)).toEqual({
      agents: [canonicalizeAgentConfig(agentConfig("Selected"))],
      skills: [skillConfig("review", "Review")],
      baseVersion: null,
      baseRevisions: { "agent:assistant": 1, "skill:review": null },
      deleteAssets: [],
      mode: "merge"
    });

    const stderr: string[] = [];
    expect(
      await runCli(["config", "push", "--prune", "--only", "agent:assistant"], {
        cwd: directory,
        stderr: (text) => stderr.push(text)
      })
    ).toBe(2);
    expect(stderr.join("")).toContain("--prune cannot be combined with --only");
  });

  it("prints the agents a push left hidden in every workspace", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await mkdir(resolve(directory, "agents"), { recursive: true });
    await writeFile(
      resolve(directory, "agents", "kai-tax.agent.yaml"),
      serializeAgentYaml(agentConfig("Tax", { name: "kai-tax" })),
      "utf8"
    );
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: pulledBaseline(3, { agents: [], skills: [] }) }
    });
    const remote = { version: 3, agents: [], skills: [] };
    const push = async (hiddenAgentNames?: string[]) => {
      const stdout: string[] = [];
      const fallback = configApiFetch(remote, [], 4);
      const exitCode = await runCli(["config", "push", "--force"], {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_hidden" },
        stdout: (text) => stdout.push(text),
        fetchImpl: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          return hiddenAgentNames &&
            url.pathname.endsWith(testOperations["config_assets.replace"].buildPath({}))
            ? jsonResponse(200, { version: 4, hiddenAgentNames })
            : fallback(input, init);
        }
      });
      expect(exitCode).toBe(0);
      return stdout.join("");
    };

    const hidden = await push(["kai-tax"]);
    expect(hidden).toContain("Pushed 1 agent, 0 skills, version 4.");
    expect(hidden).toContain(
      "Hidden in every workspace until an instance admin sets their availability:\n  agent:kai-tax\n"
    );
    // Servers without availability, and pushes that hide nothing, print no notice.
    expect(await push()).not.toContain("Hidden in every workspace");
    expect(await push([])).not.toContain("Hidden in every workspace");
  });

  it("rewrites only selected pull files without changing the recorded version", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await mkdir(resolve(directory, "agents"), { recursive: true });
    const selectedPath = resolve(directory, "agents", "assistant.agent.yaml");
    const otherPath = resolve(directory, "agents", "other.agent.yaml");
    await writeFile(selectedPath, serializeAgentYaml(agentConfig("Old selected")), "utf8");
    await writeFile(
      otherPath,
      serializeAgentYaml(agentConfig("Old other", { name: "other" })),
      "utf8"
    );
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: { lastPulledVersion: 5 } }
    });
    const stdout: string[] = [];
    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        only: ["agent:assistant"],
        env: { CATALYST_API_KEY: "cat_pull" },
        fetchImpl: configApiFetch({
          version: 9,
          agents: [agentConfig("New selected"), agentConfig("New other", { name: "other" })],
          skills: []
        }),
        stdout: (text) => stdout.push(text)
      })
    ).toBe(0);
    expect(parseAgentYaml(await readFile(selectedPath, "utf8")).instructions).toBe("New selected");
    expect(parseAgentYaml(await readFile(otherPath, "utf8")).instructions).toBe("Old other");
    expect(await readStateFile(resolve(directory, STATE_FILENAME))).toEqual({
      instances: {
        local: {
          lastPulledVersion: 5,
          assets: { "agent:assistant": { revision: 1, hash: expect.any(String) } }
        }
      }
    });
    expect(stdout.join("")).toContain("selected asset baselines updated");
  });

  it("migrates legacy state by refusing an unguarded push, and refuses an older server even with force", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: { lastPulledVersion: 8 } }
    });
    const errors: string[] = [];
    expect(
      await runConfigCommand("push", { cwd: directory, stderr: (text) => errors.push(text) })
    ).toBe(1);
    expect(errors.join("")).toContain("No per-asset baseline");
    expect(errors.join("")).toContain("catalyst config pull");
    const requests: string[] = [];
    const olderServerFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(new URL(request.url).pathname);
      return new URL(request.url).pathname.endsWith("access-token")
        ? jsonResponse(200, { accessToken: "token", expiresAt: "2030-01-01T00:00:00.000Z" })
        : jsonResponse(200, { version: 8, agents: [], skills: [] });
    };
    errors.length = 0;
    expect(
      await runConfigCommand("push", {
        cwd: directory,
        force: true,
        env: { CATALYST_API_KEY: "cat_old_server" },
        fetchImpl: olderServerFetch,
        stderr: (text) => errors.push(text)
      })
    ).toBe(1);
    expect(errors.join("")).toContain("Upgrade the server before pushing");
    expect(requests).not.toContain(testOperations["config_assets.replace"].buildPath({}));
  });

  it("prints all conflicts and an exact scoped pull command with the selected instance and directory", async () => {
    const parent = await createTemporaryDirectory();
    const directory = resolve(parent, "working copy");
    await mkdir(directory, { recursive: true });
    await writeMinimalManifest(directory, "https://catalyst.test");
    await mkdir(resolve(directory, "skills", "review"), { recursive: true });
    await writeFile(
      resolve(directory, "skills", "review", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Local")),
      "utf8"
    );
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: { lastPulledVersion: 0, assets: {}, defaultAgentName: null } }
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/import")) {
        return jsonResponse(409, {
          error: {
            code: "CONFLICT",
            message: "Conflict",
            details: {
              conflicts: [
                {
                  kind: "skill",
                  name: "review",
                  currentRevision: 3,
                  actorLabel: "Reviewer",
                  timestamp: "2026-10-05T10:00:00Z",
                  operation: "update"
                },
                {
                  kind: "agent",
                  name: "assistant",
                  currentRevision: 2,
                  actorLabel: "Admin",
                  timestamp: "2026-10-05T11:00:00Z",
                  operation: "revert"
                }
              ]
            }
          }
        });
      }
      return configApiFetch({ version: 0, agents: [], skills: [] })(input, init);
    };
    const errors: string[] = [];
    expect(
      await runConfigCommand("push", {
        cwd: parent,
        dir: "working copy",
        instance: "local",
        env: { CATALYST_API_KEY: "cat_conflicts" },
        fetchImpl,
        stdout: () => {},
        stderr: (text) => errors.push(text)
      })
    ).toBe(1);
    expect(errors.join("")).toContain(
      "skill:review: revision 3, update by Reviewer at 2026-10-05T10:00:00Z"
    );
    expect(errors.join("")).toContain(
      "agent:assistant: revision 2, revert by Admin at 2026-10-05T11:00:00Z"
    );
    expect(errors.join("")).toContain(
      "catalyst config pull --dir 'working copy' --instance local --only skill:review --only agent:assistant"
    );
    expect(errors.join("")).toContain("Commit or stash local edits in git first");
  });

  it("classifies local, remote and conflicting changes and pushes only local edits", async () => {
    const fixture = await createFixture();
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        ...["local", "remote", "both"].map((name) => ({
          type: "upsert" as const,
          kind: "skill" as const,
          name,
          config: skillConfig(name, "Baseline")
        }))
      ]
    });
    const output: string[] = [];
    const errors: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: fixture.apiKey },
      fetchImpl: createTestFetch(fixture.server),
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => errors.push(text)
    };
    expect(await runConfigCommand("pull", options)).toBe(0);
    const before = (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local;
    for (const name of ["local", "both"]) {
      await writeFile(
        resolve(directory, "skills", name, "SKILL.md"),
        serializeSkillMarkdown(skillConfig(name, "Local edit")),
        "utf8"
      );
    }
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      actor: { displayLabel: "Skill reviewer", roles: ["admin"] },
      mutations: ["remote", "both"].map((name) => ({
        type: "upsert" as const,
        kind: "skill" as const,
        name,
        config: skillConfig(name, "Remote edit")
      }))
    });
    output.length = 0;
    expect(await runConfigCommand("diff", options)).toBe(1);
    expect(output.join("")).toContain("skill:local: changed locally");
    expect(output.join("")).toContain("skill:remote: remote newer");
    expect(output.join("")).toContain("skill:both: conflict");
    expect(output.join("")).not.toContain("skills/remote/SKILL.md");
    expect(await runConfigCommand("push", options)).toBe(1);
    expect(errors.join("")).toContain("skill:both: revision 2, update by Skill reviewer at");
    expect(errors.join("")).toContain("catalyst config pull --only skill:both");
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill",
        name: "local"
      })
    ).toMatchObject({ revision: 1 });
    expect(await runConfigCommand("push", { ...options, only: ["skill:local"] })).toBe(0);
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill",
        name: "remote"
      })
    ).toMatchObject({ revision: 2, config: skillConfig("remote", "Remote edit") });
    expect(await runConfigCommand("pull", { ...options, only: ["skill:both"] })).toBe(0);
    const after = (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local;
    expect(after?.assets?.["skill:both"]).toMatchObject({ revision: 2 });
    expect(after?.assets?.["skill:remote"]).toEqual(before?.assets?.["skill:remote"]);
    expect(after?.assets?.["skill:local"]).toMatchObject({ revision: 2 });
    expect(after?.defaultAgentName).toBe(before?.defaultAgentName);
    output.length = 0;
    expect(await runConfigCommand("push", options)).toBe(0);
    expect(output.join("")).toContain("No local changes to push");
    expect(output.join("")).toContain("Unchanged: 3");
  });

  it("baselines the serialized content so pull normalization and YAML formatting are not local edits", async () => {
    const fixture = await createFixture();
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("Baseline") },
        { type: "setDefaultAgent", agentName: "assistant" },
        {
          type: "upsert",
          kind: "skill",
          name: "review",
          config: {
            ...skillConfig("review", "\n# Review\n\n"),
            resources: [
              { path: "z.md", mediaType: "text/markdown", content: "Last\n" },
              { path: "a.md", mediaType: "text/markdown", content: "First\n" }
            ]
          }
        }
      ]
    });
    const output: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: fixture.apiKey },
      fetchImpl: createTestFetch(fixture.server),
      stdout: (text: string) => output.push(text)
    };
    expect(await runConfigCommand("pull", options)).toBe(0);
    const path = resolve(directory, "agents", "assistant.agent.yaml");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("instructions: Baseline", "instructions: 'Baseline'"),
      "utf8"
    );
    expect(await runConfigCommand("diff", options)).toBe(0);
    expect(await runConfigCommand("push", options)).toBe(0);
    expect(output.join("")).toContain("No local changes to push");
    expect(
      await fixture.store.configAssets.getConfigAssetState({
        clientInstanceId: fixture.clientInstanceId
      })
    ).toMatchObject({ version: 1 });
  });

  it("keeps a remotely changed default unless the local manifest changes it", async () => {
    const fixture = await createFixture();
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        ...["assistant", "other", "third"].map((name) => ({
          type: "upsert" as const,
          kind: "agent" as const,
          name,
          config: agentConfig("Baseline", { name })
        })),
        {
          type: "upsert",
          kind: "skill",
          name: "review",
          config: skillConfig("review", "Baseline")
        },
        { type: "setDefaultAgent", agentName: "assistant" }
      ]
    });
    const errors: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: fixture.apiKey },
      fetchImpl: createTestFetch(fixture.server),
      stdout: () => {},
      stderr: (text: string) => errors.push(text)
    };
    expect(await runConfigCommand("pull", options)).toBe(0);
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [{ type: "setDefaultAgent", agentName: "other" }]
    });
    await writeFile(
      resolve(directory, "skills", "review", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Local")),
      "utf8"
    );
    expect(await runConfigCommand("push", options)).toBe(0);
    expect(
      await fixture.store.configAssets.getConfigAssetState({
        clientInstanceId: fixture.clientInstanceId
      })
    ).toMatchObject({ defaultAgentName: "other" });
    await updateManifestDefaultAgent(resolve(directory, "catalyst.yaml"), "third");
    expect(await runConfigCommand("push", options)).toBe(1);
    expect(errors.join("")).toContain(
      "default agent changed on the instance; a full pull is required"
    );
    expect(errors.join("")).toContain("a full pull overwrites the local working copy");
    expect(errors.join("")).toContain("\ncatalyst config pull\n");
    expect(await runConfigCommand("pull", options)).toBe(0);
    expect(
      (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local?.defaultAgentName
    ).toBe("other");
  });

  it("pulls a deleted conflict by removing just that asset and leaves other baselines alone", async () => {
    const fixture = await createFixture();
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: "review",
          config: skillConfig("review", "Baseline")
        },
        { type: "upsert", kind: "skill", name: "other", config: skillConfig("other", "Other") }
      ]
    });
    const errors: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: fixture.apiKey },
      fetchImpl: createTestFetch(fixture.server),
      stderr: (text: string) => errors.push(text),
      stdout: () => {}
    };
    expect(await runConfigCommand("pull", options)).toBe(0);
    const before = (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local;
    await writeFile(
      resolve(directory, "skills", "review", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Local")),
      "utf8"
    );
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      actor: { displayLabel: "Remote editor", roles: ["admin"] },
      mutations: [{ type: "delete", kind: "skill", name: "review" }]
    });
    expect(await runConfigCommand("push", options)).toBe(1);
    expect(errors.join("")).toContain("skill:review: revision 2, delete by Remote editor");
    expect(await runConfigCommand("pull", { ...options, only: ["skill:review"] })).toBe(0);
    await expect(
      readFile(resolve(directory, "skills", "review", "SKILL.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    const after = (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local;
    expect(after?.assets?.["skill:review"]).toBeUndefined();
    expect(after?.assets?.["skill:other"]).toEqual(before?.assets?.["skill:other"]);
  });

  it("guards prune deletions and refreshes force-written assets", async () => {
    const fixture = await createFixture();
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        { type: "upsert", kind: "skill", name: "review", config: skillConfig("review", "Baseline") }
      ]
    });
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: fixture.apiKey },
      fetchImpl: createTestFetch(fixture.server),
      stdout: () => {},
      stderr: () => {}
    };
    expect(await runConfigCommand("pull", options)).toBe(0);
    await rm(resolve(directory, "skills", "review"), { recursive: true });
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        { type: "upsert", kind: "skill", name: "review", config: skillConfig("review", "Remote") }
      ]
    });
    expect(await runConfigCommand("push", { ...options, prune: true })).toBe(1);
    expect(await runConfigCommand("push", { ...options, prune: true, force: true })).toBe(0);
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill",
        name: "review"
      })
    ).toMatchObject({ status: "deleted", revision: 3 });
    expect(
      (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local?.assets?.[
        "skill:review"
      ]
    ).toBeUndefined();
    await mkdir(resolve(directory, "skills", "review"), { recursive: true });
    await writeFile(
      resolve(directory, "skills", "review", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Deliberate overwrite")),
      "utf8"
    );
    expect(await runConfigCommand("push", { ...options, force: true })).toBe(0);
    expect(
      (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local?.assets?.[
        "skill:review"
      ]
    ).toMatchObject({ revision: 4, hash: expect.any(String) });
    expect(await runConfigCommand("push", options)).toBe(0);
  });

  it("lists sync status and shows round-trippable remote assets", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await mkdir(resolve(directory, "agents"), { recursive: true });
    await mkdir(resolve(directory, "skills", "local-only"), { recursive: true });
    await writeFile(
      resolve(directory, "agents", "assistant.agent.yaml"),
      serializeAgentYaml(agentConfig("Local")),
      "utf8"
    );
    await writeFile(
      resolve(directory, "skills", "local-only", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("local-only", "Local only")),
      "utf8"
    );
    const remoteSkill = skillConfig("review", "Remote review");
    const remote = {
      version: 7,
      agents: [agentConfig("Remote")],
      skills: [remoteSkill]
    };
    const listOutput: string[] = [];
    expect(
      await runCli(["config", "list"], {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_list" },
        fetchImpl: configApiFetch(remote),
        stdout: (text) => listOutput.push(text)
      })
    ).toBe(0);
    expect(listOutput.join("")).toContain("agent\tassistant\t7\t-");
    expect(listOutput.join("")).toContain("skill\treview\t7\tmissing locally");
    expect(listOutput.join("")).toContain("skill\tlocal-only\t-\tmissing remotely");

    const agentOutput: string[] = [];
    expect(
      await runCli(["config", "show", "agent", "assistant"], {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_show" },
        fetchImpl: configApiFetch(remote),
        stdout: (text) => agentOutput.push(text)
      })
    ).toBe(0);
    expect(parseAgentYaml(agentOutput.join(""))).toEqual(
      canonicalizeAgentConfig(agentConfig("Remote"))
    );

    const skillOutput: string[] = [];
    expect(
      await runCli(["config", "show", "skill", "review"], {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_show" },
        fetchImpl: configApiFetch(remote),
        stdout: (text) => skillOutput.push(text)
      })
    ).toBe(0);
    expect(parseSkillFile(skillOutput.join(""))).toEqual(remoteSkill);
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
    expect(missingStderr.join("")).toContain("Missing CLI credentials");
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
    expect(serverCredentialStderr.join("")).toContain("Missing CLI credentials");
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
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      return url.endsWith(testOperations["access_tokens.exchange"].buildPath({}))
        ? jsonResponse(200, {
            accessToken: "direct-url-access-token",
            expiresAt: "2030-01-01T00:00:00.000Z"
          })
        : jsonResponse(200, { version: 0, agents: [], skills: [] });
    };

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        instance: "https://direct-instance.example.test/base/",
        env: { CATALYST_API_KEY: "cat_direct_key" },
        fetchImpl
      })
    ).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      "https://direct-instance.example.test/base/api/v1/auth/access-token",
      "https://direct-instance.example.test/base/api/v1/instance/config/export"
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

      expect(
        await runConfigCommand("pull", {
          cwd: directory,
          instance,
          env: { CATALYST_API_KEY: "cat_loopback_key" },
          fetchImpl: async (input) => {
            const url = input instanceof Request ? input.url : String(input);
            requests.push(url);
            return url.endsWith(testOperations["access_tokens.exchange"].buildPath({}))
              ? jsonResponse(200, {
                  accessToken: "loopback-access-token",
                  expiresAt: "2030-01-01T00:00:00.000Z"
                })
              : jsonResponse(200, { version: 0, agents: [], skills: [] });
          }
        })
      ).toBe(0);
      const baseUrl = instance.replace(/\/$/u, "");
      expect(requests).toEqual([
        `${baseUrl}${testOperations["access_tokens.exchange"].path}`,
        `${baseUrl}${testOperations["config_assets.export"].path}`
      ]);
    }
  );
});

describe("config CLI API transport", () => {
  it("reports invalid JSON during API-key exchange without exposing the response body", async () => {
    const responseBody = "upstream response body must stay private";
    const failure = await createConfigApi({
      baseUrl: "https://catalyst.example.test",
      apiKey: "cat_invalid_json_secret",
      fetchImpl: async () => new Response(responseBody, { status: 502 })
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "ApiKeyExchangeError",
      message: "API key exchange failed: Catalyst API returned invalid JSON (HTTP 502)"
    });
    expect(String(failure)).not.toContain(responseBody);
  });

  it("reports invalid JSON from an authenticated config request without exposing its body", async () => {
    const responseBody = "upstream config response body must stay private";
    let requestCount = 0;
    const api = await createConfigApi({
      baseUrl: "https://catalyst.example.test",
      apiKey: "cat_invalid_config_json_secret",
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1
          ? jsonResponse(200, {
              accessToken: "short-lived-access-token",
              expiresAt: "2030-01-01T00:00:00.000Z"
            })
          : new Response(responseBody, { status: 503 });
      }
    });

    const failure = await api.exportAssets().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "Catalyst API returned invalid JSON (HTTP 503)"
    });
    expect(String(failure)).not.toContain(responseBody);
  });

  it("rejects unsupported API-key URL schemes before fetching", async () => {
    let fetchCount = 0;

    await expect(
      createConfigApi({
        baseUrl: "ftp://catalyst.example.test",
        apiKey: "cat_unsupported_scheme_secret",
        fetchImpl: async () => {
          fetchCount += 1;
          return jsonResponse(500, {});
        }
      })
    ).rejects.toThrow("unsupported URL scheme 'ftp:'");
    expect(fetchCount).toBe(0);
  });
});

describe("config CLI help", () => {
  it("documents the API key as the only sign-in", async () => {
    const stdout: string[] = [];
    expect(await runCli(["--help"], { stdout: (text) => stdout.push(text) })).toBe(0);
    const help = stdout.join("");
    expect(help).toContain("CATALYST_API_KEY");
    expect(help).not.toContain("SERVER_CREDENTIAL");
    expect(help).toContain("list");
    expect(help).toContain("show <agent|skill> <name>");
    expect(help).toContain("--prune");
    expect(help).toContain("--only <agent:name|skill:name>");
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "catalyst-config-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFixture() {
  const clientInstanceId = asClientInstanceId("config-cli-test");
  const store = (await createTestInstance()).stores;
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "Config CLI test",
      environment: "development"
    },
    auth: {},
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
    tools: [{ name: "known.tool", enabled: true }]
  });
  const authOptions = {
    secret: "a-development-session-token-secret",
    clientInstanceId,
    issuer: "config-cli-test",
    ttlSeconds: 900
  };
  const issuer = new HmacSessionTokenIssuer(authOptions);
  const serviceAccessOptions = {
    secret: "a-development-service-access-secret-with-enough-length",
    clientInstanceId,
    apiAccessStore: store.apiAccess
  };
  const servicePrincipal = await store.apiAccess.createServicePrincipal({
    clientInstanceId,
    displayLabel: "Catalyst CLI",
    permissions: ["config_assets.read", "config_assets.release"]
  });
  const createdCredential = await store.apiAccess.createApiCredential({
    clientInstanceId,
    servicePrincipalId: servicePrincipal.id,
    name: "config CLI test",
    scopes: ["config_assets:read", "config_assets:release"]
  });
  const auditRecorder = new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit });
  const server = await createTestInstance({
    server: {
      config,
      clientInstanceId,
      authAdapter: new IdentityResolvingAuthAdapter(
        new CompositeAuthAdapter([
          new HmacServiceAccessTokenAuthAdapter(serviceAccessOptions),
          new HmacSessionTokenAuthAdapter(authOptions)
        ]),
        store.users
      ),
      stores: store,
      usageGovernance: new ModelUsageGovernance({
        store: store.usage,
        budget: config.usage.budget,
        safeguards: config.usage.safeguards,
        costs: config.usage.costs
      }),
      auditRecorder,
      configAssets: {
        store: store.configAssets,
        validationRefs: {
          modelProviderIds: ["local"],
          modelBindingIds: [],
          modelBindings: [],
          fastModeModelBindingIds: [],
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
          enabledToolNames: ["known.tool"]
        }
      },
      agentRuntime: createUnusedAgentRuntime(),
      modelProvider: createUnusedModelProvider(),
      sessionToken: { issuer, serverCredential: "server-credential" },
      serviceAccessToken: {
        exchange: new ApiKeyAccessTokenExchange(serviceAccessOptions)
      }
    }
  });
  servers.push(server);
  return { clientInstanceId, server, store, apiKey: createdCredential.secret };
}

async function writeMinimalManifest(directory: string, url: string): Promise<void> {
  await writeFile(
    resolve(directory, "catalyst.yaml"),
    `instances:\n  local:\n    url: ${url}\ndefaultInstance: local\nagents:\n  - agents/*.agent.yaml\nskills:\n  - skills/*/SKILL.md\n`,
    "utf8"
  );
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function pulledBaseline(
  version: number,
  bundle: { defaultAgentName?: string; agents: unknown[]; skills: unknown[] }
) {
  const contents = [
    ...bundle.agents.map((asset) => {
      const agent = canonicalizeAgentConfig(asset);
      return { key: `agent:${agent.name}`, contents: serializeAgentYaml(agent) };
    }),
    ...bundle.skills.map((asset) => {
      const skill = canonicalizeSkillConfig(asset);
      return {
        key: `skill:${skill.name}`,
        contents: JSON.stringify({ ...skill, content: skill.content.trim() })
      };
    })
  ];
  return {
    lastPulledVersion: version,
    defaultAgentName: bundle.defaultAgentName ?? null,
    assets: Object.fromEntries(
      contents.map((asset) => [
        asset.key,
        { revision: 1, hash: createHash("sha256").update(asset.contents).digest("hex") }
      ])
    )
  };
}

function configApiFetch(
  remote: {
    version: number;
    defaultAgentName?: string;
    agents: unknown[];
    skills: unknown[];
  },
  requests: unknown[] = [],
  pushedVersion = remote.version + 1
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith(testOperations["access_tokens.exchange"].buildPath({}))) {
      return jsonResponse(200, {
        accessToken: "short-lived-access-token",
        expiresAt: "2030-01-01T00:00:00.000Z"
      });
    }
    if (url.pathname.endsWith(testOperations["config_assets.export"].buildPath({}))) {
      return jsonResponse(200, {
        ...remote,
        perAssetConcurrency: true,
        revisions: Object.fromEntries([
          ...remote.agents.map((asset) => [`agent:${(asset as { name: string }).name}`, 1]),
          ...remote.skills.map((asset) => [`skill:${(asset as { name: string }).name}`, 1])
        ])
      });
    }
    if (url.pathname.endsWith(testOperations["config_assets.replace"].buildPath({}))) {
      requests.push(JSON.parse(await request.clone().text()));
      return jsonResponse(200, { version: pushedVersion });
    }
    return jsonResponse(404, { error: { code: "NOT_FOUND", message: "Not found" } });
  };
}

function recordFetch(
  fetchImpl: typeof fetch,
  requests: Array<{ url: string; init?: RequestInit }>
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: request.url,
      init: {
        method: request.method,
        headers: request.headers,
        ...(request.body === null ? {} : { body: await request.clone().text() })
      }
    });
    return fetchImpl(input, init);
  };
}

function agentConfig(instructions: string, overrides: { name?: string } = {}) {
  return {
    name: overrides.name ?? "assistant",
    displayName: "Assistant",
    instructions,
    modelProviderId: "local",
    toolNames: [],
    skillNames: [],
    initialPrompts: []
  };
}

function skillConfig(name: string, content: string) {
  return {
    name,
    title: name,
    description: `${name} skill`,
    content: `# ${content}`
  };
}

function createUnusedAgentRuntime(): AgentRuntime {
  return {
    async start() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async *observe() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async getStatus() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async resume() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    },
    async cancel() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config CLI tests");
    }
  };
}

function createUnusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used by config CLI tests");
    }
  };
}

// `catalyst config local-key` does for a local development instance what an operator does by
// hand under Administration, API Access. The browser runner creates its key with the same code
// against a running instance; these tests hold the rules around it.

const localSecret = "cat_test_local-secret-never-print-this";
const appConfig = resolve("tests/fixtures/e2e-app.yaml");
const principal = {
  id: "sp_local",
  clientInstanceId: "demo-e2e",
  displayLabel: "Local config CLI",
  status: "active",
  permissionRefs: [],
  permissions: ["config_assets.read", "config_assets.release"],
  createdAt: "2026-10-09T10:00:00Z",
  updatedAt: "2026-10-09T10:00:00Z"
};

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

function localJson(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

/** An instance that knows the seeded superadmin and, when told so, an earlier CLI principal. */
function localInstance(options: { existingPrincipal: boolean }) {
  const requests: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = await request.text();
    requests.push({
      method: request.method,
      path,
      headers: request.headers,
      body: text ? (JSON.parse(text) as unknown) : undefined
    });
    if (path === `${AUTH_MOUNT_PATH}/sign-in/email`) {
      return localJson(200, {}, { "set-cookie": "session=signed-in; Path=/; HttpOnly" });
    }
    if (request.headers.get("cookie") !== "session=signed-in") {
      return localJson(401, {
        error: { code: "UNAUTHENTICATED", message: "", correlationId: "r" }
      });
    }
    if (request.method === "GET" && path === testOperations["service_principals.list"].path) {
      return localJson(200, {
        items: options.existingPrincipal ? [{ principal, credentials: [] }] : []
      });
    }
    if (path === testOperations["service_principals.create"].path) {
      return localJson(200, { principal, credentials: [] });
    }
    return localJson(200, {
      credential: {
        id: "cred_local",
        clientInstanceId: "demo-e2e",
        servicePrincipalId: principal.id,
        name: "local development",
        keyPrefix: "cat_test_local",
        scopes: ["config_assets:read", "config_assets:release"],
        createdAt: "2026-10-09T10:00:00Z"
      },
      secret: localSecret
    });
  };
  return { requests, fetchImpl };
}

describe("catalyst config local-key", () => {
  async function workingCopy(instanceUrl: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "catalyst-local-key-"));
    temporaryDirectories.push(directory);
    await writeFile(
      join(directory, "catalyst.yaml"),
      `instances:\n  local:\n    url: "${instanceUrl}"\ndefaultInstance: local\nagents: []\nskills: []\n`
    );
    return directory;
  }

  async function run(cwd: string, fetchImpl: typeof fetch, extra: string[] = []) {
    const output: string[] = [];
    const code = await runCli(["config", "local-key", "--config", appConfig, ...extra], {
      cwd,
      fetchImpl,
      env: {},
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text)
    });
    return { code, output: output.join("") };
  }

  it("signs in as the seeded superadmin, creates the principal and a key with the two config scopes, and writes the key without printing it", async () => {
    const cwd = await workingCopy("http://127.0.0.1:4210");
    await writeFile(join(cwd, ".env"), "KEEP=1\nCATALYST_API_KEY=old\nALSO=kept\n");
    const instance = localInstance({ existingPrincipal: false });

    const result = await run(cwd, instance.fetchImpl);

    expect(result.output).not.toContain(localSecret);
    expect(result.code).toBe(0);
    expect(result.output).toContain("wrote CATALYST_API_KEY to");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(
      `KEEP=1\nCATALYST_API_KEY=${localSecret}\nALSO=kept\n`
    );
    const [signIn, list, createPrincipal, createKey] = instance.requests;
    expect(signIn?.body).toEqual({
      email: "e2e-superadmin@example.test",
      password: "e2e-superadmin-password"
    });
    expect(signIn?.headers.get("origin")).toBe("http://127.0.0.1:5273");
    expect(list?.headers.get("origin")).toBe("http://127.0.0.1:5273");
    expect(createPrincipal?.body).toEqual({
      displayLabel: "Local config CLI",
      permissions: ["config_assets.read", "config_assets.release"]
    });
    expect(createKey?.body).toEqual({
      name: "local development",
      scopes: ["config_assets:read", "config_assets:release"]
    });
    expect(instance.requests).toHaveLength(4);
  });

  it("reuses the principal of an earlier call and writes a variable and file it is told", async () => {
    const cwd = await workingCopy("http://localhost:4210");
    const instance = localInstance({ existingPrincipal: true });

    const result = await run(cwd, instance.fetchImpl, [
      "--write-env",
      "local.env",
      "--env-name",
      "CATALYST_API_KEY_LOCAL"
    ]);

    expect(result.code).toBe(0);
    expect(instance.requests.map((request) => request.method)).toEqual(["POST", "GET", "POST"]);
    expect(instance.requests[2]?.path).toBe(
      testOperations["api_credentials.create"].buildPath({
        params: { servicePrincipalId: principal.id }
      })
    );
    expect(await readFile(join(cwd, "local.env"), "utf8")).toBe(
      `CATALYST_API_KEY_LOCAL=${localSecret}\n`
    );
  });

  it("refuses any host other than this machine before it sends a request", async () => {
    const cwd = await workingCopy("https://catalyst.example.com");
    const instance = localInstance({ existingPrincipal: false });

    const result = await run(cwd, instance.fetchImpl);

    expect(result.code).toBe(1);
    expect(result.output).toContain("Refusing to create a local API key on 'catalyst.example.com'");
    expect(instance.requests).toEqual([]);
  });

  it("refuses a config that is not a development config", async () => {
    const cwd = await workingCopy("http://127.0.0.1:4210");
    const production = join(cwd, "app.yaml");
    await writeFile(
      production,
      (await readFile(appConfig, "utf8")).replace(
        "environment: development",
        "environment: production"
      )
    );
    const instance = localInstance({ existingPrincipal: false });
    const output: string[] = [];

    const code = await runCli(["config", "local-key", "--config", production], {
      cwd,
      fetchImpl: instance.fetchImpl,
      env: {},
      stderr: (text) => output.push(text)
    });

    expect(code).toBe(1);
    expect(instance.requests).toEqual([]);
  });

  it("keeps its options to itself and names where a key comes from", async () => {
    const cwd = await workingCopy("http://127.0.0.1:4210");
    const output: string[] = [];
    expect(
      await runCli(["config", "pull", "--write-env", ".env"], {
        cwd,
        stderr: (text) => output.push(text)
      })
    ).toBe(2);
    expect(await runCli(["config", "pull"], { cwd, env: {}, stderr: (t) => output.push(t) })).toBe(
      1
    );
    expect(output.join("")).toContain("Administration, API Access");
    expect(output.join("")).toContain("catalyst config local-key");
  });
});
