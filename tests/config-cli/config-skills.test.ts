import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_FILENAME,
  canonicalBundleFiles,
  readManifest,
  readWorkingCopy,
  runConfigCommand,
  serializeSkillMarkdown,
  writeStateFile
} from "@work-shape/catalyst-cli";
import {
  createTemporaryDirectory,
  writeMinimalManifest,
  pulledBaseline,
  instanceHolding,
  skillConfig
} from "../support/config-cli";

describe("config CLI command flows", () => {
  it("round-trips text packages and reads other skill files as bytes", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const skillDirectory = resolve(directory, "skills", "review");
    await mkdir(resolve(skillDirectory, "references"), { recursive: true });
    await writeFile(
      resolve(skillDirectory, "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Review")),
      "utf8"
    );
    await writeFile(resolve(skillDirectory, "references", "checks.md"), "# Checks\n", "utf8");
    await writeFile(
      resolve(skillDirectory, "references", "schema.json"),
      '{"status":"ok"}\n',
      "utf8"
    );

    const local = await readWorkingCopy(directory, await readManifest(directory));
    expect(local.skills).toEqual([
      {
        ...skillConfig("review", "Review"),
        resources: [
          {
            path: "references/checks.md",
            mediaType: "text/markdown",
            content: "# Checks\n"
          },
          {
            path: "references/schema.json",
            mediaType: "application/json",
            content: '{"status":"ok"}\n'
          }
        ]
      }
    ]);
    expect(canonicalBundleFiles(local).get("skills/review/references/checks.md")).toBe(
      "# Checks\n"
    );

    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: { lastPulledVersion: 0, assets: {}, defaultAgentName: null } }
    });
    const pushed: unknown[] = [];
    const { fetchImpl } = await instanceHolding({ agents: [], skills: [] }, pushed);
    expect(
      await runConfigCommand("push", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_package" },
        fetchImpl
      })
    ).toBe(0);
    expect(pushed.at(-1)).toMatchObject({
      items: [{ type: "put", kind: "skill", config: local.skills[0] }]
    });

    await writeFile(resolve(skillDirectory, "references", "stale.md"), "stale", "utf8");
    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_package" },
        // The instance holds the package the push wrote.
        fetchImpl
      })
    ).toBe(0);
    await expect(
      readFile(resolve(skillDirectory, "references", "stale.md"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(resolve(skillDirectory, "references", "checks.md"), "utf8")).toBe(
      "# Checks\n"
    );

    await writeFile(resolve(skillDirectory, "references", "binary.pdf"), "%PDF", "utf8");
    const withPdf = await readWorkingCopy(directory, await readManifest(directory));
    expect(withPdf.skillFiles?.review).toContainEqual({
      path: "references/binary.pdf",
      text: "%PDF"
    });
    expect(withPdf.skills[0]?.resources?.map((resource) => resource.path)).not.toContain(
      "references/binary.pdf"
    );
  });

  it("clears all extra skill frontmatter across remove, push and pull", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const skill = { ...skillConfig("review", "Review"), frontmatter: { license: "MIT" } };
    const syncs: unknown[] = [];
    const { fetchImpl } = await instanceHolding({ agents: [], skills: [skill] }, syncs);
    const options = {
      cwd: directory,
      env: { CATALYST_API_KEY: "cat_frontmatter" },
      fetchImpl
    };
    expect(await runConfigCommand("pull", options)).toBe(0);
    await writeFile(
      resolve(directory, "skills/review/SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Review"))
    );
    expect(await runConfigCommand("push", options)).toBe(0);
    expect(syncs.at(-1)).toMatchObject({ items: [{ kind: "skill", config: { frontmatter: {} } }] });
    // Force a server read so local reuse cannot hide retained server frontmatter.
    await rm(resolve(directory, "skills/review/SKILL.md"));
    expect(await runConfigCommand("pull", options)).toBe(0);
    const local = await readWorkingCopy(directory, await readManifest(directory));
    expect(local.skills[0]?.frontmatter).toBeUndefined();
    expect(await runConfigCommand("diff", options)).toBe(0);
    const writes = syncs.length;
    expect(await runConfigCommand("push", options)).toBe(0);
    expect(syncs).toHaveLength(writes);
  });

  it("preserves the existing package and cleans temporary files when a package write fails", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const skillDirectory = resolve(directory, "skills", "review");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(resolve(skillDirectory, "SKILL.md"), "existing package\n", "utf8");
    const conflictingPackage = {
      ...skillConfig("review", "Replacement"),
      resources: [
        { path: "conflict.md", mediaType: "text/markdown", content: "file" },
        {
          path: "conflict.md/nested.txt",
          mediaType: "text/plain",
          content: "nested"
        }
      ]
    };
    const stderr: string[] = [];

    expect(
      await runConfigCommand("pull", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_package_failure" },
        fetchImpl: (await instanceHolding({ agents: [], skills: [conflictingPackage] })).fetchImpl,
        stderr: (text) => stderr.push(text)
      })
    ).toBe(1);
    expect(stderr.join("")).toBeTruthy();
    expect(await readFile(resolve(skillDirectory, "SKILL.md"), "utf8")).toBe("existing package\n");
    expect((await readdir(resolve(directory, "skills"))).sort()).toEqual(["review"]);
  });

  it("reports resource-only skill changes as updates in the push plan", async () => {
    const directory = await createTemporaryDirectory();
    await writeMinimalManifest(directory, "https://catalyst.test");
    const skillDirectory = resolve(directory, "skills", "review");
    await mkdir(resolve(skillDirectory, "references"), { recursive: true });
    await writeFile(
      resolve(skillDirectory, "SKILL.md"),
      serializeSkillMarkdown(skillConfig("review", "Same root")),
      "utf8"
    );
    await writeFile(resolve(skillDirectory, "references", "checks.md"), "local\n", "utf8");
    const remoteSkill = {
      ...skillConfig("review", "Same root"),
      resources: [
        {
          path: "references/checks.md",
          mediaType: "text/markdown",
          content: "remote\n"
        }
      ]
    };
    await writeStateFile(resolve(directory, STATE_FILENAME), {
      instances: { local: pulledBaseline(1, { agents: [], skills: [remoteSkill] }) }
    });
    const stdout: string[] = [];

    expect(
      await runConfigCommand("push", {
        cwd: directory,
        env: { CATALYST_API_KEY: "cat_resource_plan" },
        fetchImpl: (await instanceHolding({ agents: [], skills: [remoteSkill] })).fetchImpl,
        stdout: (text) => stdout.push(text)
      })
    ).toBe(0);
    expect(stdout.join("")).toContain("Updated: 1");
    expect(stdout.join("")).toContain("Unchanged: 0");
  });
});
