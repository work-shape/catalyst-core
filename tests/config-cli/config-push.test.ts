import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  runCli,
  serializeAgentYaml,
  serializeSkillMarkdown,
  writeStateFile
} from "@work-shape/catalyst-cli";
import {
  createTemporaryDirectory,
  writeMinimalManifest,
  pulledBaseline,
  instanceHolding,
  agentConfig,
  recordEmptyPull,
  heldAssetId
} from "../support/config-cli";

describe("config CLI command flows", () => {
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
    expect(placed).toContain("Pushed 1 agent, 0 skills, version 4.");
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
      "Guardrail 'No IBAN in skills' blocked skill 'Kunden-FAQ': Skills hold no bank account."
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
});
