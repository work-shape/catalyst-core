import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ASSET_SYNC_BODY_MAX_BYTES,
  ASSET_SYNC_ITEM_MAX_BYTES
} from "@work-shape/catalyst-api-contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  canonicalizeAgentConfig,
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

  const syncRuns = async (fixture: Awaited<ReturnType<typeof createFixture>>) =>
    (await fixture.store.operationRuns.list({ clientInstanceId: fixture.clientInstanceId })).filter(
      (run) => run.operation === "assets.sync"
    );

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

  it.each([
    {
      label: "toolNames",
      instructions: "Help.",
      toolNames: ["known.missing"],
      location: "toolNames[0]"
    },
    {
      label: "instructions",
      instructions: "Help.\nUse known.missing.",
      toolNames: [],
      location: "instructions line 2"
    }
  ])(
    "validate and push refuse an unavailable tool in $label before sending a write",
    async ({ instructions, toolNames, location }) => {
      const syncs: unknown[] = [];
      const { fetchImpl, fixture } = await instanceHolding({ agents: [], skills: [] }, syncs);
      const directory = await createTemporaryDirectory();
      await writeMinimalManifest(directory, "https://catalyst.test", "assistant");
      await mkdir(resolve(directory, "agents"));
      await writeFile(
        resolve(directory, "agents/assistant.agent.yaml"),
        serializeAgentYaml({
          ...agentConfig(instructions),
          toolNames
        })
      );
      const output: string[] = [];
      const options = {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_validate_tools" },
        fetchImpl,
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text)
      };
      for (const command of ["validate", "push"] as const) {
        output.length = 0;
        expect(await runConfigCommand(command, options), output.join("")).toBe(1);
        expect(output.join("")).toContain(
          `Agent 'assistant' references unavailable tool 'known.missing' in ${location}`
        );
      }
      expect(syncs).toEqual([]);
      expect(
        (
          await fixture.store.configAssets.getConfigAssetState({
            clientInstanceId: fixture.clientInstanceId
          })
        ).version
      ).toBe(0);
    }
  );

  it("validate and push accept a tool enabled on the target instance", async () => {
    const syncs: unknown[] = [];
    const { fetchImpl } = await instanceHolding({ agents: [], skills: [] }, syncs);
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test", "assistant");
    await mkdir(resolve(directory, "agents"));
    await writeFile(
      resolve(directory, "agents/assistant.agent.yaml"),
      serializeAgentYaml({
        ...agentConfig("Use `known.tool`."),
        toolNames: ["known.tool"]
      })
    );
    const output: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_validate_tools" },
      fetchImpl,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text)
    };
    expect(await runConfigCommand("validate", options), output.join("")).toBe(0);
    expect(syncs).toHaveLength(0);
    expect(await runConfigCommand("push", options), output.join("")).toBe(0);
    expect(syncs).toHaveLength(1);
  });

  it("validate and push display nonblocking tool warnings from the instance", async () => {
    const syncs: unknown[] = [];
    const { fetchImpl } = await instanceHolding({ agents: [], skills: [] }, syncs);
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test", "assistant");
    await mkdir(resolve(directory, "agents"));
    await writeFile(
      resolve(directory, "agents/assistant.agent.yaml"),
      serializeAgentYaml({
        ...agentConfig("Use `known.tool`."),
        toolNames: ["known.tool"]
      })
    );
    const output: string[] = [];
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_validate_tools" },
      fetchImpl: async (resource: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const response = await fetchImpl(resource, init);
        const url = resource instanceof Request ? resource.url : String(resource);
        if (url.endsWith("/assets/sync/check")) {
          return Response.json({
            valid: true,
            warnings: [
              {
                code: "tool_not_callable",
                message: "Connection tool exists but is not callable now"
              }
            ]
          });
        }
        if (url.endsWith("/assets/sync") && response.ok) {
          const body = z.record(z.string(), z.unknown()).parse(await response.json());
          return Response.json({
            ...body,
            warnings: [
              {
                code: "tool_not_callable",
                message: "Connection tool exists but is not callable now"
              }
            ]
          });
        }
        return response;
      },
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text)
    };
    expect(await runConfigCommand("validate", options), output.join("")).toBe(0);
    expect(output.join("")).toContain("Warning: Connection tool exists but is not callable now");
    output.length = 0;
    expect(syncs).toHaveLength(0);
    expect(await runConfigCommand("push", options), output.join("")).toBe(0);
    expect(syncs).toHaveLength(1);
    expect(output.join("")).toContain("Warning: Connection tool exists but is not callable now");
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
});
