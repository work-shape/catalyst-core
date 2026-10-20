import { testOperations } from "../support/operations";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCatalystSkill, runCli } from "@work-shape/catalyst-cli";
import { grantKaiWorkspace, setupPersonalKeyInstance } from "../support/personal-api-keys";
import {
  createTemporaryDirectory,
  saveCredentialsFor,
  jsonResponse,
  SETUP_INSTANCE,
  keysSchema,
  computerOf,
  savedKey,
  sha256Mark
} from "../support/config-cli";

describe("catalyst setup", () => {
  it("logs Claude Code in by a confirmed code, writes its skill, prints no key, and keeps the key on a second run", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".claude", "skills", "catalyst", "SKILL.md");

    const first = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE]);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    // The address asks Settings to start the key with the use level (CLI-PUBLISH-USE).
    expect(computer.opened).toEqual([
      expect.stringMatching(
        /^https:\/\/catalyst\.test\/settings\/you\/api-keys\?code=[A-Z]{4}-[A-Z]{4}&level=use$/u
      )
    ]);
    expect(first.out).toContain("&level=use");
    expect(first.out).toContain(`Instance: ${SETUP_INSTANCE}`);
    expect(first.out).toContain(`Logged in with the key 'Claude Code on ${hostname()}'`);
    expect(first.out).toContain(`agent.read:${t.kaiTeam}`);
    expect(first.out).toContain(`Wrote the Catalyst skill to ${skillPath}.`);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
    const key = await savedKey(computer.env.CATALYST_CONFIG_HOME);
    expect(first.out).not.toContain(key);

    // API keys lists the key by the tool and the computer.
    const keys = keysSchema.parse((await t.expectOk(t.kai.id, "me.api_keys.list")).json());
    expect(keys.items.map((item) => item.name)).toEqual([`Claude Code on ${hostname()}`]);

    // A second run keeps the key, starts no code, and rewrites a skill an older CLI wrote.
    const older = (await renderCatalystSkill()).replace("# Catalyst", "# Catalyst, older");
    await writeFile(skillPath, older.replace(/sha256 [0-9a-f]{64}/u, sha256Mark(older)));
    computer.paths.length = 0;
    const second = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE]);
    expect(second.code).toBe(0);
    expect(second.out).toContain(`Kept the saved key 'Claude Code on ${hostname()}'`);
    expect(second.out).toContain(`Wrote the Catalyst skill to ${skillPath}.`);
    expect(computer.paths).not.toContain(testOperations["connect_codes.start"].path);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
    expect(await savedKey(computer.env.CATALYST_CONFIG_HOME)).toBe(key);
    expect(second.out + second.err).not.toContain(key);

    // A third run finds the skill current.
    expect((await computer.setup(["claude-code", "--instance", SETUP_INSTANCE])).out).toContain(
      "is current"
    );
  });

  it("keeps a different skill file and says so, and with --force keeps it as SKILL.md.bak", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".claude", "skills", "catalyst", "SKILL.md");
    await mkdir(join(skillPath, ".."), { recursive: true });
    await writeFile(skillPath, "---\nname: catalyst\n---\nMy own notes.\n");

    const kept = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE]);
    expect(kept.code).toBe(1);
    expect(kept.err).toContain(`Kept ${skillPath}: it is not the skill this CLI writes.`);
    expect(kept.err).toContain("--force");
    expect(await readFile(skillPath, "utf8")).toBe("---\nname: catalyst\n---\nMy own notes.\n");

    // The person edited a skill setup wrote: that is a different file too.
    const edited = `${await renderCatalystSkill()}My addition.\n`;
    await writeFile(skillPath, edited);
    expect((await computer.setup(["claude-code", "--instance", SETUP_INSTANCE])).code).toBe(1);

    const forced = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE, "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain(`${skillPath}.bak`);
    expect(await readFile(`${skillPath}.bak`, "utf8")).toBe(edited);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
  });

  it("writes the skill of Codex and of another tool to ~/.agents/skills, and tells Other where it is", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const computer = await computerOf(t);
    const skillPath = join(computer.home, ".agents", "skills", "catalyst", "SKILL.md");

    const codex = await computer.setup(["codex", "--instance", SETUP_INSTANCE]);
    expect(codex.code).toBe(0);
    expect(codex.out).toContain(`Logged in with the key 'Codex on ${hostname()}'`);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());

    await rm(skillPath);
    const other = await computer.setup(["other", "--instance", SETUP_INSTANCE]);
    expect(other.code).toBe(0);
    expect(other.out).toContain(`Wrote the Catalyst skill to ${skillPath}.`);
    expect(other.out).toContain("Point your tool at that file");
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
  });

  it("logs in again where the saved key was revoked", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const computer = await computerOf(t);
    expect((await computer.setup(["codex", "--instance", SETUP_INSTANCE])).code).toBe(0);
    const keys = keysSchema.parse((await t.expectOk(t.kai.id, "me.api_keys.list")).json());
    await t.expectOk(t.kai.id, "me.api_keys.revoke", {
      params: { keyId: keys.items[0]?.id ?? "" }
    });

    const again = await computer.setup(["codex", "--instance", SETUP_INSTANCE]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Logged in with the key");
    expect(computer.opened).toHaveLength(2);
  });

  it("writes Claude Code's skill below CLAUDE_CONFIG_DIR where that is set", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const computer = await computerOf(t);
    const claudeHome = join(computer.home, "claude-elsewhere");
    const skillPath = join(claudeHome, "skills", "catalyst", "SKILL.md");

    const run = await computer.setup(["claude-code", "--instance", SETUP_INSTANCE], {
      CLAUDE_CONFIG_DIR: claudeHome
    });
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`Wrote the Catalyst skill to ${skillPath}.`);
    expect(await readFile(skillPath, "utf8")).toBe(await renderCatalystSkill());
    await expect(stat(join(computer.home, ".claude"))).rejects.toThrow(/ENOENT/u);
  });

  it("logs in again only where the instance refuses the saved key, not on any other answer", async () => {
    const t = await setupPersonalKeyInstance();
    await grantKaiWorkspace(t);
    const computer = await computerOf(t);
    expect((await computer.setup(["codex", "--instance", SETUP_INSTANCE])).code).toBe(0);
    const key = await savedKey(computer.env.CATALYST_CONFIG_HOME);

    // The instance limits the exchange of keys for a moment: the key is not the problem.
    const paths: string[] = [];
    const err: string[] = [];
    const code = await runCli(["setup", "codex", "--instance", SETUP_INSTANCE], {
      env: computer.env,
      fetchImpl: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        paths.push(new URL(request.url).pathname);
        return jsonResponse(429, { error: { code: "RATE_LIMITED", message: "Slow down." } });
      },
      openUrl: () => undefined,
      stdout: () => undefined,
      stderr: (text) => err.push(text)
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("HTTP 429");
    expect(paths).toEqual([testOperations["access_tokens.exchange"].path]);
    expect(await savedKey(computer.env.CATALYST_CONFIG_HOME)).toBe(key);
  });

  it("names the saved instances when a command names none and none or several are saved", async () => {
    const cwd = await createTemporaryDirectory();
    const configHome = await createTemporaryDirectory();
    const paths: string[] = [];
    const context = async () => {
      const err: string[] = [];
      const code = await runCli(["context", "--json"], {
        cwd,
        env: { CATALYST_CONFIG_HOME: configHome },
        fetchImpl: async (input) => {
          paths.push(String(input));
          return jsonResponse(500, {});
        },
        stdout: () => undefined,
        stderr: (text) => err.push(text)
      });
      return { code, err: err.join("") };
    };
    expect(await context()).toEqual({
      code: 1,
      err: "No instance selected; pass --instance or set defaultInstance in catalyst.yaml. No key is saved; 'catalyst login --instance <https-url>' saves one.\n"
    });
    await saveCredentialsFor(configHome, ["https://catalyst.test", "https://other.test"]);
    expect((await context()).err).toContain(
      "Keys are saved for https://catalyst.test, https://other.test."
    );
    expect(paths).toEqual([]);
  });

  it("refuses a tool it does not know and a run without the instance, before any call", async () => {
    const errors: string[] = [];
    const stderr = (text: string) => errors.push(text);
    expect(await runCli(["setup", "cursor", "--instance", SETUP_INSTANCE], { stderr })).toBe(2);
    expect(await runCli(["setup", "codex"], { stderr })).toBe(2);
    expect(await runCli(["login", "--force", "--instance", SETUP_INSTANCE], { stderr })).toBe(2);
    expect(errors.join("")).toContain(
      "Usage: catalyst setup <claude-code|codex|other> --instance <url> [--force]"
    );
  });
});
