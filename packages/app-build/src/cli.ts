#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildPage } from "./bundle";
import { PAGE_BUILD_FILES_DIRECTORY, PAGE_BUILD_RESULT_FILE } from "./limits";
import type { PageBuildResultFile } from "./output";
import type { PageFile } from "./types";

// The command of the build: `catalyst-page-build <input directory> <output directory>`. It runs
// in the sandbox. It reads the files of the Page the worker wrote, builds them and writes the
// built files and `result.json`. It ends with 0 whenever it wrote a result, also one that
// lists errors of the Page, and with 1 when it could not.

/** Printed by `--version`, which the runner image calls when it is built. */
const PAGE_BUILD_CLI_VERSION = "1";

async function readInput(directory: string, prefix = ""): Promise<PageFile[]> {
  const files: PageFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await readInput(join(directory, entry.name), `${path}/`)));
    } else if (entry.isFile()) {
      files.push({ path, bytes: await readFile(join(directory, entry.name)) });
    }
  }
  return files;
}

async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (input === "--version") {
    process.stdout.write(`${PAGE_BUILD_CLI_VERSION}\n`);
    return;
  }
  if (!input || !output) {
    throw new Error("usage: catalyst-page-build <input directory> <output directory>");
  }
  const result = await buildPage({ files: await readInput(input) });
  let written: PageBuildResultFile;
  if (result.status === "built") {
    for (const file of result.files) {
      const target = join(output, PAGE_BUILD_FILES_DIRECTORY, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { flag: "wx" });
    }
    written = { status: "built", manifest: result.manifest };
  } else {
    written = { status: "errors", errors: result.errors };
  }
  await writeFile(join(output, PAGE_BUILD_RESULT_FILE), JSON.stringify(written), { flag: "wx" });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "The build failed"}\n`);
  process.exitCode = 1;
});
