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
  serializeAgentYaml,
  serializeSkillMarkdown,
  writeStateFile,
  CANONICAL_FORM_VERSION,
  updateManifestDefaultAgent
} from "@work-shape/catalyst-cli";
import { applyAtCurrentRevisions } from "../support/asset-revisions";
import {
  createTemporaryDirectory,
  createFixture,
  writeMinimalManifest,
  pulledBaseline,
  instanceHolding,
  agentConfig,
  skillConfig,
  jsonResponse
} from "../support/config-cli";
import { UNKNOWN_OPERATION_REASON } from "@work-shape/catalyst-api-contract";

describe("config CLI command flows", () => {
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
              canonicalFormVersion: CANONICAL_FORM_VERSION,
              revision: 1,
              hash: expect.any(String),
              draftRevision: null
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
});
