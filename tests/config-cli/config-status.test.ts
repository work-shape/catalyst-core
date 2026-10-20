import { createTestFetch } from "../support/test-instance";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  canonicalizeAgentConfig,
  parseAgentYaml,
  readStateFile,
  runCli,
  runConfigCommand,
  serializeAgentYaml,
  serializeSkillMarkdown,
  parseSkillFile
} from "@work-shape/catalyst-cli";
import { applyAtCurrentRevisions } from "../support/asset-revisions";
import {
  createTemporaryDirectory,
  createFixture,
  writeMinimalManifest,
  instanceHolding,
  agentConfig,
  skillConfig
} from "../support/config-cli";

describe("config CLI command flows", () => {
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
});
