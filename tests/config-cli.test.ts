import {
  callTestPath,
  createTestAssetKinds,
  createTestFetch,
  createTestInstance,
  type TestInstance
} from "./support/test-instance";
import { testOperations } from "./support/operations";
import { retiredReleasePaths } from "./support/retired-api-paths";

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ASSET_SYNC_BODY_MAX_BYTES,
  ASSET_SYNC_ITEM_MAX_BYTES,
  RELEASE_VERSION,
  UNKNOWN_OPERATION_REASON
} from "@vivd-catalyst/api-contract";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

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
  asUserId,
  createAssetKindRegistry,
  type AgentRuntime,
  type JsonObject,
  type RuntimeCallContext
} from "@vivd-catalyst/core";

import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  createScriptedInstanceModelGateway,
  type FakeModelProvider as ModelProvider
} from "./support/model-gateway";
import {
  GuardrailRunner,
  createAuditingEventEmitter,
  createGuardrailAssetKind
} from "@vivd-catalyst/chat-server";
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
  renderCatalystSkill,
  resolveSkillResourceTarget,
  resolveInstance,
  runCli,
  runConfigCommand,
  serializeAgentYaml,
  serializeSkillMarkdown,
  writeStateFile,
  updateManifestDefaultAgent
} from "../packages/config-cli/src/index";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  agentConfig as namespaceAgentConfig,
  grantKaiNamespace,
  inDays,
  setupPersonalKeyInstance,
  type PersonalKeyInstance
} from "./support/personal-api-keys";
import {
  agent as namespaceAgent,
  clientInstanceId as accessInstanceId,
  recordAuthAdapter,
  setupAccessInstance,
  skill as accessSkill
} from "./support/access-instance";
import { IBAN as GUARDRAIL_IBAN, guardedEvents, ibanPattern } from "./support/guardrails";
import { setupNamespaceHolder } from "./support/asset-operations";
import { appFiles, setupAppInstance } from "./support/app-instance";

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

  it("keeps a skill's summary through a pull and a push, and writes none where there is none", () => {
    const skill = {
      name: "review",
      title: "Review",
      description: "Review a workflow",
      content: "# Review"
    };
    const summary = "Knows how to review a workflow and name what is missing.";
    const serialized = serializeSkillMarkdown({ ...skill, summary });

    expect(serialized).toContain(`summary: ${summary}\n`);
    expect(parseSkillFile(serialized)).toEqual({ ...skill, summary });
    expect(canonicalizeSkillConfig({ ...skill, summary })).toEqual({ ...skill, summary });
    expect(serializeSkillMarkdown(skill)).not.toContain("summary");
  });

  it("keeps starters through a pull and a push and writes none where there are none", () => {
    const plain = { name: "sheets", title: "Sheets", description: "When.", content: "# Text" };
    const starters = [
      { title: { en: "Build", de: "Bauen" }, hint: "Short", prompt: "Build it.", tools: ["a.b"] }
    ];
    const serialized = serializeSkillMarkdown({ ...plain, starters });

    expect(parseSkillFile(serialized)).toEqual({ ...plain, starters });
    expect(canonicalizeSkillConfig({ ...plain, starters })).toEqual({ ...plain, starters });
    expect(serializeSkillMarkdown(plain)).not.toContain("starters");
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

  it("resolves named, default, and direct URL instances", async () => {
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

    expect(await resolveInstance(manifest)).toEqual({
      key: "local",
      url: "http://127.0.0.1:4100"
    });
    expect(await resolveInstance(manifest, { instance: "local" })).toEqual({
      key: "local",
      url: "http://127.0.0.1:4100"
    });
    expect(await resolveInstance(manifest, { instance: "https://catalyst.example.test/" })).toEqual(
      { key: "https://catalyst.example.test/", url: "https://catalyst.example.test" }
    );
  });

  it("takes the one instance a key is saved for outside a working copy only, and never with CATALYST_API_KEY set", async () => {
    const configHome = await createTemporaryDirectory();
    const env = { CATALYST_CONFIG_HOME: configHome };
    await expect(resolveInstance(undefined, { env })).rejects.toThrow(
      "No instance selected; pass --instance or set defaultInstance in catalyst.yaml. No key is saved; 'catalyst login --instance <https-url>' saves one."
    );
    await saveCredentialsFor(configHome, ["https://catalyst.test"]);
    expect(await resolveInstance(undefined, { env })).toEqual({
      key: "https://catalyst.test",
      url: "https://catalyst.test"
    });
    // An automation key's instance is not the saved one's.
    await expect(
      resolveInstance(undefined, { env: { ...env, CATALYST_API_KEY: "cat_automation" } })
    ).rejects.toThrow("CATALYST_API_KEY is set: name the instance it belongs to.");
    // A working copy names its instances itself, even the saved one, and a key never chooses.
    const manifest = parseManifest(`instances:
  production:
    url: https://catalyst.test
    namespace: tax-
agents: []
skills: []
`);
    await expect(resolveInstance(manifest, { env })).rejects.toThrow(
      "No instance selected; pass --instance or set defaultInstance in catalyst.yaml. catalyst.yaml names production."
    );
    await saveCredentialsFor(configHome, ["https://catalyst.test", "https://other.test"]);
    await expect(resolveInstance(undefined, { env })).rejects.toThrow(
      "Keys are saved for https://catalyst.test, https://other.test."
    );
  });

  // Verifier repros (CONNECT-1a, second verification, verify/connect-1a-2 5317122c): the fallback
  // that fixed `catalyst context` outside a working copy also picked an instance inside a working
  // copy whose catalyst.yaml names its instances without a default.
  it("does not switch a root that names another instance to the one a key is saved for", async () => {
    const manifest = parseManifest(`instances:
  production:
    url: https://chat.customer.test
agents: []
skills: []
`);
    const configHome = await createTemporaryDirectory();
    await saveCredentialsFor(configHome, ["https://chat.other.test"]);
    const env = { CATALYST_CONFIG_HOME: configHome };
    await expect(resolveInstance(manifest, { env })).rejects.toThrow("No instance selected");
  });

  it("does not pick production in a root of staging and production without a default", async () => {
    const manifest = parseManifest(`instances:
  staging:
    url: https://staging.chat.customer.test
  production:
    url: https://chat.customer.test
agents: []
skills: []
`);
    const configHome = await createTemporaryDirectory();
    await saveCredentialsFor(configHome, ["https://chat.customer.test"]);
    const env = { CATALYST_CONFIG_HOME: configHome };
    await expect(resolveInstance(manifest, { env })).rejects.toThrow("No instance selected");
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
      skills: [],
      guardrails: []
    });
    const local = canonicalBundleFiles({
      defaultAgentName: "assistant",
      agents: [agentConfig("Local instructions")],
      skills: [],
      guardrails: []
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
    expect(stdout.join("")).toContain("Pushed 1 agent, 0 skills, version 2.");
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "agent",
        name: "assistant"
      })
    ).toMatchObject({ config: { instructions: "Local instructions" } });

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
    expect(stderr.join("")).toContain("agent:assistant: revision 3, changed by");
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
    ).toMatchObject({ revision: 3, config: { instructions: "New remote instructions" } });
  });

  it("rejects noncanonical pull globs before writing or deleting assets", async () => {
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
    const { fetchImpl, fixture } = await instanceHolding(remote, mergeRequests);
    // A row of a kind no release carries, left by a module that is off, and a skill that ships
    // with the platform, which no working copy holds.
    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        { type: "upsert", kind: "connection", name: "crm", config: { name: "crm", title: "CRM" } },
        {
          type: "upsert",
          kind: "skill",
          name: "platform-docs",
          config: {
            name: "platform-docs",
            title: "Platform documentation",
            description: "Shipped.",
            content: "Shipped.",
            origin: "release",
            icon: "guide"
          }
        }
      ]
    });
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
            expectedRevision: 1,
            expectedAssetId: "cfga_held_agent_assistant"
          },
          {
            type: "put",
            kind: "agent",
            config: canonicalizeAgentConfig(agentConfig("New", { name: "new" })),
            expectedRevision: null
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
      items: [
        {
          type: "delete",
          kind: "agent",
          name: "remote-only",
          expectedAssetId: "cfga_held_agent_remote-only",
          expectedRevision: 1
        }
      ]
    });
    expect(pruneStdout.join("")).not.toContain("crm");
    expect(mergeStdout.join("") + pruneStdout.join("")).not.toContain("platform-docs");
    for (const [kind, name] of [
      ["connection", "crm"],
      ["skill", "platform-docs"]
    ] as const) {
      expect(
        await fixture.store.configAssets.getConfigAsset({
          clientInstanceId: fixture.clientInstanceId,
          kind,
          name
        })
      ).toMatchObject({ status: "active", revision: 1 });
    }
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
            expectedRevision: 1,
            expectedAssetId: "cfga_held_agent_assistant"
          },
          {
            type: "put",
            kind: "skill",
            config: skillConfig("review", "Review"),
            expectedRevision: null
          }
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
    const held = {
      defaultAgentName: "assistant",
      agents: [agentConfig("Default"), agentConfig("Tax", { name: "kai" })],
      skills: []
    };
    const { fetchImpl, fixture } = await instanceHolding(held);
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: pulledBaseline(1, held) }
    });
    await fixture.store.configAssets.setAgentAvailability({
      clientInstanceId: fixture.clientInstanceId,
      agentName: "kai",
      availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
    });
    const push = async (...flags: string[]) => {
      const stdout: string[] = [];
      const exitCode = await runCli(["config", "push", ...flags], {
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
    expect(hidden).toContain("Pushed 1 agent, 0 skills, version 3.");
    expect(hidden).toContain(
      "Hidden in every workspace until an instance admin sets their availability:\n  agent:kai-tax\n"
    );
    // Once an admin has placed the agent, a push of it prints no notice.
    await fixture.store.configAssets.setAgentAvailability({
      clientInstanceId: fixture.clientInstanceId,
      agentName: "kai-tax",
      availability: { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] }
    });
    await writeFile(
      resolve(directory, "agents", "kai-tax.agent.yaml"),
      serializeAgentYaml(agentConfig("Tax, edited", { name: "kai-tax" })),
      "utf8"
    );
    const placed = await push();
    expect(placed).toContain("Pushed 1 agent, 0 skills, version 5.");
    expect(placed).not.toContain("Hidden in every workspace");
  });

  // Fails without the change: no guardrail ran at `asset.before_write`, and the skill with the
  // IBAN was pushed.
  it("prints the guardrail, the skill and the reason when a guardrail blocks a push", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await mkdir(resolve(directory, "skills", "kunden-faq"), { recursive: true });
    await writeFile(
      resolve(directory, "skills", "kunden-faq", "SKILL.md"),
      serializeSkillMarkdown({
        name: "kunden-faq",
        title: "Kunden-FAQ",
        description: "Fragen von Kunden",
        content: "Überweisungen gehen an DE89 3704 0044 0532 0130 00."
      }),
      "utf8"
    );
    const { fetchImpl, fixture } = await instanceHolding(
      { agents: [], skills: [] },
      [],
      heldAssetId,
      {
        no_iban: {
          displayName: "No IBAN in skills",
          on: "asset.before_write",
          filter: { kind: "skill" },
          check: {
            kind: "pattern",
            pattern: "\\bDE\\d{2}(?:\\s?\\d{4}){4}\\s?\\d{2}\\b",
            reason: "Skills hold no bank account."
          },
          outcome: "block"
        }
      }
    );
    await recordEmptyPull(directory);
    const stderr: string[] = [];
    const exitCode = await runCli(["config", "push"], {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_guarded" },
      stderr: (text) => stderr.push(text),
      fetchImpl
    });
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain(
      "Guardrail 'No IBAN in skills' blocked skill 'kunden-faq': Skills hold no bank account."
    );
    expect(stderr.join("")).not.toContain("3704 0044");
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill",
        name: "kunden-faq"
      })
    ).toBeUndefined();
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
          assets: {
            "agent:assistant": {
              id: "cfga_held_agent_assistant",
              revision: 1,
              hash: expect.any(String)
            }
          }
        }
      }
    });
    expect(stdout.join("")).toContain("selected asset baselines updated");
  });

  it("migrates legacy state by refusing an unguarded push, and names the upgrade to an older server", async () => {
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
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: pulledBaseline(8, { agents: [], skills: [] }) }
    });
    expect(
      await runConfigCommand("push", {
        cwd: directory,
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
    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      actor: { displayLabel: "Reviewer", roles: ["admin"] },
      mutations: [
        { type: "upsert", kind: "skill", name: "review", config: skillConfig("review", "One") }
      ]
    });
    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      actor: { displayLabel: "Reviewer", roles: ["admin"] },
      mutations: [
        { type: "upsert", kind: "skill", name: "review", config: skillConfig("review", "Two") }
      ]
    });
    await applyAtCurrentRevisions(fixture.store.configAssets, {
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
      /- skill:review: revision 2, changed by Reviewer at \d{4}-\d{2}-\d{2}T/u
    );
    expect(errors.join("")).toMatch(
      /- agent:assistant: revision 1, changed by Admin at \d{4}-\d{2}-\d{2}T/u
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
    await applyAtCurrentRevisions(fixture.store.configAssets, {
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
    await applyAtCurrentRevisions(fixture.store.configAssets, {
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
    expect(errors.join("")).toContain("skill:both: revision 2, changed by Skill reviewer at");
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
    await applyAtCurrentRevisions(fixture.store.configAssets, {
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
    await applyAtCurrentRevisions(fixture.store.configAssets, {
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
    await applyAtCurrentRevisions(fixture.store.configAssets, {
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
    await applyAtCurrentRevisions(fixture.store.configAssets, {
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
    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      actor: { displayLabel: "Remote editor", roles: ["admin"] },
      mutations: [{ type: "delete", kind: "skill", name: "review" }]
    });
    expect(await runConfigCommand("push", options)).toBe(1);
    expect(errors.join("")).toContain("skill:review: deleted at revision 2 by Remote editor");
    expect(await runConfigCommand("pull", { ...options, only: ["skill:review"] })).toBe(0);
    await expect(
      readFile(resolve(directory, "skills", "review", "SKILL.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    const after = (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local;
    expect(after?.assets?.["skill:review"]).toBeUndefined();
    expect(after?.assets?.["skill:other"]).toEqual(before?.assets?.["skill:other"]);
    // The pull recorded the delete it saw, and a push that creates the asset again names it.
    // Fails without the change: the push named no revision and overwrote the delete unseen.
    expect(after?.deleted).toEqual({ "skill:review": { id: expect.any(String), revision: 2 } });
    await mkdir(resolve(directory, "skills", "review"), { recursive: true });
    await writeFile(
      resolve(directory, "skills", "review", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Created again")),
      "utf8"
    );
    expect(await runConfigCommand("push", options), errors.join("")).toBe(0);
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill",
        name: "review"
      })
    ).toMatchObject({ status: "active", revision: 3 });
    const recreated = (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local;
    expect(recreated?.assets?.["skill:review"]).toMatchObject({ revision: 3 });
    expect(recreated?.deleted).toBeUndefined();
  });

  it("guards prune deletions and creates a pruned asset again against its delete", async () => {
    const fixture = await createFixture();
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await applyAtCurrentRevisions(fixture.store.configAssets, {
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
    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        { type: "upsert", kind: "skill", name: "review", config: skillConfig("review", "Remote") }
      ]
    });
    // The asset changed since the pull: the prune names the pulled revision and is refused.
    expect(await runConfigCommand("push", { ...options, prune: true })).toBe(1);
    expect(
      await fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill",
        name: "review"
      })
    ).toMatchObject({ status: "active", revision: 2 });
    // Pulled, seen and removed again, the prune names the revision that is there.
    expect(await runConfigCommand("pull", { ...options, only: ["skill:review"] })).toBe(0);
    await rm(resolve(directory, "skills", "review"), { recursive: true });
    expect(await runConfigCommand("push", { ...options, prune: true })).toBe(0);
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
    expect(
      (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local?.deleted
    ).toEqual({ "skill:review": { id: expect.any(String), revision: 3 } });
    await mkdir(resolve(directory, "skills", "review"), { recursive: true });
    await writeFile(
      resolve(directory, "skills", "review", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Created again")),
      "utf8"
    );
    expect(await runConfigCommand("push", options)).toBe(0);
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

    // A working copy that pulled the empty instance pushes every asset as a creation.
    await recordEmptyPull(directory);
    expect(await runConfigCommand("push", options), stdout.join("")).toBe(0);
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
    // Skills just under what one item holds, one more of them than one push holds.
    const perItem = ASSET_SYNC_ITEM_MAX_BYTES - 64 * 1024;
    const count = Math.ceil(ASSET_SYNC_BODY_MAX_BYTES / perItem) + 1;
    for (let index = 0; index < count; index += 1) {
      const name = `guide-${index}`;
      await mkdir(resolve(directory, "skills", name), { recursive: true });
      await writeFile(
        resolve(directory, "skills", name, "SKILL.md"),
        serializeSkillMarkdown(skillConfig(name, "x".repeat(perItem))),
        "utf8"
      );
    }
    await recordEmptyPull(directory);
    const errors: string[] = [];
    const options = {
      cwd: directory,
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
    // A part of it fits, and is over the megabyte any other request holds.
    expect(
      await runConfigCommand("push", { ...options, only: ["skill:guide-0", "skill:guide-1"] }),
      errors.join("")
    ).toBe(0);
  });

  it("names the upgrade where the instance has the sync and not its check, and sends nothing", async () => {
    const syncs: unknown[] = [];
    const { fetchImpl, fixture } = await instanceHolding({ agents: [], skills: [] }, syncs);
    // An instance of the release before this one: it lists and syncs, and has no check.
    const earlier: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return new URL(request.url).pathname === testOperations["assets.sync_check"].path
        ? jsonResponse(404, {
            error: {
              code: "NOT_FOUND",
              message: "Not found",
              details: { reason: UNKNOWN_OPERATION_REASON }
            }
          })
        : fetchImpl(request);
    };
    const directory = await createTemporaryDirectory();
    await writeRelease(directory);
    await recordEmptyPull(directory);
    const errors: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_skew" },
      fetchImpl: earlier,
      stdout: () => {},
      stderr: (text: string) => errors.push(text)
    };
    const upgrade =
      "This instance is on an earlier release than this CLI: 'config push' and 'config validate' need the instance on the release of this CLI or later. Upgrade the instance, or use the CLI of its release.\n";

    expect(await runConfigCommand("push", options)).toBe(1);
    expect(errors.join("")).toBe(upgrade);
    errors.length = 0;
    expect(await runConfigCommand("validate", options)).toBe(1);
    expect(errors.join("")).toBe(upgrade);
    expect(syncs).toEqual([]);
    expect(
      await fixture.store.configAssets.getConfigAssetState({
        clientInstanceId: fixture.clientInstanceId
      })
    ).toMatchObject({ version: 0 });
  });

  it("keeps an asset created since the pull out of a prune, and names it", async () => {
    const syncs: unknown[] = [];
    const { fetchImpl, fixture } = await instanceHolding(
      { defaultAgentName: "assistant", agents: [agentConfig("Remote")], skills: [] },
      syncs
    );
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test", "assistant");
    const errors: string[] = [];
    const options = {
      cwd: directory,
      prune: true,
      env: { CATALYST_API_KEY: "cat_prune" },
      fetchImpl,
      stdout: () => {},
      stderr: (text: string) => errors.push(text)
    };
    expect(await runConfigCommand("pull", options)).toBe(0);
    // Someone creates a skill on the instance, and the working copy changes an agent.
    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        { type: "upsert", kind: "skill", name: "fresh", config: skillConfig("fresh", "New.") }
      ]
    });
    await writeFile(
      resolve(directory, "agents", "assistant.agent.yaml"),
      serializeAgentYaml(canonicalizeAgentConfig(agentConfig("Local"))),
      "utf8"
    );

    expect(await runConfigCommand("push", options)).toBe(1);
    expect(errors.join("")).toContain("skill:fresh");
    expect(syncs).toEqual([]);
    const held = (kind: string, name: string) =>
      fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind,
        name
      });
    expect(await held("skill", "fresh")).toMatchObject({ status: "active", revision: 1 });
    expect(await held("agent", "assistant")).toMatchObject({ revision: 1 });
  });

  // Fails without the change: the baseline held revision numbers alone, so against a database
  // that was replaced the push was accepted wherever the numbers happened to agree, and wrote
  // over or pruned what an admin had made there. A pull kept the stale file for the same reason.
  it("refuses a push and a prune against another database at the same revisions, and a pull repairs the working copy", async () => {
    const held = (content: string) => ({
      agents: [],
      skills: [
        skillConfig("review", content),
        skillConfig("keep", content),
        skillConfig("same", content)
      ]
    });
    const syncs: unknown[] = [];
    const { fetchImpl, fixture } = await instanceHolding(held("First database"), syncs);
    const second = { fetchImpl, fixture };
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const errors: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_reset" },
      stdout: () => {},
      stderr: (text: string) => errors.push(text)
    };
    expect(await runConfigCommand("pull", { ...options, fetchImpl })).toBe(0);

    // The database is replaced: the same names, each at revision 1 again, with other content
    // and as other assets.
    const { configAssets } = fixture.store;
    for (const config of held("An admin's text").skills) {
      const address = {
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill" as const,
        name: config.name
      };
      const before = await configAssets.getConfigAsset(address);
      await configAssets.removeConfigAsset({
        ...address,
        assetId: before?.id ?? "",
        expectedRevision: 1
      });
      await applyAtCurrentRevisions(configAssets, {
        clientInstanceId: fixture.clientInstanceId,
        mutations: [
          {
            type: "upsert",
            kind: "skill",
            name: config.name,
            assetId: `cfga_second_skill_${config.name}`,
            config
          }
        ]
      });
    }
    const stored = (name: string) =>
      configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill",
        name
      });
    const reviewPath = resolve(directory, "skills", "review", "SKILL.md");
    await writeFile(reviewPath, serializeSkillMarkdown(skillConfig("review", "Local")), "utf8");

    expect(await runConfigCommand("push", { ...options, fetchImpl: second.fetchImpl })).toBe(1);
    expect(errors.join("")).toContain(
      "- skill:review: the instance holds another asset under this name than the one this working copy pulled. The working copy was pulled from another database, or the asset was replaced there"
    );
    expect(errors.join("")).toContain("catalyst config pull --only skill:review");
    expect(await stored("review")).toMatchObject({
      revision: 1,
      config: { content: "# An admin's text" }
    });

    // A prune of an asset the working copy dropped would delete the admin's asset.
    errors.length = 0;
    await rm(resolve(directory, "skills", "keep"), { recursive: true });
    expect(
      await runConfigCommand("push", { ...options, prune: true, fetchImpl: second.fetchImpl })
    ).toBe(1);
    expect(errors.join("")).toContain("- skill:keep: the instance holds another asset");
    expect(await stored("keep")).toMatchObject({ status: "active", revision: 1 });
    expect(syncs).toEqual([]);

    // The pull reads again what is at the same number under another id: the file of `same`
    // was not touched and its revision matches, and it is still not what this database holds.
    expect(await runConfigCommand("pull", { ...options, fetchImpl: second.fetchImpl })).toBe(0);
    const samePath = resolve(directory, "skills", "same", "SKILL.md");
    expect(await readFile(samePath, "utf8")).toContain("An admin's text");
    expect(
      (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local?.assets?.[
        "skill:same"
      ]
    ).toMatchObject({ id: "cfga_second_skill_same", revision: 1 });

    // From the repaired baseline a push is one against what this database holds.
    await writeFile(reviewPath, serializeSkillMarkdown(skillConfig("review", "Local")), "utf8");
    expect(
      await runConfigCommand("push", { ...options, fetchImpl: second.fetchImpl }),
      errors.join("")
    ).toBe(0);
    expect(await stored("review")).toMatchObject({ revision: 2, config: { content: "# Local" } });
  });

  // Fails without the change: a baseline without the asset's id was pushed against as it was.
  it("refuses to push against a baseline of an earlier CLI that names no asset id", async () => {
    const syncs: unknown[] = [];
    const { fetchImpl } = await instanceHolding(
      { agents: [], skills: [skillConfig("review", "Remote")] },
      syncs
    );
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await mkdir(resolve(directory, "skills", "review"), { recursive: true });
    await writeFile(
      resolve(directory, "skills", "review", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Local")),
      "utf8"
    );
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: {
        local: {
          lastPulledVersion: 1,
          defaultAgentName: null,
          assets: { "skill:review": { revision: 1, hash: "0".repeat(64) } }
        }
      }
    });
    const errors: string[] = [];

    expect(
      await runConfigCommand("push", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_unbound" },
        fetchImpl,
        stdout: () => {},
        stderr: (text: string) => errors.push(text)
      })
    ).toBe(1);
    expect(errors.join("")).toContain(
      "- skill:review: the baseline was written by an earlier CLI and does not say which asset its revision counts"
    );
    expect(errors.join("")).toContain("catalyst config pull --only skill:review");
    expect(syncs).toEqual([]);
  });

  // Fails without the change: a working copy without a pull pushed with --force, over
  // whatever the instance held.
  it("pushes a working copy that never pulled as creations, and overwrites nothing", async () => {
    const syncs: unknown[] = [];
    const { fetchImpl, fixture } = await instanceHolding(
      { agents: [], skills: [skillConfig("review", "Remote")] },
      syncs
    );
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    for (const name of ["review", "extra"]) {
      await mkdir(resolve(directory, "skills", name), { recursive: true });
      await writeFile(
        resolve(directory, "skills", name, "SKILL.md"),
        serializeSkillMarkdown(skillConfig(name, "Local")),
        "utf8"
      );
    }
    const errors: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_never_pulled" },
      fetchImpl,
      stdout: () => {},
      stderr: (text: string) => errors.push(text)
    };
    const held = (name: string) =>
      fixture.store.configAssets.getConfigAsset({
        clientInstanceId: fixture.clientInstanceId,
        kind: "skill",
        name
      });

    // The instance holds one of the two: the whole push is refused, the new skill with it.
    expect(await runConfigCommand("push", options)).toBe(1);
    expect(errors.join("")).toContain("- skill:review: revision 1, changed by");
    expect(syncs).toEqual([]);
    expect(await held("review")).toMatchObject({ revision: 1, config: { content: "# Remote" } });
    expect(await held("extra")).toBeUndefined();

    // Without the asset the instance holds, what is left is created.
    await rm(resolve(directory, "skills", "review"), { recursive: true });
    expect(await runConfigCommand("push", options), errors.join("")).toBe(0);
    expect(syncs).toEqual([
      {
        items: [
          {
            type: "put",
            kind: "skill",
            config: skillConfig("extra", "Local"),
            expectedRevision: null
          }
        ]
      }
    ]);
    expect(await held("extra")).toMatchObject({ status: "active", revision: 1 });
  });

  it("pushes a first release to an empty instance after a pull, without --force", async () => {
    const syncs: unknown[] = [];
    const { fetchImpl, fixture } = await instanceHolding({ agents: [], skills: [] }, syncs);
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const output: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_first" },
      fetchImpl,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text)
    };
    expect(await runConfigCommand("pull", options)).toBe(0);
    await writeRelease(directory);

    expect(await runConfigCommand("push", options), output.join("")).toBe(0);
    expect(output.join("")).toContain("Pushed 3 agents, 2 skills, version 1.");
    expect(syncs).toHaveLength(1);
    // Made against what the pull saw: no asset and no default agent.
    expect(syncs[0]).toMatchObject({
      defaultAgentName: "assistant",
      expectedDefaultAgentName: null
    });
    expect(syncs[0]).toHaveProperty("items.length", 5);
    // Fails without the change: a creation named no revision at all.
    expect(syncs[0]).toHaveProperty(
      "items",
      Array.from({ length: 5 }, () => expect.objectContaining({ expectedRevision: null }))
    );
    expect(
      await fixture.store.configAssets.getConfigAssetState({
        clientInstanceId: fixture.clientInstanceId
      })
    ).toMatchObject({ version: 1, defaultAgentName: "assistant" });
    output.length = 0;
    expect(await runConfigCommand("push", options)).toBe(0);
    expect(output.join("")).toContain("No local changes to push.");
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

describe("config CLI guardrails in the working copy", () => {
  const judge = {
    name: "privacy",
    displayName: "Privacy",
    on: "asset.before_write",
    filter: { kind: "skill" },
    check: {
      kind: "model_judge",
      modelBindingId: "local",
      instruction: "Block a skill that names a person.\n\nNames of companies are fine."
    },
    outcome: "block",
    origin: "asset"
  };
  const pattern = {
    name: "no_iban",
    displayName: "No IBAN in skills",
    on: "asset.before_write",
    filter: { kind: "skill" },
    check: {
      kind: "pattern",
      pattern: "\\bDE\\d{2}(?:\\s?\\d{4}){4}\\s?\\d{2}\\b",
      reason: "Skills hold no bank account."
    },
    outcome: "block",
    origin: "asset"
  };

  async function guardrailWorkingCopy(): Promise<string> {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await writeFile(
      resolve(directory, "catalyst.yaml"),
      `${await readFile(resolve(directory, "catalyst.yaml"), "utf8")}guardrails:\n  - guardrails/*/guardrail.yaml\n`,
      "utf8"
    );
    return directory;
  }

  const commandOptions = (directory: string, fetchImpl: typeof fetch, output: string[]) => ({
    cwd: directory,
    env: { CATALYST_API_KEY: "cat_guardrails" },
    fetchImpl,
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => output.push(text)
  });

  it("pulls a judge into guardrail.yaml and check.md, a pattern into guardrail.yaml alone", async () => {
    const directory = await guardrailWorkingCopy();
    // A check.md of an earlier pull does not survive a check that holds none.
    await mkdir(resolve(directory, "guardrails", "no_iban"), { recursive: true });
    await writeFile(resolve(directory, "guardrails", "no_iban", "check.md"), "Stale.\n", "utf8");
    const { fetchImpl } = await instanceHolding({
      agents: [],
      skills: [],
      guardrails: [judge, pattern]
    });
    const output: string[] = [];
    const options = commandOptions(directory, fetchImpl, output);

    expect(await runConfigCommand("pull", options), output.join("")).toBe(0);
    expect(output.join("")).toContain("Pulled 0 agents, 0 skills, 2 guardrails");
    const privacy = resolve(directory, "guardrails", "privacy");
    expect((await readdir(privacy)).sort()).toEqual(["check.md", "guardrail.yaml"]);
    expect(await readFile(resolve(privacy, "check.md"), "utf8")).toBe(
      `${judge.check.instruction}\n`
    );
    const judgeYaml = await readFile(resolve(privacy, "guardrail.yaml"), "utf8");
    expect(judgeYaml).toContain("kind: model_judge");
    expect(judgeYaml).not.toContain("instruction");
    expect(judgeYaml).not.toContain("origin");
    expect(await readdir(resolve(directory, "guardrails", "no_iban"))).toEqual(["guardrail.yaml"]);

    // What was pulled is what the instance holds: no difference and nothing to push.
    output.length = 0;
    expect(await runConfigCommand("diff", options), output.join("")).toBe(0);
    expect(output.join("")).toContain("No differences.");
    expect(await runConfigCommand("push", options)).toBe(0);
    expect(output.join("")).toContain("No local changes to push.");
  });

  it("puts an edited check.md as the guardrail's next draft after the sync, and --only selects it", async () => {
    const directory = await guardrailWorkingCopy();
    const syncs: unknown[] = [];
    const { fetchImpl: instanceFetch, fixture } = await instanceHolding(
      { agents: [], skills: [], guardrails: [judge, pattern] },
      syncs
    );
    // Every call that writes, in the order the CLI sends them.
    const writes: Array<{ path: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method !== "GET" && path !== testOperations["access_tokens.exchange"].path) {
        writes.push({
          path: `${request.method} ${path}`,
          body: JSON.parse(await request.clone().text())
        });
      }
      return instanceFetch(request);
    };
    const output: string[] = [];
    const options = commandOptions(directory, fetchImpl, output);
    expect(await runConfigCommand("pull", options), output.join("")).toBe(0);

    const checkPath = resolve(directory, "guardrails", "privacy", "check.md");
    const patternYaml = resolve(directory, "guardrails", "no_iban", "guardrail.yaml");
    await writeFile(checkPath, "Edited and dropped.\n", "utf8");
    await writeFile(
      patternYaml,
      (await readFile(patternYaml, "utf8")).replace("outcome: block", "outcome: warn"),
      "utf8"
    );
    // A pull of the judge alone brings back its instruction and leaves the pattern as edited.
    expect(await runConfigCommand("pull", { ...options, only: ["guardrail:privacy"] })).toBe(0);
    expect(await readFile(checkPath, "utf8")).toBe(`${judge.check.instruction}\n`);
    expect(await readFile(patternYaml, "utf8")).toContain("outcome: warn");

    const instruction = "Block a skill that names a person or a phone number.";
    await writeFile(checkPath, `${instruction}\n`, "utf8");
    await mkdir(resolve(directory, "skills", "review"), { recursive: true });
    await writeFile(
      resolve(directory, "skills", "review", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Review")),
      "utf8"
    );
    output.length = 0;
    expect(
      await runConfigCommand("push", {
        ...options,
        only: ["skill:review", "guardrail:privacy"]
      }),
      output.join("")
    ).toBe(0);
    expect(output.join("")).toContain(
      "Guardrails to write one by one, each as its draft:\n- guardrail:privacy"
    );
    expect(output.join("")).toContain("Pushed 0 agents, 1 skill, version");
    expect(output.join("")).toContain("Wrote guardrail:privacy as draft revision 2");
    // The batch holds the skill alone; the guardrail is put after it, against its pulled revision.
    const { origin: _origin, ...definition } = judge;
    expect(writes.map((write) => write.path)).toEqual([
      "POST /api/v1/assets/sync/check",
      "POST /api/v1/assets/sync",
      "PUT /api/v1/assets/guardrail/privacy"
    ]);
    expect(syncs).toEqual([
      {
        items: [
          {
            type: "put",
            kind: "skill",
            config: skillConfig("review", "Review"),
            expectedRevision: null
          }
        ]
      }
    ]);
    expect(writes[2]?.body).toEqual({
      config: { ...definition, check: { ...judge.check, instruction } },
      expectedRevision: 1
    });
    const stored = await fixture.store.configAssets.getConfigAsset({
      clientInstanceId: fixture.clientInstanceId,
      kind: "guardrail",
      name: "privacy"
    });
    expect(stored).toMatchObject({ revision: 2, config: { check: { instruction } } });
    expect(
      (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local?.assets?.[
        "guardrail:privacy"
      ]
    ).toMatchObject({ id: "cfga_held_guardrail_privacy", revision: 2 });

    // Only the pattern is left changed locally.
    output.length = 0;
    expect(await runConfigCommand("diff", options)).toBe(1);
    expect(output.join("")).toContain("guardrail:no_iban: changed locally");
    expect(output.join("")).not.toContain("guardrail:privacy");

    // Changed on the instance since: the put is refused and names the pull that repairs it.
    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "guardrail",
          name: "privacy",
          assetId: "cfga_held_guardrail_privacy",
          config: { ...judge, displayName: "Privacy, edited there" }
        }
      ]
    });
    await writeFile(checkPath, "Edited here as well.\n", "utf8");
    output.length = 0;
    expect(await runConfigCommand("push", { ...options, only: ["guardrail:privacy"] })).toBe(1);
    expect(output.join("")).toContain("Push conflict; nothing was applied.");
    expect(output.join("")).toContain("- guardrail:privacy: revision 3");
    expect(output.join("")).toContain("catalyst config pull --only guardrail:privacy");

    expect(await runConfigCommand("pull", { ...options, only: ["guardrails:privacy"] })).toBe(1);
    expect(output.join("")).toContain("guardrail:<name>");
  });

  it("neither pulls nor prunes guardrails where catalyst.yaml names none", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const { fetchImpl } = await instanceHolding({ agents: [], skills: [], guardrails: [judge] });
    const output: string[] = [];
    expect(await runConfigCommand("pull", commandOptions(directory, fetchImpl, output))).toBe(0);
    expect(output.join("")).toContain("Pulled 0 agents, 0 skills, version 1.");
    expect(await readdir(directory)).not.toContain("guardrails");
  });
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

  it("follows no redirect, so the key reaches neither another host nor another path", async () => {
    const apiKey = "cat_redirect_secret_that_must_stay_home";
    const elsewhere = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const sameHost: string[] = [];
    const instance = await listen((request, response) => {
      sameHost.push(request.url ?? "");
      const target =
        request.headers["x-test-target"] === "same-host" ? "/moved" : `${elsewhere.url}/moved`;
      response.writeHead(307, { location: target }).end();
    });

    const toAnotherHost = await createConfigApi({ baseUrl: instance.url, apiKey }).catch(
      (error: unknown) => error
    );
    const toAnotherPath = await createConfigApi({
      baseUrl: instance.url,
      apiKey,
      fetchImpl: (input, init) =>
        fetch(input, { ...init, headers: { ...headersOf(init), "x-test-target": "same-host" } })
    }).catch((error: unknown) => error);

    for (const failure of [toAnotherHost, toAnotherPath]) {
      expect(failure).toMatchObject({ name: "ApiKeyExchangeError" });
      expect(String(failure)).toContain("answered with a redirect (HTTP 307)");
      expect(String(failure)).not.toContain(apiKey);
    }
    expect(elsewhere.requests).toEqual([]);
    // Each call reached the instance once, with the exchange, and never asked for /moved.
    expect(sameHost.map((path) => path.endsWith("/auth/access-token"))).toEqual([true, true]);
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
    expect(help).toContain("show <agent|skill|guardrail> <name>");
    expect(help).toContain("--prune");
    expect(help).toContain("--only <agent:name|skill:name|guardrail:name>");
    expect(help).not.toContain("local-key");
  });

  it("prints its version with --version, and lists the flag in its help", async () => {
    const out: string[] = [];
    expect(await runCli(["--version"], { stdout: (text) => out.push(text) })).toBe(0);
    expect(out.join("")).toBe(`${RELEASE_VERSION}\n`);
    out.length = 0;
    await runCli(["--help"], { stdout: (text) => out.push(text) });
    expect(out.join("")).toContain("--version");
  });

  it("names where a key comes from, and where the local key command went", async () => {
    const cwd = await createTemporaryDirectory();
    await writeFile(
      join(cwd, "catalyst.yaml"),
      'instances:\n  local:\n    url: "http://127.0.0.1:4210"\ndefaultInstance: local\nagents: []\nskills: []\n'
    );
    const output: string[] = [];
    const stderr = (text: string) => output.push(text);

    expect(await runCli(["config", "pull", "--write-env", ".env"], { cwd, stderr })).toBe(2);
    expect(await runCli(["config", "pull"], { cwd, env: {}, stderr })).toBe(1);
    expect(output.join("")).toContain("Run 'catalyst login --instance http://127.0.0.1:4210'");
    expect(await runCli(["config", "local-key"], { cwd, env: {}, stderr })).toBe(2);
    expect(output.join("")).toContain("catalyst-local-key");
  });
});

/** A working copy of the Namespace `kai-` with one agent of each side of its border. */
async function kaiWorkingCopy(): Promise<string> {
  const directory = await createTemporaryDirectory();
  await writeFile(
    join(directory, "catalyst.yaml"),
    "instances:\n  production:\n    url: https://catalyst.test\n    namespace: kai-\ndefaultInstance: production\nagents:\n  - agents/*.agent.yaml\nskills:\n  - skills/*/SKILL.md\n"
  );
  await mkdir(join(directory, "agents"));
  await writeFile(
    join(directory, "agents", "kai-tax.agent.yaml"),
    serializeAgentYaml(namespaceAgentConfig("kai-tax"))
  );
  return directory;
}

describe("catalyst login", () => {
  it("saves the key of a confirmed code, and the CLI then works inside the person's Namespace only", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const cwd = await kaiWorkingCopy();
    const configHome = await createTemporaryDirectory();
    const env = { CATALYST_CONFIG_HOME: configHome };
    const fetchImpl = createTestFetch(t.instance);
    const output: string[] = [];
    const stdout = (text: string) => output.push(text);
    let confirmed = false;

    // The person confirms in Settings while the CLI waits for it.
    const sleep = async () => {
      if (confirmed) return;
      const code = /code ([A-Z]{4}-[A-Z]{4})/u.exec(output.join(""))?.[1];
      expect(code).toBeDefined();
      await t.expectOk(t.kai.id, "me.connect_codes.confirm", {
        params: { userCode: code ?? "" },
        payload: {
          name: "Mini",
          scopes: ["agent.read:kai-", "agent.write:kai-"],
          expiresAt: inDays(30)
        }
      });
      confirmed = true;
    };
    expect(await runCli(["login"], { cwd, env, fetchImpl, stdout, sleep })).toBe(0);
    const printed = output.join("");
    expect(printed).toContain("https://catalyst.test/settings/you/api-keys?code=");
    expect(printed).toContain("Logged in to https://catalyst.test with the key 'Mini'");
    expect(printed).toContain("See and revoke it at https://catalyst.test/settings/you/api-keys.");

    // The key is in a file only its user reads, and on no line the CLI printed.
    const path = join(configHome, "credentials.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const saved: unknown = JSON.parse(await readFile(path, "utf8"));
    const apiKey = JSON.stringify(saved).match(/cat\.apic_[^"]+/u)?.[0];
    expect(apiKey).toBeDefined();
    expect(printed).not.toContain(apiKey ?? "");

    output.length = 0;
    expect(await runCli(["config", "push"], { cwd, env, fetchImpl, stdout })).toBe(0);
    expect(output.join("")).toContain("Pushed 1 agent");
    output.length = 0;
    expect(await runCli(["config", "list"], { cwd, env, fetchImpl, stdout })).toBe(0);
    expect(output.join("")).toContain("agent\tkai-tax\t-\t-");

    // A pull reads what the key may read and nothing of the whole instance.
    const paths: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      paths.push(new URL(request.url).pathname);
      return fetchImpl(request);
    };
    output.length = 0;
    expect(await runCli(["config", "pull"], { cwd, env, fetchImpl: recording, stdout })).toBe(0);
    expect(output.join("")).toContain("Pulled 1 agent, 0 skills.");
    expect(paths).not.toContain(testOperations["config_assets.get_overview"].path);
    expect(await readFile(join(cwd, "agents", "kai-tax.agent.yaml"), "utf8")).toContain(
      "# Pulled from production.\n"
    );

    // An agent outside the Namespace is refused, with the right that is missing.
    await writeFile(
      join(cwd, "agents", "other.agent.yaml"),
      serializeAgentYaml(namespaceAgentConfig("other"))
    );
    const errors: string[] = [];
    expect(
      await runCli(["config", "push"], {
        cwd,
        env,
        fetchImpl,
        stdout,
        stderr: (text) => errors.push(text)
      })
    ).toBe(1);
    expect(errors.join("")).toMatch(/other/u);

    // Revoked in Settings, the saved key is refused on the next call.
    const keys = await t.expectOk(t.kai.id, "me.api_keys.list");
    const keyId = /"id":"(apic_[^"]+)"/u.exec(keys.body)?.[1] ?? "";
    await t.expectOk(t.kai.id, "me.api_keys.revoke", { params: { keyId } });
    const refused: string[] = [];
    expect(
      await runCli(["config", "list"], {
        cwd,
        env,
        fetchImpl,
        stdout,
        stderr: (text) => refused.push(text)
      })
    ).toBe(1);
    expect(refused.join("")).toContain("revoked");

    expect(await runCli(["logout"], { cwd, env, stdout })).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, instances: {} });
  });

  it("refuses a saved key file that others may read", async () => {
    const cwd = await kaiWorkingCopy();
    const configHome = await createTemporaryDirectory();
    await writeFile(
      join(configHome, "credentials.json"),
      JSON.stringify({ version: 1, instances: {} }),
      { mode: 0o644 }
    );
    const errors: string[] = [];
    expect(
      await runCli(["config", "list"], {
        cwd,
        env: { CATALYST_CONFIG_HOME: configHome },
        stderr: (text) => errors.push(text)
      })
    ).toBe(1);
    expect(errors.join("")).toContain("can be read by other users");
  });
});

/** What `show --json` prints of an asset: the definition under `config`, beside its facts. */
const shownAnswerSchema = z
  .object({ kind: z.string(), revision: z.number(), config: z.record(z.string(), z.unknown()) })
  .loose();

describe("catalyst asset commands against an instance", () => {
  /**
   * The CLI as one user of the instance: the key exchange is answered here, and every other
   * call reaches the instance signed in as that user. Each request is recorded.
   */
  function cliAs(instance: TestInstance, userId: string, cwd: string) {
    const serverFetch = createTestFetch(instance, { "x-test-user": userId });
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === testOperations["access_tokens.exchange"].path) {
        return jsonResponse(200, {
          accessToken: "access-token",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
      }
      return serverFetch(request);
    };
    const run = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli([...args, "--instance", "https://catalyst.test"], {
        cwd,
        env: { CATALYST_API_KEY: "cat_personal" },
        fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      });
      return { code, out: out.join(""), err: err.join("") };
    };
    return { run, requests };
  }

  // Check 57, from the verification of PR 67. Fails without the fix: a guardrail on
  // `operation.before_call`, whose past calls cannot be checked again, reported "would have
  // blocked 0" and was published at once, though it blocked every one of those calls after.
  it("does not publish a first blocking guardrail unconfirmed when its dry run could check nothing", async () => {
    const t = await setupAccessInstance({
      furtherKinds: [createGuardrailAssetKind()],
      server: (stores) => ({
        authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" },
        operations: { events: guardedEvents(stores, {}).events }
      })
    });
    const cwd = await createTemporaryDirectory();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "faq" },
      payload: { config: accessSkill("faq", "Antworten.") }
    });
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "guardrail", name: "no-puts" },
      payload: {
        config: {
          name: "no-puts",
          displayName: "No puts",
          on: "operation.before_call",
          filter: { operation: "assets.put" },
          check: { kind: "pattern", pattern: "." },
          outcome: "block"
        }
      }
    });
    const { run } = cliAs(t.instance, t.admin.id, cwd);
    const unconfirmed = await run("guardrail", "publish", "no-puts", "--revision", "1");
    expect(unconfirmed.err).toContain("would have blocked 0 actions by 0 people");
    expect(unconfirmed.code).toBe(1);
    const unchecked = /and (\d+) actions? it could not check/u.exec(unconfirmed.err)?.[1];
    expect(Number(unchecked)).toBeGreaterThan(0);
    // Nothing was published.
    const stored = await t.stores.configAssets.getConfigAsset({
      clientInstanceId: accessInstanceId,
      kind: "guardrail",
      name: "no-puts"
    });
    expect(stored?.publishedRevision).toBeUndefined();
    const confirmed = await run(
      "guardrail",
      "publish",
      "no-puts",
      "--revision",
      "1",
      "--confirm",
      /--confirm (\d+)/u.exec(unconfirmed.err)?.[1] ?? ""
    );
    expect(confirmed.code, confirmed.err).toBe(0);
    const blocked = await t.call(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "faq" },
      payload: { config: accessSkill("faq", "Wieder neu.") }
    });
    expect(blocked.statusCode).toBe(403);
  });

  // `catalyst guardrail test`, `dry-run`, `publish` and `unpublish` (EW-6a). Fails without the
  // change: the CLI had none of these, and a guardrail could not be published.
  it("tests a guardrail's draft, shows the dry run, publishes only on a confirmed number, and unpublishes", async () => {
    const t = await setupAccessInstance({
      furtherKinds: [createGuardrailAssetKind()],
      server: () => ({ authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" } })
    });
    const cwd = await createTemporaryDirectory();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "faq" },
      payload: { config: accessSkill("faq", `Konto ${GUARDRAIL_IBAN}`) }
    });
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "guardrail", name: "no-iban" },
      payload: {
        config: {
          name: "no-iban",
          displayName: "No IBAN",
          on: "asset.before_write",
          filter: { kind: "skill" },
          check: { kind: "pattern", pattern: ibanPattern, reason: "No bank account." },
          outcome: "block"
        }
      }
    });
    const { run } = cliAs(t.instance, t.admin.id, cwd);

    const sample = await run("guardrail", "test", "no-iban", "--text", `Konto ${GUARDRAIL_IBAN}`);
    expect(sample.code, sample.err).toBe(0);
    expect(sample.out).toContain(
      "Revision 1 of guardrail 'no-iban' on 'asset.before_write': block (No bank account.)."
    );
    const onAsset = await run("guardrail", "test", "no-iban", "--asset", "skill:faq");
    expect(onAsset.out).toContain(": block (No bank account.).");

    const dryRun = await run("guardrail", "dry-run", "no-iban");
    expect(dryRun.code, dryRun.err).toBe(0);
    expect(dryRun.out).toContain("would have blocked 1 action by 1 person");
    expect(dryRun.out).not.toContain(t.admin.id);

    const unconfirmed = await run("guardrail", "publish", "no-iban", "--revision", "1");
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.err).toContain("would have blocked 1 action by 1 person");
    expect(unconfirmed.err).toContain("Publish it with --confirm 1");
    const wrong = await run("guardrail", "publish", "no-iban", "--revision", "1", "--confirm", "2");
    expect(wrong.code).toBe(1);
    const published = () =>
      t.stores.configAssets
        .getConfigAsset({ clientInstanceId: accessInstanceId, kind: "guardrail", name: "no-iban" })
        .then((asset) => asset?.publishedRevision);
    expect(await published()).toBeUndefined();

    const confirmed = await run(
      "guardrail",
      "publish",
      "no-iban",
      "--revision",
      "1",
      "--confirm",
      "1"
    );
    expect(confirmed.code, confirmed.err).toBe(0);
    expect(confirmed.out).toContain("Published revision 1 of guardrail 'no-iban'");
    expect(await published()).toBe(1);

    const unpublished = await run("guardrail", "unpublish", "no-iban");
    expect(unpublished.code, unpublished.err).toBe(0);
    expect(unpublished.out).toContain("Guardrail 'no-iban' no longer enforces");
    expect(await published()).toBeUndefined();

    // The commands are a guardrail's; another kind is told so before anything is sent.
    expect((await run("skill", "test", "faq", "--text", "x")).code).toBe(2);
    expect((await run("guardrail", "test", "no-iban")).code).toBe(2);
  });

  it("builds an agent with its own skill in the holder's Namespace and is refused outside it", async () => {
    const t = await setupNamespaceHolder({
      furtherToolNames: ["read_skill"],
      // The CLI sends its token: the sign-in takes it beside the test header.
      server: () => ({
        authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" }
      })
    });
    const cwd = await createTemporaryDirectory();
    await mkdir(join(cwd, "skills", "kai-guide", "references"), { recursive: true });
    await writeFile(
      join(cwd, "skills", "kai-guide", "SKILL.md"),
      serializeSkillMarkdown({
        name: "kai-guide",
        title: "Tax guide",
        description: "What to ask about taxes",
        content: "Ask for the year first."
      })
    );
    await writeFile(join(cwd, "skills", "kai-guide", "references", "rates.md"), "# Rates\n");
    const tax = { toolNames: ["read_skill"], skillNames: ["kai-guide"] };
    await writeFile(join(cwd, "kai-tax.yaml"), serializeAgentYaml(namespaceAgent("kai-tax", tax)));
    await writeFile(
      join(cwd, "lena-tax.yaml"),
      serializeAgentYaml(namespaceAgent("lena-tax", tax))
    );
    const { run, requests } = cliAs(t.instance, t.kai.id, cwd);

    const context = await run("context");
    expect(context.code, context.err).toBe(0);
    expect(context.out).toMatch(/kai- {2}kai-: .*agent\.write/u);

    const skill = await run(
      "skill",
      "put",
      "kai-guide",
      "--from",
      "skills/kai-guide",
      "--if-revision",
      "new"
    );
    expect(skill, skill.err).toMatchObject({
      code: 0,
      out: "Wrote skill 'kai-guide' at revision 1.\n"
    });
    const created = await run(
      "agents",
      "put",
      "kai-tax",
      "--from",
      "kai-tax.yaml",
      "--if-revision",
      "new"
    );
    expect(created.code, created.err).toBe(0);
    expect((await t.stored("agent", "kai-tax"))?.config).toMatchObject({
      skillNames: ["kai-guide"]
    });
    expect((await t.stored("skill", "kai-guide"))?.config).toMatchObject({
      resources: [{ path: "references/rates.md", content: "# Rates\n" }]
    });

    const listed = await run("agent", "list");
    expect(listed.out).toContain("kai-tax");
    expect(listed.out).not.toContain("assistant");
    expect((await run("agent", "show", "kai-tax")).out).toContain("- kai-guide");
    expect((await run("agent", "history", "kai-tax")).out).toMatch(/^1 +create +Kai/mu);

    // Outside the Namespace the instance refuses, and the CLI prints what it said.
    const outside = await run(
      "agent",
      "put",
      "lena-tax",
      "--from",
      "lena-tax.yaml",
      "--if-revision",
      "new"
    );
    expect(outside.code).toBe(1);
    expect(outside.err).toContain(
      "Refused by the instance (HTTP 403 FORBIDDEN): Missing the right 'agent.write'"
    );
    expect(await t.stored("agent", "lena-tax")).toBeUndefined();

    // A write made against a revision the asset is no longer at changes nothing.
    const stale = await run(
      "agent",
      "put",
      "kai-tax",
      "--from",
      "kai-tax.yaml",
      "--if-revision",
      "new"
    );
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("REVISION_CONFLICT");
    expect(stale.err).toContain("- agent 'kai-tax' is at revision 1");

    // A command line that cannot be sent sends nothing.
    const sent = requests.length;
    const usage = [
      await run("agent", "put", "kai-tax", "--from", "kai-tax.yaml"),
      await run("agent", "put", "kai-tax", "--from", "kai-tax.yaml", "--if-revision", "0"),
      await run("agent", "publish", "kai-tax", "--to", "1"),
      await run("agent", "erase", "kai-tax"),
      await run("agnet")
    ];
    expect(usage.map((result) => result.code)).toEqual([2, 2, 2, 2, 2]);
    expect(requests).toHaveLength(sent);
    await writeFile(join(cwd, "broken.yaml"), "name: [kai-tax\n");
    const broken = await run("agent", "validate", "--from", "broken.yaml");
    expect(broken.code).toBe(1);
    expect(broken.err).toContain(`'${join(cwd, "broken.yaml")}' cannot be read:`);
    const renamed = await run(
      "agent",
      "put",
      "kai-other",
      "--from",
      "kai-tax.yaml",
      "--if-revision",
      "new"
    );
    expect(renamed).toMatchObject({
      code: 2,
      err: "The definition names 'kai-tax', and the command 'kai-other'.\n"
    });

    const deleted = await run("agent", "delete", "kai-tax", "--if-revision", "1");
    expect(deleted, deleted.err).toMatchObject({ code: 0 });
    expect(deleted.out).toContain("its delete is revision 2");
    const reverted = await run("agent", "revert", "kai-tax", "--to", "1", "--if-revision", "2");
    expect(reverted.code, reverted.err).toBe(0);
    expect((await t.stored("agent", "kai-tax"))?.revision).toBe(3);
  });

  it("puts back what show --json printed, and asks for the model right only where the model changes", async () => {
    const t = await setupNamespaceHolder({
      server: () => ({
        authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" }
      })
    });
    // An agent on a model binding, written by the superadmin, who manages models. An admin
    // writes agents and does not hold `agent_models.manage`.
    const created = await t.putAgent(
      t.root.id,
      "bound",
      { modelProviderId: undefined, modelBindingId: "plain" },
      "all"
    );
    expect(created.statusCode, created.body).toBe(200);
    const cwd = await createTemporaryDirectory();
    const { run } = cliAs(t.instance, t.admin.id, cwd);

    const shown = await run("agent", "show", "bound", "--json");
    expect(shown.code, shown.err).toBe(0);
    const answer = shownAnswerSchema.parse(JSON.parse(shown.out));
    const { config } = answer;
    await writeFile(
      join(cwd, "bound.json"),
      JSON.stringify({ ...answer, config: { ...config, displayName: "Renamed" } })
    );
    const renamed = await run(
      "agent",
      "put",
      "bound",
      "--from",
      "bound.json",
      "--if-revision",
      "1"
    );
    expect(renamed.code, renamed.err).toBe(0);
    const stored = (await t.stored("agent", "bound"))?.config;
    expect(stored).toMatchObject({ displayName: "Renamed", modelBindingId: "plain" });
    expect(stored).not.toHaveProperty("revision");

    // Leaving the binding out changes the model the agent runs on: that needs the right.
    const { modelBindingId: _binding, ...unbound } = config;
    await writeFile(join(cwd, "unbound.json"), JSON.stringify(unbound));
    const refused = await run(
      "agent",
      "put",
      "bound",
      "--from",
      "unbound.json",
      "--if-revision",
      "2"
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Missing the right 'agent_models.manage'");
  });

  it("writes an App from its folder as a draft and publishes the revision it names", async () => {
    const t = await setupAppInstance({ explicitCredentials: true });
    try {
      const cwd = await createTemporaryDirectory();
      await mkdir(join(cwd, "offers"), { recursive: true });
      for (const file of appFiles("one")) {
        await writeFile(join(cwd, "offers", file.path), "text" in file ? file.text : "");
      }
      const { run } = cliAs(t.instance, t.admin.id, cwd);
      const workspace = ["--workspace", t.workspaceId];

      const kinds = await run("kinds");
      expect(kinds.out).toMatch(/^app +app +draft, then publish +folder \(app\.yaml\)/mu);
      // validate reads the folder that put takes, and says the instance checks it as it writes.
      const validated = await run("app", "validate", "--from", "offers", ...workspace);
      expect(validated, validated.err).toMatchObject({ code: 0 });
      expect(validated.out).toContain(
        `Read ${appFiles("one").length} files from '${join(cwd, "offers")}', within what one write carries.`
      );
      expect(validated.out).toContain("'catalyst app put <name> --from");
      const written = await run(
        "app",
        "put",
        "offers",
        "--from",
        "offers",
        "--if-revision",
        "new",
        ...workspace
      );
      expect(written, written.err).toMatchObject({
        code: 0,
        out: "Wrote app 'offers' at revision 1. It is a draft until it is published.\n"
      });
      expect(await t.listed("offers")).not.toHaveProperty("publishedRevision");

      const published = await run("app", "publish", "offers", "--revision", "1", ...workspace);
      expect(published, published.err).toMatchObject({
        code: 0,
        out: "Published revision 1 of app 'offers'.\n"
      });
      expect(await t.listed("offers")).toMatchObject({ publishedRevision: 1 });
      const shown = await run("apps", "show", "offers", "--files", ...workspace);
      expect(shown.out).toContain("index.html");
    } finally {
      await t.close();
    }
  });
});

const httpServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise((done) => server.close(() => done(undefined))))
  );
});

/** A real HTTP server on this machine, so that a redirect is one the runtime would follow. */
async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization ?? ""}`);
    handler(request, response);
  });
  httpServers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test server has no port");
  }
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "catalyst-config-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * An instance behind the CLI. `guardrails` are its release config's, run at every call. With
 * `guardrailKind` it also holds guardrails as assets.
 */
async function createFixture(
  guardrails: Record<string, unknown> = {},
  guardrailKind = false,
  /** The module a writer who is no release needs, such as a CLI root bound to a workspace. */
  assetManagement = false
) {
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
    tools: [{ name: "known.tool", enabled: true }],
    guardrails,
    // A push writes guardrails one by one with `assets.put`, which the module switches, and so
    // does every write of a root bound to a workspace.
    ...(guardrailKind || assetManagement ? { modules: { assetManagement: { enabled: true } } } : {})
  });
  if (assetManagement) {
    config.administration.agentConfiguration.allowAgentCreation = true;
    config.administration.agentConfiguration.allowSkillEditing = true;
    config.administration.agentConfiguration.editableAgentFields = [
      "displayName",
      "description",
      "instructions",
      "toolNames",
      "skillNames",
      "initialPrompts"
    ];
  }
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
    permissions: [
      "config_assets.read",
      "config_assets.release",
      ...(guardrailKind ? ["config_assets.write"] : [])
    ]
  });
  const createdCredential = await store.apiAccess.createApiCredential({
    clientInstanceId,
    servicePrincipalId: servicePrincipal.id,
    name: "config CLI test",
    // A guardrail is written with `assets.put`, which a credential reaches with the write scope.
    scopes: [
      "config_assets:read",
      "config_assets:release",
      ...(guardrailKind ? ["config_assets:write"] : [])
    ]
  });
  // No legacy key carries a right on guardrails: the CLI's key is granted them as rows.
  for (const action of guardrailKind ? ["guardrail.read", "guardrail.write"] : []) {
    await store.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: servicePrincipal.id,
      action,
      effect: "allow",
      scopeKind: "instance",
      grantedBy: asUserId("usr_config_cli_test")
    });
  }
  const auditRecorder = new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit });
  const usageGovernance = new ModelUsageGovernance({
    store: store.usage,
    budget: config.usage.budget,
    safeguards: config.usage.safeguards,
    costs: config.usage.costs
  });
  const guardrailRunner = new GuardrailRunner({
    clientInstanceId,
    config,
    hits: store.guardrails,
    modelGateway: createScriptedInstanceModelGateway({
      config,
      modelProvider: createUnusedModelProvider(),
      usageGovernance
    })
  });
  const server = await createTestInstance({
    server: {
      config,
      clientInstanceId,
      operations: { events: createAuditingEventEmitter(auditRecorder, guardrailRunner) },
      authAdapter: new IdentityResolvingAuthAdapter(
        new CompositeAuthAdapter([
          new HmacServiceAccessTokenAuthAdapter(serviceAccessOptions),
          new HmacSessionTokenAuthAdapter(authOptions)
        ]),
        store.users
      ),
      stores: store,
      usageGovernance,
      auditRecorder,
      configAssets: {
        store: store.configAssets,
        validationRefs: fixtureValidationRefs,
        ...(guardrailKind
          ? {
              kinds: createAssetKindRegistry([
                ...createTestAssetKinds({ config, validationRefs: fixtureValidationRefs }).kinds,
                createGuardrailAssetKind()
              ])
            }
          : {})
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

/** The validation refs of the fixture's instance, also for a registry made beside it. */
const fixtureValidationRefs = {
  modelProviderIds: ["local"],
  modelBindingIds: [],
  modelBindings: [],
  fastModeModelBindingIds: [],
  reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
  enabledToolNames: ["known.tool", "read_skill"]
};

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

/** A credentials file as `catalyst login` writes it, with one key for each origin. */
async function saveCredentialsFor(configHome: string, origins: string[]): Promise<void> {
  const key = (origin: string) => ({
    apiKey: `cat.apic_test_${new URL(origin).hostname}`,
    keyId: `key_${new URL(origin).hostname}`,
    name: "Test key",
    expiresAt: inDays(30),
    savedAt: new Date().toISOString()
  });
  const file = { version: 1, instances: Object.fromEntries(origins.map((o) => [o, key(o)])) };
  await writeFile(join(configHome, "credentials.json"), JSON.stringify(file), { mode: 0o600 });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** The state a pull of an instance without assets leaves in the working copy. */
async function recordEmptyPull(directory: string): Promise<void> {
  await writeStateFile(resolve(directory, STATE_FILENAME), {
    instances: { local: { lastPulledVersion: 0, assets: {}, defaultAgentName: null } }
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
        {
          id: heldAssetId(asset.key),
          revision: 1,
          hash: createHash("sha256").update(asset.contents).digest("hex")
        }
      ])
    )
  };
}

/** The id `instanceHolding` gives an asset, so a baseline written by hand names the same one. */
function heldAssetId(key: string): string {
  return `cfga_held_${key.replace(":", "_")}`;
}

interface HeldAssets {
  defaultAgentName?: string;
  agents: ReadonlyArray<JsonObject & { name: string }>;
  skills: ReadonlyArray<JsonObject & { name: string }>;
  /** Given, the instance holds guardrails as assets, these among them. */
  guardrails?: ReadonlyArray<JsonObject & { name: string }>;
}

/**
 * A real instance that holds these assets, each at revision 1, behind a fetch for the CLI.
 * The fetch signs in with the instance's key whatever key the command names, and records
 * the body of every `assets.sync` the CLI sends.
 */
async function instanceHolding(
  remote: HeldAssets,
  syncs: unknown[] = [],
  /** The id each asset gets. Another one makes the instance another database's. */
  idOf: (key: string) => string = heldAssetId,
  guardrails: Record<string, unknown> = {},
  assetManagement = false
) {
  const fixture = await createFixture(guardrails, remote.guardrails !== undefined, assetManagement);
  const mutations = [
    ...remote.agents.map((config) => ({
      type: "upsert" as const,
      kind: "agent",
      name: config.name,
      assetId: idOf(`agent:${config.name}`),
      config
    })),
    ...remote.skills.map((config) => ({
      type: "upsert" as const,
      kind: "skill",
      name: config.name,
      assetId: idOf(`skill:${config.name}`),
      config
    })),
    ...(remote.guardrails ?? []).map((config) => ({
      type: "upsert" as const,
      kind: "guardrail",
      name: config.name,
      assetId: idOf(`guardrail:${config.name}`),
      config
    })),
    ...(remote.defaultAgentName === undefined
      ? []
      : [{ type: "setDefaultAgent" as const, agentName: remote.defaultAgentName }])
  ];
  if (mutations.length > 0) {
    await applyAtCurrentRevisions(fixture.store.configAssets, {
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

// `catalyst setup <tool> --instance <url>` connects a local agent in one step: a connect code
// the person confirms in Settings where no working key is saved, then the Catalyst skill where
// the tool reads skills. Platform Access acceptance check 53 (CONNECT-1a).

const SETUP_INSTANCE = "https://catalyst.test";
const keysSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() }).loose())
});

/** One person's computer: a home folder, a CLI config folder, and the CLI as it runs there. */
async function computerOf(t: PersonalKeyInstance) {
  const home = await createTemporaryDirectory();
  const env = { HOME: home, CATALYST_CONFIG_HOME: join(home, ".config", "catalyst") };
  const paths: string[] = [];
  const instanceFetch = createTestFetch(t.instance);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    paths.push(new URL(request.url).pathname);
    return instanceFetch(request);
  };
  const opened: string[] = [];

  /** Runs setup; the person confirms the code it shows as Settings would, with its label as the name. */
  async function setup(args: string[], moreEnv: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    let confirmed = false;
    const sleep = async () => {
      if (confirmed) return;
      const userCode = /code ([A-Z]{4}-[A-Z]{4})/u.exec(out.join(""))?.[1] ?? "";
      const asking = await t.expectOk(t.kai.id, "me.connect_codes.get", {
        params: { userCode }
      });
      const clientLabel = z.object({ clientLabel: z.string() }).parse(asking.json()).clientLabel;
      await t.expectOk(t.kai.id, "me.connect_codes.confirm", {
        params: { userCode },
        payload: { name: clientLabel, scopes: ["agent.read:kai-"], expiresAt: inDays(30) }
      });
      confirmed = true;
    };
    const code = await runCli(["setup", ...args], {
      env: { ...env, ...moreEnv },
      fetchImpl,
      sleep,
      openUrl: (address) => opened.push(address),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text)
    });
    return { code, out: out.join(""), err: err.join("") };
  }

  return { home, env, paths, opened, setup };
}

async function savedKey(configHome: string): Promise<string> {
  const saved = await readFile(join(configHome, "credentials.json"), "utf8");
  const key = /cat\.apic_[^"]+/u.exec(saved)?.[0];
  if (!key) throw new Error("No key was saved");
  return key;
}

describe("catalyst setup", () => {
  it("logs Claude Code in by a confirmed code, writes its skill, prints no key, and keeps the key on a second run", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".claude", "skills", "catalyst", "SKILL.md");

    const first = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE]);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(computer.opened).toEqual([
      expect.stringMatching(/^https:\/\/catalyst\.test\/settings\/you\/api-keys\?code=/u)
    ]);
    expect(first.out).toContain(`Instance: ${SETUP_INSTANCE}`);
    expect(first.out).toContain(`Logged in with the key 'Claude Code on ${hostname()}'`);
    expect(first.out).toContain("agent.read:kai-");
    expect(first.out).toContain(`Wrote the Catalyst skill to ${skillPath}.`);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
    const key = await savedKey(computer.env.CATALYST_CONFIG_HOME);
    expect(first.out).not.toContain(key);

    // API keys lists the key by the tool and the computer.
    const keys = keysSchema.parse((await t.expectOk(t.kai.id, "me.api_keys.list")).json());
    expect(keys.items.map((item) => item.name)).toEqual([`Claude Code on ${hostname()}`]);

    // A second run keeps the key, starts no code, and rewrites a skill an older CLI wrote.
    const older = (await renderCatalystSkill()).replace("# Catalyst", "# Catalyst, older");
    await writeFile(skillPath, older.replace(/sha256 [0-9a-f]{64}/u, sha256Mark(older)));
    computer.paths.length = 0;
    const second = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE]);
    expect(second.code).toBe(0);
    expect(second.out).toContain(`Kept the saved key 'Claude Code on ${hostname()}'`);
    expect(second.out).toContain(`Wrote the Catalyst skill to ${skillPath}.`);
    expect(computer.paths).not.toContain(testOperations["connect_codes.start"].path);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
    expect(await savedKey(computer.env.CATALYST_CONFIG_HOME)).toBe(key);
    expect(second.out + second.err).not.toContain(key);

    // A third run finds the skill current.
    expect((await computer.setup(["claude-code", "--instance", SETUP_INSTANCE])).out).toContain(
      "is current"
    );
  });

  it("keeps a different skill file and says so, and with --force keeps it as SKILL.md.bak", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".claude", "skills", "catalyst", "SKILL.md");
    await mkdir(join(skillPath, ".."), { recursive: true });
    await writeFile(skillPath, "---\nname: catalyst\n---\nMy own notes.\n");

    const kept = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE]);
    expect(kept.code).toBe(1);
    expect(kept.err).toContain(`Kept ${skillPath}: it is not the skill this CLI writes.`);
    expect(kept.err).toContain("--force");
    expect(await readFile(skillPath, "utf8")).toBe("---\nname: catalyst\n---\nMy own notes.\n");

    // The person edited a skill setup wrote: that is a different file too.
    const edited = `${await renderCatalystSkill()}My addition.\n`;
    await writeFile(skillPath, edited);
    expect((await computer.setup(["claude-code", "--instance", SETUP_INSTANCE])).code).toBe(1);

    const forced = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE, "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain(`${skillPath}.bak`);
    expect(await readFile(`${skillPath}.bak`, "utf8")).toBe(edited);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
  });

  it("writes the skill of Codex and of another tool to ~/.agents/skills, and tells Other where it is", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".agents", "skills", "catalyst", "SKILL.md");

    const codex = await computer.setup(["codex", "--instance", SETUP_INSTANCE]);
    expect(codex.code).toBe(0);
    expect(codex.out).toContain(`Logged in with the key 'Codex on ${hostname()}'`);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());

    await rm(skillPath);
    const other = await computer.setup(["other", "--instance", SETUP_INSTANCE]);
    expect(other.code).toBe(0);
    expect(other.out).toContain(`Wrote the Catalyst skill to ${skillPath}.`);
    expect(other.out).toContain("Point your tool at that file");
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
  });

  it("logs in again where the saved key was revoked", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const computer = await computerOf(t);
    expect((await computer.setup(["codex", "--instance", SETUP_INSTANCE])).code).toBe(0);
    const keys = keysSchema.parse((await t.expectOk(t.kai.id, "me.api_keys.list")).json());
    await t.expectOk(t.kai.id, "me.api_keys.revoke", {
      params: { keyId: keys.items[0]?.id ?? "" }
    });

    const again = await computer.setup(["codex", "--instance", SETUP_INSTANCE]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Logged in with the key");
    expect(computer.opened).toHaveLength(2);
  });

  it("writes Claude Code's skill below CLAUDE_CONFIG_DIR where that is set", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const computer = await computerOf(t);
    const claudeHome = join(computer.home, "claude-elsewhere");
    const skillPath = join(claudeHome, "skills", "catalyst", "SKILL.md");

    const run = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE], {
      CLAUDE_CONFIG_DIR: claudeHome
    });
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Wrote the Catalyst skill to ${skillPath}.`);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
    await expect(stat(join(computer.home, ".claude"))).rejects.toThrow(/ENOENT/u);
  });

  it("logs in again only where the instance refuses the saved key, not on any other answer", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const computer = await computerOf(t);
    expect((await computer.setup(["codex", "--instance", SETUP_INSTANCE])).code).toBe(0);
    const key = await savedKey(computer.env.CATALYST_CONFIG_HOME);

    // The instance limits the exchange of keys for a moment: the key is not the problem.
    const paths: string[] = [];
    const err: string[] = [];
    const code = await runCli(["setup", "codex", "--instance", SETUP_INSTANCE], {
      env: computer.env,
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        paths.push(new URL(request.url).pathname);
        return jsonResponse(429, { error: { code: "RATE_LIMITED", message: "Slow down." } });
      },
      openUrl: () => undefined,
      stdout: () => undefined,
      stderr: (text) => err.push(text)
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("HTTP 429");
    expect(paths).toEqual([testOperations["access_tokens.exchange"].path]);
    expect(await savedKey(computer.env.CATALYST_CONFIG_HOME)).toBe(key);
  });

  it("names the saved instances when a command names none and none or several are saved", async () => {
    const cwd = await createTemporaryDirectory();
    const configHome = await createTemporaryDirectory();
    const paths: string[] = [];
    const context = async () => {
      const err: string[] = [];
      const code = await runCli(["context", "--json"], {
        cwd,
        env: { CATALYST_CONFIG_HOME: configHome },
        fetchImpl: async (input) => {
          paths.push(String(input));
          return jsonResponse(500, {});
        },
        stdout: () => undefined,
        stderr: (text) => err.push(text)
      });
      return { code, err: err.join("") };
    };
    expect(await context()).toEqual({
      code: 1,
      err: "No instance selected; pass --instance or set defaultInstance in catalyst.yaml. No key is saved; 'catalyst login --instance <https-url>' saves one.\n"
    });
    await saveCredentialsFor(configHome, ["https://catalyst.test", "https://other.test"]);
    expect((await context()).err).toContain(
      "Keys are saved for https://catalyst.test, https://other.test."
    );
    expect(paths).toEqual([]);
  });

  it("refuses a tool it does not know and a run without the instance, before any call", async () => {
    const errors: string[] = [];
    const stderr = (text: string) => errors.push(text);
    expect(await runCli(["setup", "cursor", "--instance", SETUP_INSTANCE], { stderr })).toBe(2);
    expect(await runCli(["setup", "codex"], { stderr })).toBe(2);
    expect(await runCli(["login", "--force", "--instance", SETUP_INSTANCE], { stderr })).toBe(2);
    expect(errors.join("")).toContain(
      "Usage: catalyst setup <claude-code|codex|other> --instance <url> [--force]"
    );
  });
});

// Verifier repros for CONNECT-1a (verify/connect-1a). Each fails on the PR head 2345650a.
describe("catalyst setup, verifier repros", () => {
  it("never deletes a person's own file: a second --force keeps the first .bak", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".claude", "skills", "catalyst", "SKILL.md");
    await mkdir(join(skillPath, ".."), { recursive: true });
    const first = "---\nname: catalyst\n---\nMy first notes.\n";
    await writeFile(skillPath, first);
    expect(
      (await computer.setup(["claude-code", "--instance", SETUP_INSTANCE, "--force"])).code
    ).toBe(0);
    expect(await readFile(`${skillPath}.bak`, "utf8")).toBe(first);

    // The person writes their own file there again and runs the command with --force again.
    await writeFile(skillPath, "---\nname: catalyst\n---\nMy second notes.\n");
    expect(
      (await computer.setup(["claude-code", "--instance", SETUP_INSTANCE, "--force"])).code
    ).toBe(0);
    const folder = join(skillPath, "..");
    const kept = await Promise.all(
      (await readdir(folder)).map((name) => readFile(join(folder, name), "utf8"))
    );
    expect(kept).toContain(first);
  });

  it("the skill's first command works after setup outside a working copy with one saved instance", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const computer = await computerOf(t);
    expect((await computer.setup(["claude-code", "--instance", SETUP_INSTANCE])).code).toBe(0);

    // The skill: "When more than one instance is saved, pass --instance". One is saved here.
    const cwd = await createTemporaryDirectory();
    const err: string[] = [];
    const code = await runCli(["context", "--json"], {
      cwd,
      env: computer.env,
      fetchImpl: createTestFetch(t.instance),
      stdout: () => undefined,
      stderr: (text) => err.push(text)
    });
    expect(err.join("")).toBe("");
    expect(code).toBe(0);
  });

  it("writes nothing outside the skill folder through a link at SKILL.md", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".claude", "skills", "catalyst", "SKILL.md");
    await mkdir(join(skillPath, ".."), { recursive: true });
    const outside = join(computer.home, "outside.txt");
    await symlink(outside, skillPath);
    await computer.setup(["claude-code", "--instance", SETUP_INSTANCE]);
    await expect(stat(outside)).rejects.toThrow(/ENOENT/u);
  });

  it("writes nothing through a link at SKILL.md to an existing file that holds a skill setup wrote", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiNamespace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".claude", "skills", "catalyst", "SKILL.md");
    await mkdir(join(skillPath, ".."), { recursive: true });
    // Followed, the link would read as an older skill of this CLI, which setup replaces.
    const older = (await renderCatalystSkill()).replace("# Catalyst", "# Catalyst, older");
    const outsideText = older.replace(/sha256 [0-9a-f]{64}/u, sha256Mark(older));
    const outside = join(computer.home, "shared-skill.md");
    await writeFile(outside, outsideText);
    await symlink(outside, skillPath);

    const kept = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE]);
    expect(kept.code).toBe(1);
    expect(kept.err).toContain(`Kept ${skillPath}`);
    expect(await readFile(outside, "utf8")).toBe(outsideText);

    const forced = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE, "--force"]);
    expect(forced.code, forced.err).toBe(0);
    expect(await readFile(outside, "utf8")).toBe(outsideText);
    expect((await lstat(`${skillPath}.bak`)).isSymbolicLink()).toBe(true);
    expect((await lstat(skillPath)).isFile()).toBe(true);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
  });
});

/** The mark of a skill `catalyst setup` wrote, for this text before the mark. */
function sha256Mark(rendered: string): string {
  const body = rendered.slice(0, rendered.lastIndexOf("\n<!-- Written by catalyst setup"));
  return `sha256 ${createHash("sha256").update(body).digest("hex")}`;
}

/**
 * The commands and options a skill names that `catalyst --help` does not list. A command is a
 * line of a code block or a code span that starts with `catalyst`; an option is any `--word`
 * of the skill.
 */
function unlistedInHelp(skill: string, help: string): string[] {
  const listed = (word: string) =>
    new RegExp(`(?:^|\\n)\\s+${word}\\s|catalyst ${word}\\b|<kind> ${word}\\b`, "u").test(help);
  const commands = [
    ...[...skill.matchAll(/```sh\n([\s\S]*?)```/gu)].flatMap((block) =>
      (block[1] ?? "").split("\n")
    ),
    ...[...skill.matchAll(/`([^`\n]+)`/gu)].map((span) => span[1] ?? "")
  ].filter((line) => line.startsWith("catalyst "));
  const problems: string[] = [];
  for (const command of commands) {
    const [, first = "", second = ""] = command.split(/\s+/u);
    if (first.startsWith("-")) continue;
    if (["config", "context", "kinds", "references", "login", "logout", "setup"].includes(first)) {
      if (!listed(first)) problems.push(`command '${first}' in: ${command}`);
      if (first === "config" && !listed(second)) {
        problems.push(`command 'config ${second}' in: ${command}`);
      }
    } else if (second === "" || second.startsWith("-")) {
      problems.push(`command '${first}' in: ${command}`);
    } else if (!listed(second) && !listed(`${first} ${second}`)) {
      // A shared kind verb or a named operation such as `workflow runs`.
      problems.push(`'${first} ${second}' in: ${command}`);
    }
  }
  for (const [option] of skill.matchAll(/--[a-z][a-z-]*/gu)) {
    if (!help.includes(option)) problems.push(`option '${option}'`);
  }
  return [...new Set(problems)];
}

describe("the Catalyst skill the CLI ships", () => {
  it("names only commands and options that `catalyst --help` lists", async () => {
    const out: string[] = [];
    expect(await runCli(["--help"], { stdout: (text) => out.push(text) })).toBe(0);
    const help = out.join("");
    const skill = await renderCatalystSkill();
    expect(skill).toContain("catalyst config pull");
    expect(unlistedInHelp(skill, help)).toEqual([]);

    // The check sees a command, a verb and an option the CLI does not have.
    expect(
      unlistedInHelp(
        "Run `catalyst init` and `catalyst agent rename x`, then `catalyst config sync --all` and `catalyst agent hits x`.",
        help
      )
    ).toEqual([
      "command 'init' in: catalyst init",
      "'agent rename' in: catalyst agent rename x",
      "command 'config sync' in: catalyst config sync --all",
      "'agent hits' in: catalyst agent hits x",
      "option '--all'"
    ]);
  });

  it("is generic: no instance address, no key and no customer wording", async () => {
    const skill = await renderCatalystSkill();
    expect(skill).toMatch(/^---\nname: catalyst\ndescription: /u);
    expect(skill).not.toMatch(/https?:\/\//u);
    expect(skill).not.toMatch(/cat\.apic_|immobilien|finanzierung|vivd|\bkai-/iu);
  });
});

describe("a working copy bound to a workspace", () => {
  /**
   * An instance with a workspace Team that owns the skill `team-notes`, a key that writes the
   * instance's assets, and an empty working copy. `guardrails` lists guardrails in it.
   */
  async function boundFixture(guardrails = false) {
    const syncs: unknown[] = [];
    /** Every call that writes, in the order the CLI sends them. */
    const writes: Array<{ path: string; body: unknown }> = [];
    const { fixture } = await instanceHolding(
      {
        defaultAgentName: "assistant",
        agents: [agentConfig("The instance's own.")],
        skills: [],
        ...(guardrails ? { guardrails: [] } : {})
      },
      syncs,
      heldAssetId,
      {},
      true
    );
    const { clientInstanceId, store } = fixture;
    const owner = await store.users.createUser({
      clientInstanceId,
      displayLabel: "Owner",
      roles: ["user"],
      permissions: []
    });
    const team = await store.workspaces.createWorkspace({
      clientInstanceId,
      kind: "shared",
      name: "Team",
      creatorUserId: owner.id
    });
    const scope = { kind: "workspace" as const, workspaceId: team.id };
    await applyAtCurrentRevisions(store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: "team-notes",
          config: skillConfig("team-notes", "Notes."),
          scope
        }
      ]
    });
    // A key that writes the instance's assets: the root it is used in names the owner.
    const principal = await store.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Team CLI",
      permissions: ["config_assets.read", "config_assets.write"]
    });
    const credential = await store.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: principal.id,
      name: "team CLI",
      scopes: ["config_assets:read", "config_assets:write"]
    });
    // No legacy key carries a right on guardrails: the key is granted them as rows.
    for (const action of guardrails
      ? ["guardrail.read", "guardrail.write", "guardrail.delete"]
      : []) {
      await store.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: principal.id,
        action,
        effect: "allow",
        scopeKind: "instance",
        grantedBy: asUserId("usr_config_cli_test")
      });
    }
    const serverFetch = createTestFetch(fixture.server);
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === testOperations["access_tokens.exchange"].path) {
        return serverFetch(request.url, {
          method: request.method,
          headers: { authorization: `Bearer ${credential.secret}` }
        });
      }
      if (path === testOperations["assets.sync"].path) {
        syncs.push(JSON.parse(await request.clone().text()));
      }
      if (request.method !== "GET") {
        writes.push({
          path: `${request.method} ${path}`,
          body: JSON.parse(await request.clone().text())
        });
      }
      return serverFetch(request);
    };
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    if (guardrails) {
      await writeFile(
        resolve(directory, "catalyst.yaml"),
        `${await readFile(resolve(directory, "catalyst.yaml"), "utf8")}guardrails:\n  - guardrails/*/guardrail.yaml\n`,
        "utf8"
      );
    }
    const output: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_team" },
      fetchImpl,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text)
    };
    return { fixture, team, scope, syncs, writes, directory, output, options };
  }

  it("binds with pull --workspace, pulls and pushes what the workspace owns, and is bound once", async () => {
    const { fixture, team, scope, syncs, directory, output, options } = await boundFixture();
    const { clientInstanceId, store } = fixture;

    expect(
      await runConfigCommand("pull", { ...options, workspace: team.id }),
      output.join("")
    ).toBe(0);
    expect(output.join("")).toContain(`Bound this working copy to workspace '${team.id}'.`);
    expect(await readFile(join(directory, "catalyst.yaml"), "utf8")).toContain(
      `    workspace: ${team.id}\n`
    );
    // The workspace's skill, and nothing of the instance's own.
    const pulled = await readWorkingCopy(directory, await readManifest(directory));
    expect(pulled.skills.map((skill) => skill.name)).toEqual(["team-notes"]);
    expect(pulled.agents).toEqual([]);

    // A push of the bound root writes into the workspace.
    await mkdir(join(directory, "agents"), { recursive: true });
    await writeFile(
      join(directory, "agents", "team-helper.agent.yaml"),
      serializeAgentYaml(
        canonicalizeAgentConfig({
          ...agentConfig("Read the notes.", { name: "team-helper" }),
          toolNames: ["read_skill"],
          skillNames: ["team-notes"]
        })
      )
    );
    expect(await runConfigCommand("push", options), output.join("")).toBe(0);
    expect(syncs.at(-1)).toMatchObject({ workspaceId: team.id });
    expect(syncs.at(-1)).not.toHaveProperty("defaultAgentName");
    expect(
      (
        await store.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "agent",
          name: "team-helper"
        })
      )?.scope
    ).toEqual(scope);

    // Bound once: another workspace is pulled into a directory of its own.
    output.length = 0;
    expect(await runConfigCommand("pull", { ...options, workspace: "cws_other" })).not.toBe(0);
    expect(output.join("")).toContain(`This working copy is bound to workspace '${team.id}'.`);
    // A root that pulled the instance's own assets is not bound afterwards.
    const instanceRoot = await createTemporaryDirectory();
    await writeMinimalManifest(instanceRoot, "https://catalyst.test");
    await recordEmptyPull(instanceRoot);
    output.length = 0;
    expect(
      await runConfigCommand("pull", { ...options, cwd: instanceRoot, workspace: team.id })
    ).not.toBe(0);
    expect(output.join("")).toContain("This working copy holds the instance's own assets");
  });

  // From the review of WS-OWN-1a: the commands of one asset ignored the binding and addressed
  // the instance's own assets.
  it("addresses the bound workspace with the commands of one asset, as its config commands do", async () => {
    const { team, writes, directory, output, options } = await boundFixture();
    expect(
      await runConfigCommand("pull", { ...options, workspace: team.id }),
      output.join("")
    ).toBe(0);
    const cli = async (...args: string[]) => {
      const out: string[] = [];
      const code = await runCli(args, {
        cwd: directory,
        env: options.env,
        fetchImpl: options.fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => out.push(text)
      });
      return { code, out: out.join("") };
    };

    const listed = await cli("skill", "list", "--json");
    expect(listed.code, listed.out).toBe(0);
    expect(listed.out).toContain('"team-notes"');

    await mkdir(join(directory, "skills", "team-guide"), { recursive: true });
    await writeFile(
      join(directory, "skills", "team-guide", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("team-guide", "A guide."))
    );
    writes.length = 0;
    const written = await cli(
      "skill",
      "put",
      "team-guide",
      "--from",
      "skills/team-guide",
      "--if-revision",
      "new"
    );
    expect(written.code, written.out).toBe(0);
    expect(writes).toEqual([
      {
        path: "PUT /api/v1/assets/skill/team-guide",
        body: expect.objectContaining({ workspaceId: team.id })
      }
    ]);
  });

  it("pushes a guardrail of the bound root as the workspace's, and prunes it there", async () => {
    const { fixture, team, scope, writes, directory, output, options } = await boundFixture(true);
    const { clientInstanceId, store } = fixture;
    expect(
      await runConfigCommand("pull", { ...options, workspace: team.id }),
      output.join("")
    ).toBe(0);

    const guardrail = {
      name: "team_no_codes",
      displayName: "No codes in Team's skills",
      on: "asset.before_write",
      filter: { kind: "skill" },
      check: { kind: "pattern", pattern: "CODE-[0-9]+", reason: "Skills hold no codes." },
      outcome: "block"
    };
    await mkdir(resolve(directory, "guardrails", guardrail.name), { recursive: true });
    await writeFile(
      resolve(directory, "guardrails", guardrail.name, "guardrail.yaml"),
      [
        `name: ${guardrail.name}`,
        `displayName: ${guardrail.displayName}`,
        `on: ${guardrail.on}`,
        "filter:",
        "  kind: skill",
        "check:",
        "  kind: pattern",
        `  pattern: ${guardrail.check.pattern}`,
        `  reason: ${guardrail.check.reason}`,
        `outcome: ${guardrail.outcome}`,
        ""
      ].join("\n"),
      "utf8"
    );
    output.length = 0;
    writes.length = 0;
    expect(await runConfigCommand("push", options), output.join("")).toBe(0);
    expect(output.join("")).toContain(`Wrote guardrail:${guardrail.name} as draft revision 1`);
    expect(writes).toEqual([
      {
        path: `PUT /api/v1/assets/guardrail/${guardrail.name}`,
        body: { config: guardrail, expectedRevision: null, workspaceId: team.id }
      }
    ]);
    const stored = await store.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "guardrail",
      name: guardrail.name
    });
    expect(stored?.scope).toEqual(scope);

    // What the push wrote is what the bound root holds: nothing to push, no difference.
    output.length = 0;
    expect(await runConfigCommand("diff", options), output.join("")).toBe(0);

    // A prune deletes it in the workspace that owns it.
    await rm(resolve(directory, "guardrails", guardrail.name), { recursive: true });
    writes.length = 0;
    output.length = 0;
    expect(await runConfigCommand("push", { ...options, prune: true }), output.join("")).toBe(0);
    expect(writes).toEqual([
      {
        path: `POST /api/v1/assets/guardrail/${guardrail.name}/delete`,
        body: { expectedRevision: 1, workspaceId: team.id }
      }
    ]);
    expect(
      (
        await store.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "guardrail",
          name: guardrail.name
        })
      )?.status
    ).toBe("deleted");
  });
});
