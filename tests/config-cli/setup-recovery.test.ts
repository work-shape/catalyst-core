import { createTestFetch } from "../support/test-instance";
import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCatalystSkill, runCli } from "@work-shape/catalyst-cli";
import { grantKaiWorkspace, setupPersonalKeyInstance } from "../support/personal-api-keys";
import {
  createTemporaryDirectory,
  SETUP_INSTANCE,
  computerOf,
  sha256Mark
} from "../support/config-cli";

describe("catalyst setup, verifier repros", () => {
  it("never deletes a person's own file: a second --force keeps the first .bak", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".claude", "skills", "catalyst", "SKILL.md");
    await mkdir(join(skillPath, ".."), { recursive: true });
    const first = "---\nname: catalyst\n---\nMy first notes.\n";
    await writeFile(skillPath, first);
    expect(
      (await computer.setup(["claude-code", "--instance", SETUP_INSTANCE, "--force"])).code
    ).toBe(0);
    expect(await readFile(`${skillPath}.bak`, "utf8")).toBe(first);

    // The person writes their own file there again and runs the command with --force again.
    await writeFile(skillPath, "---\nname: catalyst\n---\nMy second notes.\n");
    expect(
      (await computer.setup(["claude-code", "--instance", SETUP_INSTANCE, "--force"])).code
    ).toBe(0);
    const folder = join(skillPath, "..");
    const kept = await Promise.all(
      (await readdir(folder)).map((name) => readFile(join(folder, name), "utf8"))
    );
    expect(kept).toContain(first);
  });

  it("the skill's first command works after setup outside a working copy with one saved instance", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const computer = await computerOf(t);
    expect((await computer.setup(["claude-code", "--instance", SETUP_INSTANCE])).code).toBe(0);

    // The skill: "When more than one instance is saved, pass --instance". One is saved here.
    const cwd = await createTemporaryDirectory();
    const err: string[] = [];
    const code = await runCli(["context", "--json"], {
      cwd,
      env: computer.env,
      fetchImpl: createTestFetch(t.instance),
      stdout: () => undefined,
      stderr: (text) => err.push(text)
    });
    expect(err.join("")).toBe("");
    expect(code).toBe(0);
  });

  it("writes nothing outside the skill folder through a link at SKILL.md", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".claude", "skills", "catalyst", "SKILL.md");
    await mkdir(join(skillPath, ".."), { recursive: true });
    const outside = join(computer.home, "outside.txt");
    await symlink(outside, skillPath);
    await computer.setup(["claude-code", "--instance", SETUP_INSTANCE]);
    await expect(stat(outside)).rejects.toThrow(/ENOENT/u);
  });

  it("writes nothing through a link at SKILL.md to an existing file that holds a skill setup wrote", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".claude", "skills", "catalyst", "SKILL.md");
    await mkdir(join(skillPath, ".."), { recursive: true });
    // Followed, the link would read as an older skill of this CLI, which setup replaces.
    const older = (await renderCatalystSkill()).replace("# Catalyst", "# Catalyst, older");
    const outsideText = older.replace(/sha256 [0-9a-f]{64}/u, sha256Mark(older));
    const outside = join(computer.home, "shared-skill.md");
    await writeFile(outside, outsideText);
    await symlink(outside, skillPath);

    const kept = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE]);
    expect(kept.code).toBe(1);
    expect(kept.err).toContain(`Kept ${skillPath}`);
    expect(await readFile(outside, "utf8")).toBe(outsideText);

    const forced = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE, "--force"]);
    expect(forced.code, forced.err).toBe(0);
    expect(await readFile(outside, "utf8")).toBe(outsideText);
    expect((await lstat(`${skillPath}.bak`)).isSymbolicLink()).toBe(true);
    expect((await lstat(skillPath)).isFile()).toBe(true);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
  });
});
