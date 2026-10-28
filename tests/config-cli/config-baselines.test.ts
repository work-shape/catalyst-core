import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  canonicalizeAgentConfig,
  readStateFile,
  runConfigCommand,
  serializeAgentYaml,
  serializeSkillMarkdown
} from "@work-shape/catalyst-cli";
import { applyAtCurrentRevisions } from "../support/asset-revisions";
import {
  createTemporaryDirectory,
  writeMinimalManifest,
  instanceHolding,
  publishPushedDraft,
  agentConfig,
  skillConfig
} from "../support/config-cli";

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
    // The skill is the instance's: the push wrote its draft, which a person publishes.
    await publishPushedDraft(second.fixture, "skill", "review");
    expect(await stored("review")).toMatchObject({ revision: 2, config: { content: "# Local" } });
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
});
