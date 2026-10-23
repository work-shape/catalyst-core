import { deniedNames } from "../support/name-hashes";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCatalystSkill, runCli } from "@work-shape/catalyst-cli";
import { temporaryDirectories, unlistedInHelp } from "../support/config-cli";

describe("the Catalyst skill the CLI ships", () => {
  it("names only commands and options that `catalyst --help` lists", async () => {
    const out: string[] = [];
    expect(await runCli(["--help"], { stdout: (text) => out.push(text) })).toBe(0);
    const help = out.join("");
    const skill = await renderCatalystSkill();
    expect(skill).toContain("catalyst config pull");
    expect(unlistedInHelp(skill, help)).toEqual([]);
    const directory = await mkdtemp(join(tmpdir(), "catalyst-init-drift-"));
    temporaryDirectories.push(directory);
    expect(
      await runCli(["init", "--instance", "https://catalyst.test"], {
        cwd: directory,
        stdout: () => undefined
      })
    ).toBe(0);
    expect(unlistedInHelp(await readFile(join(directory, "AGENTS.md"), "utf8"), help)).toEqual([]);

    // The check sees a command, a verb and an option the CLI does not have.
    expect(
      unlistedInHelp(
        "Run `catalyst teleport` and `catalyst agent rename x`, then `catalyst config sync --unknown-skill-flag` and `catalyst agent hits x`, `catalyst workflow rename x` and `catalyst knowledge-base source invent x`.",
        help
      )
    ).toEqual([
      "command 'teleport' in: catalyst teleport",
      "'agent rename' in: catalyst agent rename x",
      "command 'config sync' in: catalyst config sync --unknown-skill-flag",
      "'agent hits' in: catalyst agent hits x",
      "'workflow rename' in: catalyst workflow rename x",
      "'knowledge-base source' in: catalyst knowledge-base source invent x",
      "option '--unknown-skill-flag'"
    ]);
  });

  it("is generic: no instance address, no key and no customer wording", async () => {
    const skill = await renderCatalystSkill();
    expect(skill).toMatch(/^---\nname: catalyst\ndescription: /u);
    expect(deniedNames(skill)).toEqual([]);
    expect(skill).not.toMatch(/https?:\/\//u);
    expect(skill).not.toMatch(/cat\.apic_|finanzierung|vivd|\bkai-/iu);
  });
});
