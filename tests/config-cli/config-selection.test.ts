import { createTestFetch } from "../support/test-instance";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  canonicalizeAgentConfig,
  runCli,
  runConfigCommand,
  serializeAgentYaml,
  serializeSkillMarkdown,
  writeStateFile
} from "@work-shape/catalyst-cli";
import { applyAtCurrentRevisions } from "../support/asset-revisions";
import {
  createTemporaryDirectory,
  createFixture,
  writeMinimalManifest,
  pulledBaseline,
  instanceHolding,
  agentConfig,
  skillConfig
} from "../support/config-cli";

describe("config CLI command flows", () => {
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
            // The pull saw no draft: the push writes one only where none is pending.
            expectedDraftRevision: null,
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
            // The pull saw no draft: the push writes one only where none is pending.
            expectedDraftRevision: null,
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
});
