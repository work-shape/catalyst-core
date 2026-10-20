import { testOperations } from "../support/operations";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { UNKNOWN_OPERATION_REASON } from "@work-shape/catalyst-api-contract";
import { describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  canonicalizeAgentConfig,
  runConfigCommand,
  serializeAgentYaml,
  serializeSkillMarkdown,
  CANONICAL_FORM_VERSION,
  writeStateFile
} from "@work-shape/catalyst-cli";
import {
  createTemporaryDirectory,
  createFixture,
  writeMinimalManifest,
  jsonResponse,
  recordEmptyPull,
  instanceHolding,
  agentConfig,
  skillConfig
} from "../support/config-cli";
import { callTestPath } from "../support/test-instance";
import { retiredReleasePaths } from "../support/retired-api-paths";

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
          assets: {
            "skill:review": {
              canonicalFormVersion: CANONICAL_FORM_VERSION,
              revision: 1,
              hash: "0".repeat(64)
            }
          }
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
