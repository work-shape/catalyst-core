import { testOperations } from "../support/operations";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  readStateFile,
  runConfigCommand,
  serializeSkillMarkdown
} from "@work-shape/catalyst-cli";
import { applyAtCurrentRevisions } from "../support/asset-revisions";
import {
  createTemporaryDirectory,
  writeMinimalManifest,
  instanceHolding,
  skillConfig
} from "../support/config-cli";

describe("config CLI guardrails in the working copy", () => {
  const judge = {
    name: "privacy",
    displayName: "Privacy",
    on: "asset.before_write",
    filter: { kind: "skill" },
    check: {
      kind: "model_judge",
      modelBindingId: "local",
      instruction: "Block a skill that names a person.\n\nNames of companies are fine."
    },
    outcome: "block",
    origin: "asset"
  };

  const pattern = {
    name: "no_iban",
    displayName: "No IBAN in skills",
    on: "asset.before_write",
    filter: { kind: "skill" },
    check: {
      kind: "pattern",
      pattern: "\\bDE\\d{2}(?:\\s?\\d{4}){4}\\s?\\d{2}\\b",
      reason: "Skills hold no bank account."
    },
    outcome: "block",
    origin: "asset"
  };

  async function guardrailWorkingCopy(): Promise<string> {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    await writeFile(
      resolve(directory, "catalyst.yaml"),
      `${await readFile(resolve(directory, "catalyst.yaml"), "utf8")}guardrails:\n  - guardrails/*/guardrail.yaml\n`,
      "utf8"
    );
    return directory;
  }

  const commandOptions = (directory: string, fetchImpl: typeof fetch, output: string[]) => ({
    cwd: directory,
    env: { CATALYST_API_KEY: "cat_guardrails" },
    fetchImpl,
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => output.push(text)
  });

  it("pulls a judge into guardrail.yaml and check.md, a pattern into guardrail.yaml alone", async () => {
    const directory = await guardrailWorkingCopy();
    // A check.md of an earlier pull does not survive a check that holds none.
    await mkdir(resolve(directory, "guardrails", "no_iban"), { recursive: true });
    await writeFile(resolve(directory, "guardrails", "no_iban", "check.md"), "Stale.\n", "utf8");
    const { fetchImpl } = await instanceHolding({
      agents: [],
      skills: [],
      guardrails: [judge, pattern]
    });
    const output: string[] = [];
    const options = commandOptions(directory, fetchImpl, output);

    expect(await runConfigCommand("pull", options), output.join("")).toBe(0);
    expect(output.join("")).toContain("Pulled 0 agents, 0 skills, 2 guardrails");
    const privacy = resolve(directory, "guardrails", "privacy");
    expect((await readdir(privacy)).sort()).toEqual(["check.md", "guardrail.yaml"]);
    expect(await readFile(resolve(privacy, "check.md"), "utf8")).toBe(
      `${judge.check.instruction}\n`
    );
    const judgeYaml = await readFile(resolve(privacy, "guardrail.yaml"), "utf8");
    expect(judgeYaml).toContain("kind: model_judge");
    expect(judgeYaml).not.toContain("instruction");
    expect(judgeYaml).not.toContain("origin");
    expect(await readdir(resolve(directory, "guardrails", "no_iban"))).toEqual(["guardrail.yaml"]);

    // What was pulled is what the instance holds: no difference and nothing to push.
    output.length = 0;
    expect(await runConfigCommand("diff", options), output.join("")).toBe(0);
    expect(output.join("")).toContain("No differences.");
    expect(await runConfigCommand("push", options)).toBe(0);
    expect(output.join("")).toContain("No local changes to push.");
  });

  it("puts an edited check.md as the guardrail's next draft after the sync, and --only selects it", async () => {
    const directory = await guardrailWorkingCopy();
    const syncs: unknown[] = [];
    const { fetchImpl: instanceFetch, fixture } = await instanceHolding(
      { agents: [], skills: [], guardrails: [judge, pattern] },
      syncs
    );
    // Every call that writes, in the order the CLI sends them.
    const writes: Array<{ path: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method !== "GET" && path !== testOperations["access_tokens.exchange"].path) {
        writes.push({
          path: `${request.method} ${path}`,
          body: JSON.parse(await request.clone().text())
        });
      }
      return instanceFetch(request);
    };
    const output: string[] = [];
    const options = commandOptions(directory, fetchImpl, output);
    expect(await runConfigCommand("pull", options), output.join("")).toBe(0);

    const checkPath = resolve(directory, "guardrails", "privacy", "check.md");
    const patternYaml = resolve(directory, "guardrails", "no_iban", "guardrail.yaml");
    await writeFile(checkPath, "Edited and dropped.\n", "utf8");
    await writeFile(
      patternYaml,
      (await readFile(patternYaml, "utf8")).replace("outcome: block", "outcome: warn"),
      "utf8"
    );
    // A pull of the judge alone brings back its instruction and leaves the pattern as edited.
    expect(await runConfigCommand("pull", { ...options, only: ["guardrail:privacy"] })).toBe(0);
    expect(await readFile(checkPath, "utf8")).toBe(`${judge.check.instruction}\n`);
    expect(await readFile(patternYaml, "utf8")).toContain("outcome: warn");

    const instruction = "Block a skill that names a person or a phone number.";
    await writeFile(checkPath, `${instruction}\n`, "utf8");
    await mkdir(resolve(directory, "skills", "review"), { recursive: true });
    await writeFile(
      resolve(directory, "skills", "review", "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Review")),
      "utf8"
    );
    output.length = 0;
    expect(
      await runConfigCommand("push", {
        ...options,
        only: ["skill:review", "guardrail:privacy"]
      }),
      output.join("")
    ).toBe(0);
    expect(output.join("")).toContain(
      "Guardrails to write one by one, each as its draft:\n- guardrail:privacy"
    );
    expect(output.join("")).toContain("Pushed 0 agents, 1 skill, version");
    expect(output.join("")).toContain("Wrote guardrail:privacy as draft revision 2");
    // The batch holds the skill alone; the guardrail is put after it, against its pulled revision.
    const { origin: _origin, ...definition } = judge;
    expect(writes.map((write) => write.path)).toEqual([
      "POST /api/v1/assets/guardrail/validate",
      "POST /api/v1/assets/sync/check",
      "POST /api/v1/assets/sync",
      "PUT /api/v1/assets/guardrail/privacy"
    ]);
    expect(syncs).toEqual([
      {
        items: [
          {
            type: "put",
            kind: "skill",
            config: skillConfig("review", "Review"),
            expectedRevision: null
          }
        ]
      }
    ]);
    expect(writes[3]?.body).toEqual({
      config: { ...definition, check: { ...judge.check, instruction } },
      expectedRevision: 1
    });
    const stored = await fixture.store.configAssets.getConfigAsset({
      clientInstanceId: fixture.clientInstanceId,
      kind: "guardrail",
      name: "privacy"
    });
    expect(stored).toMatchObject({ revision: 2, config: { check: { instruction } } });
    expect(
      (await readStateFile(resolve(directory, STATE_FILENAME))).instances.local?.assets?.[
        "guardrail:privacy"
      ]
    ).toMatchObject({ id: "cfga_held_guardrail_privacy", revision: 2 });

    // Only the pattern is left changed locally.
    output.length = 0;
    expect(await runConfigCommand("diff", options)).toBe(1);
    expect(output.join("")).toContain("guardrail:no_iban: changed locally");
    expect(output.join("")).not.toContain("guardrail:privacy");

    // Changed on the instance since: preflight refuses before any write and names the pull.
    await applyAtCurrentRevisions(fixture.store.configAssets, {
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "guardrail",
          name: "privacy",
          assetId: "cfga_held_guardrail_privacy",
          config: { ...judge, displayName: "Privacy, edited there" }
        }
      ]
    });
    await writeFile(checkPath, "Edited here as well.\n", "utf8");
    output.length = 0;
    writes.length = 0;
    expect(await runConfigCommand("push", { ...options, only: ["guardrail:privacy"] })).toBe(1);
    expect(output.join("")).toContain(
      "Push refused; nothing was applied. guardrail:privacy changed since the last pull."
    );
    expect(output.join("")).toContain("catalyst config pull --only guardrail:privacy");
    expect(writes).toEqual([]);

    expect(await runConfigCommand("pull", { ...options, only: ["guardrails:privacy"] })).toBe(1);
    expect(output.join("")).toContain("guardrail:<name>");
  });

  it("neither pulls nor prunes guardrails where catalyst.yaml names none", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const { fetchImpl } = await instanceHolding({ agents: [], skills: [], guardrails: [judge] });
    const output: string[] = [];
    expect(await runConfigCommand("pull", commandOptions(directory, fetchImpl, output))).toBe(0);
    expect(output.join("")).toContain("Pulled 0 agents, 0 skills, version 1.");
    expect(await readdir(directory)).not.toContain("guardrails");
  });
});
