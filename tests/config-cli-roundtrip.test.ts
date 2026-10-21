import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiOperations, type Asset, type AssetSummary } from "@work-shape/catalyst-api-contract";
import {
  agentConfigSchema,
  skillConfigSchema,
  type AgentConfig,
  type SkillConfig
} from "@work-shape/catalyst-asset-schemas";
import {
  CANONICAL_FORM_VERSION,
  canonicalizeAgentConfig,
  canonicalizeSkillConfig,
  parseSkillFile,
  readManifest,
  readStateFile,
  writeStateFile,
  serializeAgentYaml,
  readWorkingCopy,
  runCli,
  serializeSkillMarkdown
} from "@work-shape/catalyst-cli";
import platformContext from "./fixtures/cli-platform-context.json";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
const agent = {
  name: "helper",
  displayName: { en: "Helper", de: "Helfer" },
  description: "Description",
  welcomeMessage: "Welcome",
  welcomeSubtitle: { en: "Start here" },
  instructions: "Help.",
  modelProviderId: "provider",
  modelBindingId: "primary",
  reasoningEffort: "high",
  fastMode: false,
  userSelectableModelBindingIds: [],
  modelReasoningEfforts: { z: "high", a: "low" },
  maxSteps: 8,
  toolNames: ["run_agent"],
  subagentNames: ["researcher"],
  skillNames: ["guide"],
  knowledgeBases: ["documents"],
  initialPrompts: [{ title: "Start", prompt: "Help me" }]
} satisfies AgentConfig;
const agentEdits = {
  name: "other",
  displayName: "Other",
  description: "Other",
  welcomeMessage: "Other",
  welcomeSubtitle: "Other",
  instructions: "Other",
  modelProviderId: "other",
  modelBindingId: "other",
  reasoningEffort: "low",
  fastMode: true,
  userSelectableModelBindingIds: ["other"],
  modelReasoningEfforts: { primary: "low" },
  maxSteps: 9,
  toolNames: [],
  subagentNames: [],
  skillNames: [],
  knowledgeBases: [],
  initialPrompts: []
  // `shipped` is server-carried: only the release seed writes it, and a pull skips the agents
  // that carry it.
} satisfies Required<Omit<AgentConfig, "shipped">>;
const skill = {
  name: "guide",
  title: "Guide",
  description: "Use for guidance.",
  summary: "A guide",
  starters: [{ title: "Start", hint: "Hint", prompt: "Help", tools: [] }],
  content: "# Guide",
  resources: [{ path: "references/guide.md", mediaType: "text/markdown", content: "Read this." }],
  frontmatter: { license: "MIT", metadata: { owner: "team", enabled: false } }
} satisfies SkillConfig;
const skillEdits = {
  name: "other",
  title: "Other",
  description: "Other",
  summary: "Other",
  starters: [],
  content: "# Other",
  resources: [{ path: "references/guide.md", mediaType: "text/markdown", content: "Other" }],
  frontmatter: { license: "Other" }
} satisfies Omit<Required<SkillConfig>, "files" | "origin" | "icon">;
const at = "2026-10-18T08:00:00.000Z";
function remote(kind: string, config: AgentConfig | SkillConfig): Asset & AssetSummary {
  return {
    id: `id-${kind}`,
    kind,
    name: config.name,
    title: config.name,
    config: { ...config },
    revision: 1,
    scope: { kind: "instance" },
    updatedAt: at
  };
}
async function fixture(
  assets: Array<Asset & AssetSummary> = [remote("agent", agent), remote("skill", skill)],
  initialize = false
) {
  const cwd = await mkdtemp(join(tmpdir(), "cfg-rt-"));
  directories.push(cwd);
  if (!initialize)
    await writeFile(
      join(cwd, "catalyst.yaml"),
      "instances:\n  local:\n    url: https://catalyst.test\ndefaultInstance: local\nagents: [agents/*.agent.yaml]\nskills: [skills/*/SKILL.md]\nguardrails: [guardrails/*/guardrail.yaml]\n"
    );
  const calls: Array<{ operation: string; body: unknown }> = [];
  const state = { invalidGuardrail: false, rejectRead: false, changedPointer: false };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const operation = Object.values(apiOperations).find(
      (op) =>
        op.method === request.method &&
        new RegExp(`^${op.path.replace(/:[^/]+/gu, "[^/]+")}$`, "u").test(path)
    );
    if (!operation) throw new Error(`Unexpected request ${request.method} ${path}`);
    const body: unknown =
      request.method === "GET" ? undefined : JSON.parse((await request.text()) || "{}");
    calls.push({ operation: operation.id, body });
    switch (operation.id) {
      case "access_tokens.exchange":
        return Response.json({ accessToken: "test-access", expiresAt: "2099-01-01T00:00:00.000Z" });
      case "platform.context.get":
        return Response.json({
          ...platformContext,
          kinds: [
            {
              kind: "agent",
              plural: "agents",
              lifecycle: "active",
              representation: "config",
              owners: ["instance", "workspace"],
              actions: { read: "agent.read", write: "agent.write", delete: "agent.delete" }
            }
          ]
        });
      case "config_assets.get_overview":
        return Response.json({
          version: 1,
          assets: [],
          references: {
            modelProviderIds: [],
            modelBindingIds: [],
            modelBindings: [],
            fastModeModelBindingIds: [],
            reasoningEfforts: [],
            enabledToolNames: [],
            skillNames: []
          }
        });
      case "assets.list":
        return Response.json({
          items: assets.filter((a) => path.endsWith(`/${a.kind}`)),
          hasMore: false
        });
      case "assets.get": {
        if (state.rejectRead)
          return Response.json(
            { error: { code: "FORBIDDEN", message: "Read refused" } },
            { status: 403 }
          );
        const asset = assets.find((a) => path.endsWith(`/${a.kind}/${a.name}`));
        return asset
          ? Response.json(asset)
          : Response.json(
              { error: { code: "NOT_FOUND", message: "Missing asset" } },
              { status: 404 }
            );
      }
      case "assets.validate": {
        const invalid = state.invalidGuardrail && JSON.stringify(body).includes('"name":"second"');
        return Response.json({
          valid: !invalid,
          issues: invalid ? [{ path: ["event"], message: "Unknown event with private value" }] : []
        });
      }
      case "assets.sync_check":
        return Response.json({ valid: true });
      case "assets.sync":
        return Response.json({ version: 2, items: [], warnings: [] });
      case "assets.put":
        return Response.json({ version: 2, revision: 2, warnings: [] });
      case "assets.set_availability":
      case "assets.set_default": {
        if (state.changedPointer)
          return Response.json(
            { error: { code: "REVISION_CONFLICT", message: "Pointer changed" } },
            { status: 412 }
          );
        return Response.json(
          operation.id === "assets.set_default"
            ? { version: 2 }
            : { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] }
        );
      }
      default:
        throw new Error(`Unexpected operation ${operation.id}`);
    }
  };
  const run = async (args: string[]) => {
    const out: string[] = [],
      err: string[] = [];
    const code = await runCli(args, {
      cwd,
      env: { CATALYST_API_KEY: "test-cli-key" },
      fetchImpl,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s)
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  const pull = async () => {
    const result = await run(["config", "pull"]);
    expect(result, result.err).toMatchObject({ code: 0 });
  };
  const read = async () => readWorkingCopy(cwd, await readManifest(cwd));
  return { cwd, calls, state, run, pull, read };
}
async function oldCopy(f: Awaited<ReturnType<typeof fixture>>, serverOrder: boolean) {
  await f.pull();
  const { subagentNames: _subagents, knowledgeBases: _knowledge, ...oldAgent } = agent;
  const canonical = serializeAgentYaml(oldAgent);
  const contents = serverOrder
    ? canonical.replace("  a: low\n  z: high", "  z: high\n  a: low")
    : canonical;
  if (serverOrder) expect(contents).not.toBe(canonical);
  await writeFile(join(f.cwd, "agents/helper.agent.yaml"), contents);
  const path = join(f.cwd, ".catalyst-state.json");
  const state = await readStateFile(path);
  const baseline = state.instances.local?.assets?.["agent:helper"];
  if (!baseline) throw new Error("Missing baseline");
  delete baseline.canonicalFormVersion;
  baseline.hash = createHash("sha256").update(contents).digest("hex");
  await writeStateFile(path, state);
  f.calls.length = 0;
}
describe("config schema round trips", () => {
  it("pulls and reads the complete agent and skill, then pushes them intact after an instructions edit", async () => {
    const f = await fixture();
    await f.pull();
    const local = await f.read();
    expect(local.agents).toEqual([agent]);
    expect(local.skills).toEqual([skill]);
    await writeFile(
      join(f.cwd, "agents/helper.agent.yaml"),
      JSON.stringify({ ...local.agents[0], instructions: "Edited" })
    );
    await writeFile(
      join(f.cwd, "skills/guide/SKILL.md"),
      serializeSkillMarkdown({ ...local.skills[0], content: "# Edited" })
    );
    const result = await f.run(["config", "push"]);
    expect(result, result.err).toMatchObject({ code: 0 });
    expect(f.calls.find((c) => c.operation === "assets.sync")?.body).toMatchObject({
      items: [
        { kind: "agent", config: { ...agent, instructions: "Edited" } },
        { kind: "skill", config: { ...skill, content: "# Edited" } }
      ]
    });
  });
  for (const [key, value] of Object.entries(agentEdits)) {
    it(`detects an edit to agent.${key} after pull`, async () => {
      const f = await fixture();
      await f.pull();
      await writeFile(
        join(f.cwd, "agents/helper.agent.yaml"),
        JSON.stringify({ ...agent, [key]: value })
      );
      const result = await f.run(["config", "push"]);
      expect(result, result.err).toMatchObject({ code: 0 });
      expect(f.calls.find((c) => c.operation === "assets.sync")?.body).toMatchObject({
        items: [{ kind: "agent", config: { ...agent, [key]: value } }]
      });
    });
  }
  for (const [key, value] of Object.entries(skillEdits)) {
    it(`detects an edit to skill.${key} after pull`, async () => {
      const f = await fixture();
      await f.pull();
      const changed = { ...skill, [key]: value };
      await writeFile(join(f.cwd, "skills/guide/SKILL.md"), serializeSkillMarkdown(changed));
      if (key === "resources")
        await writeFile(join(f.cwd, "skills/guide/references/guide.md"), "Other");
      const result = await f.run(["config", "push"]);
      expect(result, result.err).toMatchObject({ code: 0 });
      expect(f.calls.find((c) => c.operation === "assets.sync")?.body).toMatchObject({
        items: [{ kind: "skill", config: changed }]
      });
    });
  }
  it("classifies every schema field as authored or server-carried", () => {
    const carried = {
      files: [
        { path: "assets/icon.png", sha256: "a".repeat(64), bytes: 1, mediaType: "image/png" }
      ],
      origin: "release",
      icon: "book"
    };
    expect([...Object.keys(agentEdits), "shipped"].sort()).toEqual(
      Object.keys(agentConfigSchema.shape).sort()
    );
    expect([...Object.keys(skillEdits), ...Object.keys(carried)].sort()).toEqual(
      Object.keys(skillConfigSchema.shape).sort()
    );
    expect(canonicalizeAgentConfig(agent)).toEqual(agentConfigSchema.parse(agent));
    expect(canonicalizeSkillConfig({ ...skill, ...carried })).toEqual(skill);
    for (const key of Object.keys(skillEdits)) {
      const without = Object.fromEntries(Object.entries(skill).filter(([name]) => name !== key));
      if (skillConfigSchema.safeParse(without).success)
        expect(canonicalizeSkillConfig(without)).not.toEqual(canonicalizeSkillConfig(skill));
    }
  });
  it("ignores server-carried skill fields after a fresh pull and never sends them as edits", async () => {
    const indexed = {
      ...skill,
      files: [
        { path: "assets/icon.png", sha256: "a".repeat(64), bytes: 1, mediaType: "image/png" }
      ],
      origin: "release" as const,
      icon: "book"
    };
    const f = await fixture([remote("skill", indexed)]);
    await f.pull();
    const unchanged = await f.run(["config", "push"]);
    expect(unchanged.out).toContain("No local changes to push.");
    expect(f.calls.some((c) => c.operation === "assets.sync")).toBe(false);
    await writeFile(
      join(f.cwd, "skills/guide/SKILL.md"),
      serializeSkillMarkdown({ ...skill, content: "Edited" })
    );
    expect((await f.run(["config", "push"])).code).toBe(0);
    expect(f.calls.find((c) => c.operation === "assets.sync")?.body).toMatchObject({
      items: [{ kind: "skill", config: { ...skill, content: "Edited" } }]
    });
    expect(JSON.stringify(f.calls.find((c) => c.operation === "assets.sync")?.body)).not.toMatch(
      /"(?:files|origin|icon)":/u
    );
  });
  for (const edited of [false, true]) {
    it(`refuses an old canonical baseline before any write, with local edit = ${edited}`, async () => {
      const f = await fixture();
      await oldCopy(f, true);
      if (edited) {
        const local = (await f.read()).agents[0];
        await writeFile(
          join(f.cwd, "agents/helper.agent.yaml"),
          JSON.stringify({ ...local, instructions: "Edited" })
        );
      }
      const result = await f.run(["config", "push"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("agent:helper: baseline uses an older canonical form");
      expect(result.err).toContain("Run 'catalyst config pull' first");
      expect(f.calls).toEqual([]);
    });
  }
  it("refuses pruning an asset with an old canonical baseline before any write", async () => {
    const f = await fixture();
    await oldCopy(f, true);
    await rm(join(f.cwd, "agents/helper.agent.yaml"));
    const result = await f.run(["config", "push", "--prune"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("agent:helper: baseline uses an older canonical form");
    expect(f.calls).toEqual([]);
  });
  for (const serverOrder of [false, true]) {
    it(`refetches an old canonical baseline at the same revision, server-order hash = ${serverOrder}`, async () => {
      const f = await fixture();
      await oldCopy(f, serverOrder);
      await f.pull();
      expect(f.calls.filter((c) => c.operation === "assets.get")).toHaveLength(1);
      expect((await f.read()).agents).toEqual([agent]);
      const state = await readStateFile(join(f.cwd, ".catalyst-state.json"));
      expect(state.instances.local?.assets?.["agent:helper"]?.canonicalFormVersion).toBe(
        CANONICAL_FORM_VERSION
      );
      f.calls.length = 0;
      expect((await f.run(["config", "push"])).out).toContain("No local changes to push.");
      expect(f.calls.some((c) => c.operation === "assets.sync")).toBe(false);
    });
  }
  it("a scoped pull leaves unselected old baselines refused", async () => {
    const f = await fixture();
    await oldCopy(f, true);
    expect((await f.run(["config", "pull", "--only", "skill:guide"])).code).toBe(0);
    expect((await f.run(["config", "push"])).err).toContain(
      "agent:helper: baseline uses an older canonical form"
    );
  });
  it("treats reordered free-form maps as no local edit", async () => {
    const f = await fixture();
    await f.pull();
    await writeFile(
      join(f.cwd, "agents/helper.agent.yaml"),
      JSON.stringify({ ...agent, displayName: { de: "Helfer", en: "Helper" } })
    );
    await writeFile(
      join(f.cwd, "skills/guide/SKILL.md"),
      serializeSkillMarkdown({
        ...skill,
        frontmatter: { metadata: { enabled: false, owner: "team" }, license: "MIT" }
      })
    );
    const result = await f.run(["config", "push"]);
    expect(result.out).toContain("No local changes to push.");
    expect(f.calls.some((c) => c.operation === "assets.sync")).toBe(false);
  });
  it("ignores map key order and rejects malformed input", () => {
    expect(
      canonicalizeAgentConfig({ ...agent, modelReasoningEfforts: { a: "low", b: "high" } })
    ).toEqual(
      canonicalizeAgentConfig({ ...agent, modelReasoningEfforts: { b: "high", a: "low" } })
    );
    expect(() => canonicalizeAgentConfig({ ...agent, subagentNames: ["same", "same"] })).toThrow();
    expect(() =>
      canonicalizeSkillConfig({ ...skill, frontmatter: { title: "collision" } })
    ).toThrow();
    expect(() => parseSkillFile("---\ndescription: [\n---\ntext")).toThrow();
  });
});

const guardrail = {
  name: "no-values",
  displayName: "No values",
  on: "asset.before_write",
  check: { kind: "pattern", paths: ["config.instructions"], pattern: "example", reason: "Blocked" },
  outcome: "block"
};
async function editGuardrail(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  await mkdir(join(f.cwd, "guardrails", name), { recursive: true });
  await writeFile(
    join(f.cwd, "guardrails", name, "guardrail.yaml"),
    JSON.stringify({ ...guardrail, name, displayName: "Edited" })
  );
}
describe("push guardrail preflight", () => {
  it("refuses an invalid guardrail before sending the agent batch or any guardrail write", async () => {
    const f = await fixture();
    await f.pull();
    await writeFile(
      join(f.cwd, "agents/helper.agent.yaml"),
      JSON.stringify({ ...agent, instructions: "Edited" })
    );
    await editGuardrail(f, "first");
    await editGuardrail(f, "second");
    f.state.invalidGuardrail = true;
    const result = await f.run(["config", "push"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("1 issue (event); nothing was applied");
    expect(result.err).not.toContain("private value");
    expect(
      f.calls.filter((c) => ["assets.sync", "assets.put", "assets.delete"].includes(c.operation))
    ).toEqual([]);
  });
  it("checks all guardrails before the first mutation", async () => {
    const f = await fixture();
    await f.pull();
    await writeFile(
      join(f.cwd, "agents/helper.agent.yaml"),
      JSON.stringify({ ...agent, instructions: "Edited" })
    );
    await editGuardrail(f, "first");
    await editGuardrail(f, "second");
    const result = await f.run(["config", "push"]);
    expect(result, result.err).toMatchObject({ code: 0 });
    expect(
      f.calls
        .filter((c) => ["assets.validate", "assets.sync", "assets.put"].includes(c.operation))
        .map((c) => c.operation)
    ).toEqual(["assets.validate", "assets.validate", "assets.sync", "assets.put", "assets.put"]);
  });
  it("refuses a stale guardrail before applying an otherwise valid batch", async () => {
    const stored = {
      ...remote("agent", agent),
      id: "guardrail-id",
      kind: "guardrail",
      name: guardrail.name,
      config: guardrail
    };
    const f = await fixture([remote("agent", agent), stored]);
    await f.pull();
    stored.revision = 2;
    await writeFile(
      join(f.cwd, "agents/helper.agent.yaml"),
      JSON.stringify({ ...agent, instructions: "Edited" })
    );
    await editGuardrail(f, guardrail.name);
    const result = await f.run(["config", "push"]);
    expect(result.code).toBe(1);
    expect(f.calls.some((c) => c.operation === "assets.sync")).toBe(false);
  });
});
describe("asset pointer preconditions", () => {
  for (const availability of [
    undefined,
    { mode: "selected" as const, personalWorkspaces: true, collaborationWorkspaceIds: ["team"] }
  ]) {
    it(`guards availability against the asset id and ${availability ? "stored state" : "absence"}`, async () => {
      const asset = {
        ...remote("agent", agent),
        ...(availability === undefined ? {} : { availability })
      };
      const f = await fixture([asset]);
      const result = await f.run(["agent", "set-availability", "helper", "--mode", "selected"]);
      expect(result, result.err).toMatchObject({ code: 0 });
      expect(f.calls.find((c) => c.operation === "assets.set_availability")?.body).toMatchObject({
        expectedAssetId: asset.id,
        expectedAvailability: availability ?? null
      });
    });
  }
  it("guards the default's target id and clears without inventing a target", async () => {
    const f = await fixture();
    expect((await f.run(["agent", "set-default", "helper"])).code).toBe(0);
    expect(f.calls.find((c) => c.operation === "assets.set_default")?.body).toEqual({
      name: "helper",
      expectedAssetId: "id-agent"
    });
    f.calls.length = 0;
    expect((await f.run(["agent", "set-default", "--none"])).code).toBe(0);
    expect(f.calls.some((c) => c.operation === "assets.get")).toBe(false);
    expect(f.calls.find((c) => c.operation === "assets.set_default")?.body).toEqual({ name: null });
  });
  for (const args of [
    ["set-availability", "helper", "--mode", "all"],
    ["set-default", "helper"]
  ]) {
    it(`stops ${args[0]} on a refused read or a concurrency conflict`, async () => {
      const f = await fixture();
      f.state.rejectRead = true;
      expect((await f.run(["agent", ...args])).code).toBe(1);
      expect(f.calls.some((c) => c.operation.startsWith("assets.set_"))).toBe(false);
      f.state.rejectRead = false;
      f.state.changedPointer = true;
      const refused = await f.run(["agent", ...args]);
      expect(refused.code).toBe(1);
      if (args[0] === "set-default")
        expect(refused.err).toContain("Run 'catalyst agent list' and retry");
      expect(f.calls.filter((c) => c.operation.startsWith("assets.set_"))).toHaveLength(1);
    });
  }
});

// Platform Access check 32: guidance stays local through the complete working-copy cycle.
describe("catalyst init (ADISC-2 check 32)", () => {
  const init = ["init", "--instance", "https://catalyst.test///"];
  const originals = async (cwd: string) =>
    Promise.all(
      ["catalyst.yaml", "AGENTS.md", "CLAUDE.md"].map((name) => readFile(join(cwd, name), "utf8"))
    );

  it("initializes offline, is byte-idempotent, and runs context, pull, edit, validate, diff and push", async () => {
    const f = await fixture([remote("skill", skill)], true);
    expect(await f.run(init)).toMatchObject({ code: 0 });
    expect(f.calls).toEqual([]);
    expect((await readdir(f.cwd)).sort()).toEqual(["AGENTS.md", "CLAUDE.md", "catalyst.yaml"]);
    const before = await originals(f.cwd);
    expect(await readManifest(f.cwd)).toEqual({
      instances: { "catalyst.test": { url: "https://catalyst.test" } },
      defaultInstance: "catalyst.test",
      agents: ["agents/*.agent.yaml"],
      skills: ["skills/*/SKILL.md"]
    });
    expect(before[2]).toBe("@AGENTS.md\n");
    expect(await f.run(init)).toMatchObject({ code: 0 });
    expect(await originals(f.cwd)).toEqual(before);
    expect(await f.run(["init", "--instance", "catalyst.test"])).toMatchObject({ code: 0 });
    expect(await f.run(["init", "--instance", "https://other.test"])).toMatchObject({
      code: 2,
      err: expect.stringContaining("catalyst.test")
    });
    expect(await f.run(["context", "--json"])).toMatchObject({ code: 0 });
    await f.pull();
    expect(await originals(f.cwd)).toEqual(before);
    await writeFile(
      join(f.cwd, "skills/guide/SKILL.md"),
      serializeSkillMarkdown({ ...skill, content: "Edited." })
    );
    for (const command of ["validate", "diff", "push"]) {
      const result = await f.run(["config", command]);
      expect(result, JSON.stringify({ command, result })).toMatchObject({
        code: command === "diff" ? 1 : 0
      });
    }
    const sent = f.calls.filter((call) =>
      ["assets.sync", "assets.sync_check"].includes(call.operation)
    );
    expect(sent.some((call) => call.operation === "assets.sync")).toBe(true);
    expect(JSON.stringify(sent)).not.toMatch(/AGENTS\.md|CLAUDE\.md|catalyst\.yaml/u);
    expect(await originals(f.cwd)).toEqual(before);
    // Only the manifest binds the URL; agent guidance has no key or address.
    for (const text of before.slice(1)) expect(text).not.toMatch(/test-cli-key|http/u);
    for (const text of before) expect(text).not.toContain("test-cli-key");
    const bare = await fixture([remote("skill", skill)]);
    await bare.pull();
    expect(await readdir(bare.cwd)).not.toEqual(expect.arrayContaining(["AGENTS.md", "CLAUDE.md"]));
  });

  it("keeps an existing AGENTS.md import without asking to add it again", async () => {
    const f = await fixture([], true);
    expect(await f.run(init)).toMatchObject({ code: 0 });
    const claude = "# Our rules\r\n@AGENTS.md\r\nKeep this.\r\n";
    await writeFile(join(f.cwd, "CLAUDE.md"), claude);
    expect(await f.run(init)).toMatchObject({
      code: 0,
      out: expect.stringContaining("Left CLAUDE.md unchanged.")
    });
    expect(await readFile(join(f.cwd, "CLAUDE.md"), "utf8")).toBe(claude);
    expect(f.calls).toEqual([]);
  });

  it("matches an existing instance by URL origin with a case-insensitive host", async () => {
    const f = await fixture([], true);
    expect(await f.run(["init", "--instance", "https://Chat.Example.com"])).toMatchObject({
      code: 0
    });
    const before = await originals(f.cwd);
    expect(await f.run(["init", "--instance", "https://chat.example.com:443/"])).toMatchObject({
      code: 0
    });
    expect(await originals(f.cwd)).toEqual(before);
    for (const instance of [
      "http://chat.example.com",
      "https://chat.example.com:444",
      "https://other.example.com"
    ]) {
      expect(await f.run(["init", "--instance", instance])).toMatchObject({ code: 2 });
      expect(await originals(f.cwd)).toEqual(before);
    }
    expect(f.calls).toEqual([]);
  });

  it("preserves every byte outside the block and leaves the person's CLAUDE.md alone", async () => {
    const f = await fixture([], true);
    const above = "# Our rules\r\nKeep this exactly.  \r\n";
    const below = "\r\nWords below.  \r\n";
    const claude = "Our Claude instructions\r\n";
    await writeFile(
      join(f.cwd, "AGENTS.md"),
      above + "<!-- catalyst:begin -->old block<!-- catalyst:end -->" + below
    );
    await writeFile(join(f.cwd, "CLAUDE.md"), claude);
    expect(await f.run(init)).toMatchObject({
      code: 0,
      out: expect.stringContaining('CLAUDE.md is yours: add "@AGENTS.md"')
    });
    const text = await readFile(join(f.cwd, "AGENTS.md"), "utf8");
    expect(text.slice(0, text.indexOf("<!-- catalyst:begin -->"))).toBe(above);
    expect(text.slice(text.indexOf("<!-- catalyst:end -->") + "<!-- catalyst:end -->".length)).toBe(
      below
    );
    expect(await readFile(join(f.cwd, "CLAUDE.md"), "utf8")).toBe(claude);
    const unmarked = above + below;
    await writeFile(join(f.cwd, "AGENTS.md"), unmarked);
    expect(await f.run(init)).toMatchObject({ code: 0 });
    expect(await readFile(join(f.cwd, "AGENTS.md"), "utf8")).toBe(
      unmarked + "\n" + text.slice(above.length, text.length - below.length) + "\n"
    );
  });

  it.each([
    "<!-- catalyst:begin -->",
    "<!-- catalyst:end -->",
    "<!-- catalyst:begin --><!-- catalyst:begin --><!-- catalyst:end -->",
    "<!-- catalyst:end --><!-- catalyst:begin -->"
  ])("refuses malformed markers without writing: %s", async (text) => {
    const f = await fixture([], true);
    await writeFile(join(f.cwd, "AGENTS.md"), text);
    expect(await f.run(init)).toMatchObject({ code: 1, err: expect.stringContaining("markers") });
    expect(await readdir(f.cwd)).toEqual(["AGENTS.md"]);
    expect(await readFile(join(f.cwd, "AGENTS.md"), "utf8")).toBe(text);
    expect(f.calls).toEqual([]);
  });
});
