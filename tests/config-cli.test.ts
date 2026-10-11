import {
  callTestPath,
  createTestFetch,
  createTestInstance,
  type TestInstance
} from "./support/test-instance";
import { testOperations } from "./support/operations";
import { retiredReleasePaths } from "./support/retired-api-paths";

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUTH_MOUNT_PATH } from "@vivd-catalyst/api-client";
import { UNKNOWN_OPERATION_REASON } from "@vivd-catalyst/api-contract";
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
  type JsonObject,
  type RuntimeCallContext
} from "@vivd-catalyst/core";

import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { FakeModelProvider as ModelProvider } from "./support/model-gateway";
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
    const { fetchImpl } = await instanceHolding({ agents: [], skills: [] }, pushed);
    expect(
      await runConfigCommand("push", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_package" },
        fetchImpl
      })
    ).toBe(0);
    expect(pushed.at(-1)).toMatchObject({
      items: [{ type: "put", kind: "skill", config: local.skills[0] }]
    });

    await writeFile(resolve(skillDirectory, "references", "stale.md"), "stale", "utf8");
    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_package" },
        // The instance holds the package the push wrote.
        fetchImpl
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
        fetchImpl: (await instanceHolding({ agents: [], skills: [conflictingPackage] })).fetchImpl,
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
      instances: { local: pulledBaseline(1, { agents: [], skills: [remoteSkill] }) }
    });
    const stdout: string[] = [];

    expect(
      await runConfigCommand("push", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_resource_plan" },
        fetchImpl: (await instanceHolding({ agents: [], skills: [remoteSkill] })).fetchImpl,
        stdout: (text) => stdout.push(text)
      })
    ).toBe(0);
    expect(stdout.join("")).toContain("Updated: 1");
    expect(stdout.join("")).toContain("Unchanged: 0");
  });

  it("prefers API-key exchange, then pulls, pushes, and reports a stale asset", async () => {
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
    await writeMinimalManifest(directory, "https://catalyst.test", "assistant");
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
      defaultAgentName: "assistant",
      agents: [
        agentConfig("Remote", { name: "assistant" }),
        agentConfig("Remote only", { name: "remote-only" })
      ],
      skills: []
    };
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: pulledBaseline(1, remote) }
    });
    const mergeRequests: unknown[] = [];
    const { fetchImpl } = await instanceHolding(remote, mergeRequests);
    const mergeStdout: string[] = [];
    expect(
      await runConfigCommand("push", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_plan" },
        fetchImpl,
        stdout: (text) => mergeStdout.push(text)
      })
    ).toBe(0);
    expect(mergeStdout.join("")).toContain(
      "Push plan (merge):\n  Added: 1\n  Updated: 1\n  Unchanged: 0"
    );
    expect(mergeStdout.join("")).toContain("- agent:remote-only");
    expect(mergeStdout.join("")).toContain("Use --prune to delete them.");
    // One call: the changed asset against the revision of the last pull, the new one against
    // none, and no delete of the asset the working copy does not hold.
    expect(mergeRequests).toEqual([
      {
        items: [
          {
            type: "put",
            kind: "agent",
            config: canonicalizeAgentConfig(agentConfig("Local update")),
            expectedRevision: 1
          },
          {
            type: "put",
            kind: "agent",
            config: canonicalizeAgentConfig(agentConfig("New", { name: "new" }))
          }
        ]
      }
    ]);

    // The same working copy with --prune: the remote-only asset is deleted at the revision
    // the last pull recorded, and nothing else is sent.
    const pruneStdout: string[] = [];
    expect(
      await runConfigCommand("push", {
        cwd: directory,
        prune: true,
        env: { CATALYST_API_KEY: "cat_plan" },
        fetchImpl,
        stdout: (text) => pruneStdout.push(text)
      })
    ).toBe(0);
    expect(pruneStdout.join("")).toContain("Push plan (mirror):");
    expect(pruneStdout.join("")).toContain("Deleted: 1");
    expect(pruneStdout.join("")).toContain("Assets to delete:\n- agent:remote-only");
    expect(mergeRequests).toHaveLength(2);
    expect(mergeRequests[1]).toEqual({
      items: [{ type: "delete", kind: "agent", name: "remote-only", expectedRevision: 1 }]
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
      instances: { local: pulledBaseline(1, { agents: [agentConfig("Remote")], skills: [] }) }
    });
    const requests: unknown[] = [];
    expect(
      await runCli(["config", "push", "--only", "agent:assistant", "--only", "skill:review"], {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_scoped" },
        fetchImpl: (
          await instanceHolding(
            { defaultAgentName: "assistant", agents: [agentConfig("Remote")], skills: [] },
            requests
          )
        ).fetchImpl
      })
    ).toBe(0);
    expect(requests).toEqual([
      {
        items: [
          {
            type: "put",
            kind: "agent",
            config: canonicalizeAgentConfig(agentConfig("Selected")),
            expectedRevision: 1
          },
          { type: "put", kind: "skill", config: skillConfig("review", "Review") }
        ]
      }
    ]);

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
    await writeMinimalManifest(directory, "https://catalyst.test", "assistant");
    await mkdir(resolve(directory, "agents"), { recursive: true });
    await writeFile(
      resolve(directory, "agents", "assistant.agent.yaml"),
      serializeAgentYaml(agentConfig("Default")),
      "utf8"
    );
    await writeFile(
      resolve(directory, "agents", "kai-tax.agent.yaml"),
      serializeAgentYaml(agentConfig("Tax", { name: "kai-tax" })),
      "utf8"
    );
    // The instance holds the agent under its old name, placed in chosen workspaces.
    const { fetchImpl, fixture } = await instanceHolding({
      defaultAgentName: "assistant",
      agents: [agentConfig("Default"), agentConfig("Tax", { name: "kai" })],
      skills: []
    });
    await fixture.store.configAssets.setAgentAvailability({
      clientInstanceId: fixture.clientInstanceId,
      agentName: "kai",
      availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });
    const push = async (...flags: string[]) => {
      const stdout: string[] = [];
      const exitCode = await runCli(["config", "push", "--force", ...flags], {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_hidden" },
        stdout: (text) => stdout.push(text),
        fetchImpl
      });
      expect(exitCode).toBe(0);
      return stdout.join("");
    };

    // Deleting the old name and adding the new one in one push is a rename.
    const hidden = await push("--prune");
    expect(hidden).toContain("Pushed 2 agents, 0 skills, version 2.");
    expect(hidden).toContain(
      "Hidden in every workspace until an instance admin sets their availability:\n  agent:kai-tax\n"
    );
    // Once an admin has placed the agent, a push of it prints no notice.
    await fixture.store.configAssets.setAgentAvailability({
      clientInstanceId: fixture.clientInstanceId,
      agentName: "kai-tax",
      availability: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
    });
    expect(await push()).not.toContain("Hidden in every workspace");
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
        fetchImpl: (
          await instanceHolding({
            agents: [agentConfig("New selected"), agentConfig("New other", { name: "other" })],
            skills: []
          })
        ).fetchImpl,
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
    // A server from before the asset operations answers their addresses as unknown.
    const olderServerFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(new URL(request.url).pathname);
      return new URL(request.url).pathname.endsWith("access-token")
        ? jsonResponse(200, { accessToken: "token", expiresAt: "2030-01-01T00:00:00.000Z" })
        : jsonResponse(404, {
            error: {
              code: "NOT_FOUND",
              message: "Not found",
              details: { reason: UNKNOWN_OPERATION_REASON }
            }
          });
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
    expect(errors.join("")).toContain(
      "This instance does not serve the asset operations this CLI uses. Upgrade the instance"
    );
    expect(requests).not.toContain(testOperations["assets.sync"].buildPath({}));
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
    await mkdir(resolve(directory, "agents"), { recursive: true });
    await writeFile(
      resolve(directory, "agents", "assistant.agent.yaml"),
      serializeAgentYaml(agentConfig("Local")),
      "utf8"
    );
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: { lastPulledVersion: 0, assets: {}, defaultAgentName: null } }
    });
    // Both assets appeared on the instance since: the working copy pushes them as new.
    const { fetchImpl, fixture } = await instanceHolding({ agents: [], skills: [] });
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      actor: { displayLabel: "Reviewer", roles: ["admin"] },
      mutations: [
        { type: "upsert", kind: "skill", name: "review", config: skillConfig("review", "One") }
      ]
    });
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      actor: { displayLabel: "Reviewer", roles: ["admin"] },
      mutations: [
        { type: "upsert", kind: "skill", name: "review", config: skillConfig("review", "Two") }
      ]
    });
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      actor: { displayLabel: "Admin", roles: ["admin"] },
      mutations: [
        { type: "upsert", kind: "agent", name: "assistant", config: agentConfig("Remote") }
      ]
    });
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
    expect(errors.join("")).toContain("Push conflict; nothing was applied.");
    expect(errors.join("")).toMatch(
      /- skill:review: revision 2, update by Reviewer at \d{4}-\d{2}-\d{2}T/u
    );
    expect(errors.join("")).toMatch(
      /- agent:assistant: revision 1, create by Admin at \d{4}-\d{2}-\d{2}T/u
    );
    expect(errors.join("")).toContain(
      "catalyst config pull --dir 'working copy' --instance local --only agent:assistant --only skill:review"
    );
    // Nothing of the push landed.
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill",
        name: "review"
      })
    ).toMatchObject({ revision: 2, config: { content: "# Two" } });
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
    const { fetchImpl } = await instanceHolding({
      agents: [agentConfig("Remote")],
      skills: [remoteSkill]
    });
    const listOutput: string[] = [];
    expect(
      await runCli(["config", "list"], {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_list" },
        fetchImpl,
        stdout: (text) => listOutput.push(text)
      })
    ).toBe(0);
    expect(listOutput.join("")).toContain("agent\tassistant\t1\t-");
    expect(listOutput.join("")).toContain("skill\treview\t1\tmissing locally");
    expect(listOutput.join("")).toContain("skill\tlocal-only\t-\tmissing remotely");

    const agentOutput: string[] = [];
    expect(
      await runCli(["config", "show", "agent", "assistant"], {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_show" },
        fetchImpl,
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
        fetchImpl,
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

describe("config CLI against an instance", () => {
  const releasedAgents = [
    {
      ...agentConfig("Answer with the guides."),
      toolNames: ["known.tool", "read_skill"],
      skillNames: ["intake", "review"],
      initialPrompts: [{ title: "Start", prompt: "What do you need?" }]
    },
    agentConfig("Help.", { name: "helper" }),
    { ...agentConfig("Research.", { name: "researcher" }), reasoningEffort: "high" }
  ];
  const releasedSkills = [
    skillConfig("intake", "Ask first."),
    {
      ...skillConfig("review", "Review with the checks."),
      resources: [
        { path: "references/checks.md", mediaType: "text/markdown", content: "# Checks\n" },
        { path: "references/schema.json", mediaType: "application/json", content: '{"ok":true}\n' }
      ]
    }
  ];

  async function writeRelease(directory: string): Promise<void> {
    await writeMinimalManifest(directory, "https://catalyst.test", "assistant");
    await mkdir(resolve(directory, "agents"), { recursive: true });
    for (const agent of releasedAgents) {
      await writeFile(
        resolve(directory, "agents", `${agent.name}.agent.yaml`),
        serializeAgentYaml(canonicalizeAgentConfig(agent)),
        "utf8"
      );
    }
    for (const skill of releasedSkills) {
      const { resources = [], ...root } = { resources: undefined, ...skill };
      await mkdir(resolve(directory, "skills", skill.name, "references"), { recursive: true });
      await writeFile(
        resolve(directory, "skills", skill.name, "SKILL.md"),
        serializeSkillMarkdown(root),
        "utf8"
      );
      for (const resource of resources) {
        await writeFile(resolve(directory, "skills", skill.name, resource.path), resource.content);
      }
    }
  }

  const workingCopy = async (directory: string) =>
    readWorkingCopy(directory, await readManifest(directory));
  const syncRuns = async (fixture: Awaited<ReturnType<typeof createFixture>>) =>
    (await fixture.store.operationRuns.list({ clientInstanceId: fixture.clientInstanceId })).filter(
      (run) => run.operation === "assets.sync"
    );

  it("pushes a whole release in one call and pulls it back unchanged", async () => {
    const syncs: unknown[] = [];
    const { fetchImpl, fixture } = await instanceHolding({ agents: [], skills: [] }, syncs);
    const directory = await createTemporaryDirectory();
    await writeRelease(directory);
    const local = await workingCopy(directory);
    const stdout: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_release" },
      fetchImpl,
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stdout.push(text)
    };

    // A working copy that never pulled pushes with --force.
    expect(await runConfigCommand("push", { ...options, force: true }), stdout.join("")).toBe(0);
    expect(stdout.join("")).toContain("Pushed 3 agents, 2 skills, version 1.");
    // One call carries every asset and the default agent, and leaves one run of the CLI.
    expect(syncs).toHaveLength(1);
    expect(syncs[0]).toMatchObject({ defaultAgentName: "assistant" });
    expect(syncs[0]).toHaveProperty("items.length", 5);
    const runs = await syncRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ origin: { kind: "cli" }, status: "done" });

    // Another working copy pulls the release as it was pushed.
    const other = await createTemporaryDirectory();
    await writeMinimalManifest(other, "https://catalyst.test");
    expect(await runConfigCommand("pull", { ...options, cwd: other })).toBe(0);
    const pulled = await workingCopy(other);
    expect(pulled).toEqual(local);
    expect(canonicalBundleFiles(pulled)).toEqual(canonicalBundleFiles(local));

    // The pushing one has nothing to pull, to show or to push again.
    expect(await runConfigCommand("pull", options)).toBe(0);
    expect(await workingCopy(directory)).toEqual(local);
    stdout.length = 0;
    expect(await runConfigCommand("diff", options)).toBe(0);
    expect(stdout.join("")).toContain("No differences.");
    expect(await runConfigCommand("push", options)).toBe(0);
    expect(stdout.join("")).toContain("No local changes to push.");
    expect(syncs).toHaveLength(1);
    expect(await syncRuns(fixture)).toHaveLength(1);
  });

  it("sends a push whose answer was lost again under the same key, and the instance writes once", async () => {
    const { fetchImpl, fixture } = await instanceHolding({
      defaultAgentName: "assistant",
      agents: [agentConfig("Remote")],
      skills: []
    });
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test", "assistant");
    const options = { cwd: directory, env: { CATALYST_API_KEY: "cat_retry" }, stdout: () => {} };
    expect(await runConfigCommand("pull", { ...options, fetchImpl })).toBe(0);
    await writeFile(
      resolve(directory, "agents", "assistant.agent.yaml"),
      serializeAgentYaml(canonicalizeAgentConfig(agentConfig("Local"))),
      "utf8"
    );

    const keys: Array<string | null> = [];
    const dropping: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await fetchImpl(request);
      if (new URL(request.url).pathname !== testOperations["assets.sync"].path) return response;
      keys.push(request.headers.get("idempotency-key"));
      // The instance applied the first call, and its answer never arrives.
      if (keys.length === 1) throw new TypeError("fetch failed");
      return response;
    };
    const waits: number[] = [];
    expect(
      await runConfigCommand("push", {
        ...options,
        fetchImpl: dropping,
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        }
      })
    ).toBe(0);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
    expect(waits).toHaveLength(1);
    // One revision and one run, and the baseline is the revision the instance holds.
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "agent",
        name: "assistant"
      })
    ).toMatchObject({ revision: 2, config: { instructions: "Local" } });
    expect(await syncRuns(fixture)).toHaveLength(1);
    expect(
      (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local?.assets?.[
        "agent:assistant"
      ]
    ).toMatchObject({ revision: 2 });
  });

  it("validates the working copy as one set, a new skill a new agent names included, and writes nothing", async () => {
    const { fetchImpl, fixture } = await instanceHolding({ agents: [], skills: [] });
    const directory = await createTemporaryDirectory();
    await writeRelease(directory);
    const output: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_validate" },
      fetchImpl,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text)
    };

    expect(await runConfigCommand("validate", options), output.join("")).toBe(0);
    expect(output.join("")).toContain("Valid: 3 agents, 2 skills.");

    // The instance says what it refuses, in the words of a push.
    await rm(resolve(directory, "skills", "intake"), { recursive: true });
    output.length = 0;
    expect(await runConfigCommand("validate", options)).toBe(1);
    expect(output.join("")).toContain("Validation failed:");
    expect(output.join("")).toContain("Agent 'assistant' references missing skill 'intake'");

    expect(
      await fixture.store.configAssets.getConfigAssetState({
        clientInstanceId: fixture.clientInstanceId
      })
    ).toMatchObject({ version: 0 });
    expect(await syncRuns(fixture)).toEqual([]);
  });

  it("is told to push in parts where the release is larger than one request may be", async () => {
    const { fetchImpl, fixture } = await instanceHolding({ agents: [], skills: [] });
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    // Twelve skills of 100 KiB are over the megabyte one request holds.
    for (let index = 0; index < 12; index += 1) {
      const name = `guide-${index}`;
      await mkdir(resolve(directory, "skills", name), { recursive: true });
      await writeFile(
        resolve(directory, "skills", name, "SKILL.md"),
        serializeSkillMarkdown(skillConfig(name, "x".repeat(100 * 1024))),
        "utf8"
      );
    }
    const errors: string[] = [];
    const options = {
      cwd: directory,
      force: true,
      env: { CATALYST_API_KEY: "cat_large" },
      fetchImpl,
      stdout: () => {},
      stderr: (text: string) => errors.push(text)
    };

    expect(await runConfigCommand("push", options)).toBe(1);
    expect(errors.join("")).toBe(
      "The request is larger than the instance accepts in one call. Push in parts with --only.\n"
    );
    expect(
      await fixture.store.configAssets.getConfigAssetState({
        clientInstanceId: fixture.clientInstanceId
      })
    ).toMatchObject({ version: 0 });
    // A part of it fits.
    expect(
      await runConfigCommand("push", { ...options, only: ["skill:guide-0", "skill:guide-1"] })
    ).toBe(0);
  });

  it.each(retiredReleasePaths)(
    "tells a CLI of an earlier release to upgrade at %s %s",
    async (method, path) => {
      const fixture = await createFixture();
      const answer = await callTestPath(fixture.server, method, path, {
        authorization: `Bearer ${fixture.apiKey}`
      });
      expect(answer.statusCode).toBe(404);
      // The earlier CLI prints the code and this sentence.
      expect(answer.json()).toMatchObject({
        error: {
          code: "NOT_FOUND",
          message:
            "This address is gone: config assets are read and written through /api/v1/assets. Upgrade the Catalyst CLI to the release of this server.",
          details: { reason: UNKNOWN_OPERATION_REASON }
        }
      });
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

    const failure = await api.getOverview().catch((error: unknown) => error);
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
          enabledToolNames: ["known.tool", "read_skill"]
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

async function writeMinimalManifest(
  directory: string,
  url: string,
  defaultAgentName?: string
): Promise<void> {
  const defaultAgent =
    defaultAgentName === undefined ? "" : `defaultAgentName: ${defaultAgentName}\n`;
  await writeFile(
    resolve(directory, "catalyst.yaml"),
    `instances:\n  local:\n    url: ${url}\ndefaultInstance: local\n${defaultAgent}agents:\n  - agents/*.agent.yaml\nskills:\n  - skills/*/SKILL.md\n`,
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

interface HeldAssets {
  defaultAgentName?: string;
  agents: ReadonlyArray<JsonObject & { name: string }>;
  skills: ReadonlyArray<JsonObject & { name: string }>;
}

/**
 * A real instance that holds these assets, each at revision 1, behind a fetch for the CLI.
 * The fetch signs in with the instance's key whatever key the command names, and records
 * the body of every `assets.sync` the CLI sends.
 */
async function instanceHolding(remote: HeldAssets, syncs: unknown[] = []) {
  const fixture = await createFixture();
  const mutations = [
    ...remote.agents.map((config) => ({
      type: "upsert" as const,
      kind: "agent",
      name: config.name,
      config
    })),
    ...remote.skills.map((config) => ({
      type: "upsert" as const,
      kind: "skill",
      name: config.name,
      config
    })),
    ...(remote.defaultAgentName === undefined
      ? []
      : [{ type: "setDefaultAgent" as const, agentName: remote.defaultAgentName }])
  ];
  if (mutations.length > 0) {
    await fixture.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations
    });
  }
  const serverFetch = createTestFetch(fixture.server);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === testOperations["access_tokens.exchange"].path) {
      return serverFetch(request.url, {
        method: request.method,
        headers: { authorization: `Bearer ${fixture.apiKey}` }
      });
    }
    if (path === testOperations["assets.sync"].path) {
      syncs.push(JSON.parse(await request.clone().text()));
    }
    return serverFetch(request);
  };
  return { fetchImpl, fixture };
}

/** An instance without assets, reached under another address. The addresses are recorded. */
async function emptyInstanceBehind(baseUrl: string, requests: string[]): Promise<typeof fetch> {
  const { fetchImpl } = await instanceHolding({ agents: [], skills: [] });
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.url);
    const body = request.body ? await request.clone().text() : undefined;
    return fetchImpl(`https://catalyst.test${request.url.slice(baseUrl.length)}`, {
      method: request.method,
      headers: request.headers,
      ...(body === undefined ? {} : { body })
    });
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
