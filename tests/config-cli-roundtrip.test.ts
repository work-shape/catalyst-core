import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  canonicalizeAgentConfig,
  canonicalizeSkillConfig,
  parseSkillFile,
  readManifest,
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
  modelReasoningEfforts: {},
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
} satisfies Required<AgentConfig>;
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
  assets: Array<Asset & AssetSummary> = [remote("agent", agent), remote("skill", skill)]
) {
  const cwd = await mkdtemp(join(tmpdir(), "cfg-rt-"));
  directories.push(cwd);
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
  it("keeps every parsed schema key, including release metadata and file indexes outside the authored working copy", () => {
    const indexed = {
      ...skill,
      files: [
        { path: "assets/icon.png", sha256: "a".repeat(64), bytes: 1, mediaType: "image/png" }
      ],
      origin: "release",
      icon: "book"
    };
    expect(Object.keys(agent).sort()).toEqual(Object.keys(agentConfigSchema.shape).sort());
    expect(Object.keys(indexed).sort()).toEqual(Object.keys(skillConfigSchema.shape).sort());
    expect(canonicalizeAgentConfig(agent)).toEqual(agentConfigSchema.parse(agent));
    expect(canonicalizeSkillConfig(indexed)).toEqual(skillConfigSchema.parse(indexed));
    for (const key of Object.keys(indexed)) {
      const without = Object.fromEntries(Object.entries(indexed).filter(([name]) => name !== key));
      if (skillConfigSchema.safeParse(without).success)
        expect(canonicalizeSkillConfig(without)).not.toEqual(canonicalizeSkillConfig(indexed));
    }
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
    expect(result.err).toContain("nothing was applied");
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
      expect((await f.run(["agent", ...args])).code).toBe(1);
      expect(f.calls.filter((c) => c.operation.startsWith("assets.set_"))).toHaveLength(1);
    });
  }
});
