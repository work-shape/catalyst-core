import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { composeE2eConfig, e2eFixturePath } from "../scripts/e2e-config.mjs";

const configSchema = z.object({
  auth: z.object({
    standalone: z.object({ seedUsers: z.array(z.looseObject({ email: z.string() })) })
  })
});

function seedUsers(text: string) {
  return configSchema.parse(parse(text)).auth.standalone.seedUsers;
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function usersDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "e2e-users-"));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text);
  return directory;
}

const person = (email: string) => `- email: ${email}\n  displayLabel: E2E Zz ${email}\n`;

describe("the browser suite's composed config", () => {
  it("holds the fixture's own people and every spec's people, each once", async () => {
    const own = seedUsers(await readFile(e2eFixturePath, "utf8"));
    const composed = seedUsers(composeE2eConfig());

    expect(composed.slice(0, own.length)).toEqual(own);
    expect(composed.length).toBeGreaterThan(own.length);
    expect(new Set(composed.map((user) => user.email)).size).toBe(composed.length);
  });

  it("adds the spec files in file name order", async () => {
    const directory = await usersDirectory({
      "b.yaml": person("b@example.test"),
      "a.yaml": `# a comment that stays\n${person("a@example.test")}`
    });

    const text = composeE2eConfig({ usersDirectory: directory });

    expect(
      seedUsers(text)
        .slice(-2)
        .map((user) => user.email)
    ).toEqual(["a@example.test", "b@example.test"]);
    expect(text).toContain("      # a comment that stays");
  });

  it("refuses a person listed twice", async () => {
    const directory = await usersDirectory({
      "a.yaml": person("twice@example.test"),
      "b.yaml": person("Twice@example.test")
    });

    expect(() => composeE2eConfig({ usersDirectory: directory })).toThrow(
      "seed user twice@example.test is listed twice"
    );
  });

  it("refuses a spec file that holds no list of people", async () => {
    const directory = await usersDirectory({ "a.yaml": "email: a@example.test\n" });

    expect(() => composeE2eConfig({ usersDirectory: directory })).toThrow(
      "e2e-users/a.yaml must be a list of seed users"
    );
  });
});
