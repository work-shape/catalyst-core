import { testOperations } from "../support/operations";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  canonicalBundleFiles,
  canonicalizeAgentConfig,
  readManifest,
  readWorkingCopy,
  readStateFile,
  runConfigCommand,
  serializeAgentYaml,
  serializeSkillMarkdown
} from "@work-shape/catalyst-cli";
import {
  createTemporaryDirectory,
  createFixture,
  writeMinimalManifest,
  recordEmptyPull,
  instanceHolding,
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

  const workingCopy = async (directory: string) =>
    readWorkingCopy(directory, await readManifest(directory));

  /**
   * A working copy without the bytes of each SKILL.md: a pull writes where the skill came from
   * into its front matter as comments, which no parse, hash or push reads.
   */
  const withoutSkillManifests = (bundle: Awaited<ReturnType<typeof workingCopy>>) => ({
    ...bundle,
    skillFiles: Object.fromEntries(
      Object.entries(bundle.skillFiles ?? {}).map(([name, files]) => [
        name,
        files.filter((file) => file.path !== "SKILL.md")
      ])
    )
  });

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
    expect(withoutSkillManifests(pulled)).toEqual(withoutSkillManifests(local));
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
    ).toMatchObject({ revision: 1, config: { instructions: "Remote" } });
    expect(await syncRuns(fixture)).toHaveLength(1);
    expect(
      (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local?.assets?.[
        "agent:assistant"
      ]
    ).toMatchObject({ revision: 1 });
  });
});
