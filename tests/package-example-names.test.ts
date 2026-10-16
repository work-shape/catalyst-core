import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const packages = fileURLToPath(new URL("../packages/", import.meta.url));
const denied = /exampledata|(?<![a-z])datev|exampletax|musterbau|(?<![a-z])extrade(?![a-z])/iu;

async function mentions(
  directory = "",
  root = packages,
  sharedFiles = new Set<string>()
): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(`${root}${directory}`, { withFileTypes: true })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) {
      if (!["dist", "node_modules", ".astro"].includes(entry.name)) {
        found.push(...(await mentions(`${path}/`, root, sharedFiles)));
      }
    } else if (
      entry.isFile() &&
      (sharedFiles.has(path) ||
        /\.(?:[cm]?[jt]sx?|mdx?|json|ya?ml|sh|html|css|svg|txt)$/u.test(path))
    ) {
      const lines = (await readFile(`${root}${path}`, "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        if (denied.test(line)) found.push(`packages/${path}:${index + 1}`);
      }
      if (denied.test(path)) found.push(`packages/${path}`);
    }
  }
  return found.sort();
}

it("keeps customer and accounting vendor names out of reusable packages and docs", async () => {
  expect(await mentions("", packages, await sharedKitFiles(packages))).toEqual([]);
});

it.each(["kit.js", "fonts/README.md", "fonts/inter/LICENSE"])(
  "finds a planted customer name in extensionless shared kit content for %s",
  async (file) => {
    const root = `${await mkdtemp(join(tmpdir(), "package-names-"))}/`;
    try {
      const shared = join(root, "server/vendor/app-kit-shared");
      const version = join(root, "server/vendor/app-kit/1.0.0");
      await mkdir(shared, { recursive: true });
      await mkdir(version, { recursive: true });
      const hash = "a".repeat(64);
      await writeFile(
        join(version, "manifest.json"),
        JSON.stringify({ files: [{ file, sha256: hash }] })
      );
      await writeFile(join(shared, hash), "// neutral\nconst customer = 'musterbau';\n");
      expect(await mentions("", root, await sharedKitFiles(root))).toEqual([
        `packages/server/vendor/app-kit-shared/${hash}:2`
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

async function sharedKitFiles(root: string): Promise<Set<string>> {
  const files = new Set<string>();
  const kit = join(root, "server/vendor/app-kit");
  const schema = z.object({ files: z.array(z.object({ file: z.string(), sha256: z.string() })) });
  for (const version of await readdir(kit)) {
    const manifest = schema.parse(
      JSON.parse(await readFile(join(kit, version, "manifest.json"), "utf8"))
    );
    for (const file of manifest.files) {
      files.add(`server/vendor/app-kit-shared/${file.sha256}`);
    }
  }
  return files;
}
