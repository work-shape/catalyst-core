import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_VERSION } from "@work-shape/catalyst-api-contract";
import { describe, expect, it } from "vitest";
import { commandNames, runCli } from "@work-shape/catalyst-cli";
import { createTemporaryDirectory } from "../support/config-cli";

describe("config CLI help", () => {
  it("documents the API key as the only sign-in", async () => {
    const stdout: string[] = [];
    expect(await runCli(["--help"], { stdout: (text) => stdout.push(text) })).toBe(0);
    const help = stdout.join("");
    expect(help).toContain("CATALYST_API_KEY");
    expect(help).not.toContain("SERVER_CREDENTIAL");
    expect(help).toContain("list");
    expect(help).toContain("show <agent|skill|guardrail> <name>");
    expect(help).toContain("--prune");
    expect(help).toContain("--only <agent:name|skill:name|guardrail:name>");
    expect(help).not.toContain("local-key");
  });

  it("prints its version with --version, and lists the flag in its help", async () => {
    const out: string[] = [];
    expect(await runCli(["--version"], { stdout: (text) => out.push(text) })).toBe(0);
    expect(out.join("")).toBe(`${RELEASE_VERSION}\n`);
    out.length = 0;
    await runCli(["--help"], { stdout: (text) => out.push(text) });
    expect(out.join("")).toContain("--version");
  });

  it("names where a key comes from, and where the local key command went", async () => {
    const cwd = await createTemporaryDirectory();
    await writeFile(
      join(cwd, "catalyst.yaml"),
      'instances:\n  local:\n    url: "http://127.0.0.1:4210"\ndefaultInstance: local\nagents: []\nskills: []\n'
    );
    const output: string[] = [];
    const stderr = (text: string) => output.push(text);

    expect(await runCli(["config", "pull", "--write-env", ".env"], { cwd, stderr })).toBe(2);
    expect(await runCli(["config", "pull"], { cwd, env: {}, stderr })).toBe(1);
    expect(output.join("")).toContain("Run 'catalyst login --instance http://127.0.0.1:4210'");
    expect(await runCli(["config", "local-key"], { cwd, env: {}, stderr })).toBe(2);
    expect(output.join("")).toContain("catalyst-local-key");
  });
});

describe("command group routing", () => {
  it.each([
    ["config", "pull", "--help"],
    ["login", "--help"],
    ["init", "--help"],
    ["knowledge-base", "source", "add", "--help"],
    ["workflow", "runs", "--help"],
    ["workflow", "--help"],
    ["connection", "test", "--help"],
    ["app", "pull", "--help"],
    ["future-kind", "list", "--help"]
  ])("prints offline help for %j", async (...argv) => {
    const out: string[] = [];
    const errors: string[] = [];
    const code = await runCli(argv, {
      stdout: (text) => out.push(text),
      stderr: (text) => errors.push(text),
      fetchImpl: () => {
        throw new Error("Help must not call an instance");
      }
    });
    expect({ code, errors }).toEqual({ code: 0, errors: [] });
    expect(out.join("")).not.toBe("");
  });

  it("lists registered commands in the combined help", async () => {
    const out: string[] = [];
    await runCli(["--help"], { stdout: (text) => out.push(text) });
    const help = out.join("");
    const names = commandNames();
    expect(names).toEqual(
      expect.arrayContaining([
        "config pull",
        "workflow runs",
        "<kind> publish",
        "connection secret set"
      ])
    );
    for (const name of names) {
      const words = name.split(" ");
      expect(help).toContain(words[0] === "config" ? words[1] : name);
    }
  });
});
