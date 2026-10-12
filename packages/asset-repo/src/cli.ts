#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitFolder } from "./commit-folder";
import { createRepository, gitVersion, isSupportedGit, MINIMUM_GIT_VERSION } from "./git";
import {
  ASSET_REPO_BUNDLES_DIRECTORY,
  ASSET_REPO_FOLDER_DIRECTORY,
  ASSET_REPO_MAX_REQUEST_BYTES,
  ASSET_REPO_OUTPUT_DIRECTORY,
  ASSET_REPO_REPOSITORY_DIRECTORY,
  ASSET_REPO_REQUEST_FILE,
  ASSET_REPO_RESULT_FILE
} from "./limits";
import { applyBundles, Refused, writeLedgerRefs } from "./materialise";
import {
  parseCommitFolderRequest,
  parseMaterialiseRequest,
  RequestError,
  type AssetRepoRefusal,
  type CommitFolderResult,
  type MaterialiseResult
} from "./request";

// `catalyst-asset-repo commit-folder <directory>` and `catalyst-asset-repo materialise
// <directory>`. It runs in the sandbox. The directory holds `request.json`, `bundles/` and,
// for a commit, `folder/`; the command writes `out/`. It ends with 0 whenever it wrote a
// result, also one that refuses, and with 1 when it could not.

/** Printed by `--version`, which the runner image calls when it is built. */
const ASSET_REPO_CLI_VERSION = "1";

async function readRequest(directory: string): Promise<unknown> {
  const path = join(directory, ASSET_REPO_REQUEST_FILE);
  if ((await stat(path)).size > ASSET_REPO_MAX_REQUEST_BYTES) {
    throw new RequestError("The request is larger than a request may be");
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return parsed;
}

/** Runs one sub-command in a scratch directory of its own, which is removed after it. */
async function withScratch<Result>(run: (scratch: string) => Promise<Result>): Promise<Result> {
  const scratch = await mkdtemp(join(tmpdir(), "catalyst-asset-repo-"));
  try {
    return await run(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runCommitFolder(directory: string): Promise<CommitFolderResult> {
  const request = parseCommitFolderRequest(await readRequest(directory));
  return withScratch(async (scratch) =>
    commitFolder({
      repository: await createRepository(join(scratch, "repo.git"), scratch),
      request,
      folder: join(directory, ASSET_REPO_FOLDER_DIRECTORY),
      bundles: join(directory, ASSET_REPO_BUNDLES_DIRECTORY),
      output: join(directory, ASSET_REPO_OUTPUT_DIRECTORY),
      scratch
    })
  );
}

async function runMaterialise(directory: string): Promise<MaterialiseResult> {
  const request = parseMaterialiseRequest(await readRequest(directory));
  const output = join(directory, ASSET_REPO_OUTPUT_DIRECTORY);
  const target = join(output, ASSET_REPO_REPOSITORY_DIRECTORY);
  // The repository is made here, new. Whatever is at its place already, a repository with
  // objects, alternates or refs of its own or a link to somewhere else, is not written into.
  if (
    !(await lstat(output).catch(() => undefined))?.isDirectory() ||
    (await lstat(target).catch(() => undefined))
  ) {
    throw new Refused(
      "output_exists",
      `'${ASSET_REPO_OUTPUT_DIRECTORY}' is not a directory or holds '${ASSET_REPO_REPOSITORY_DIRECTORY}' already`,
      ASSET_REPO_REPOSITORY_DIRECTORY
    );
  }
  return withScratch(async (scratch) => {
    const repository = await createRepository(target, scratch);
    await applyBundles(
      repository,
      join(directory, ASSET_REPO_BUNDLES_DIRECTORY),
      request.bundles,
      scratch
    );
    await writeLedgerRefs(repository, request);
    const commits = await repository.git(["rev-list", "--count", "--all"]);
    return {
      status: "materialised",
      draft: request.draft,
      revisions: request.revisions.length,
      commits: Number(commits.trim())
    };
  });
}

/**
 * Commits a folder and reads the commit back from its bundle, so the image that carries this
 * command is known to carry a git that does both.
 */
async function check(): Promise<void> {
  const version = await gitVersion();
  if (!version || !isSupportedGit(version)) {
    throw new Error(
      `catalyst-asset-repo needs git ${MINIMUM_GIT_VERSION.join(".")} or later on its path and found ${version ? version.join(".") : "none"}`
    );
  }
  await withScratch(async (scratch) => {
    const directory = join(scratch, "check");
    const folder = join(directory, ASSET_REPO_FOLDER_DIRECTORY);
    const output = join(directory, ASSET_REPO_OUTPUT_DIRECTORY);
    await mkdir(folder, { recursive: true });
    await mkdir(output);
    await writeFile(join(folder, "file.txt"), "check\n");
    const committed = await commitFolder({
      repository: await createRepository(join(scratch, "first.git"), join(scratch, "first")),
      request: { bundles: [], base: null, author: "check", time: 0, message: "check" },
      folder,
      bundles: join(directory, ASSET_REPO_BUNDLES_DIRECTORY),
      output,
      scratch: join(scratch, "first")
    });
    if (committed.status !== "committed") {
      throw new Error("The check folder was not committed");
    }
    const second = await createRepository(join(scratch, "second.git"), join(scratch, "second"));
    await applyBundles(
      second,
      output,
      [
        {
          file: committed.bundle.file,
          tip: committed.commit,
          prerequisite: null,
          sha256: committed.bundle.sha256,
          bytes: committed.bundle.bytes
        }
      ],
      join(scratch, "second")
    );
    await writeLedgerRefs(second, {
      draft: committed.commit,
      revisions: [{ number: 1, commit: committed.commit }]
    });
  });
  process.stdout.write(
    `catalyst-asset-repo commits and materialises with git ${version.join(".")}\n`
  );
}

async function main(): Promise<void> {
  const [command, target] = process.argv.slice(2);
  if (command === "--version") {
    process.stdout.write(`${ASSET_REPO_CLI_VERSION}\n`);
    return;
  }
  if (command === "--check") {
    await check();
    return;
  }
  if ((command !== "commit-folder" && command !== "materialise") || !target) {
    throw new Error("usage: catalyst-asset-repo commit-folder|materialise <directory>");
  }
  const directory = resolve(target);
  let result: CommitFolderResult | MaterialiseResult;
  try {
    result = await (command === "commit-folder"
      ? runCommitFolder(directory)
      : runMaterialise(directory));
  } catch (error) {
    if (!(error instanceof Refused) && !(error instanceof RequestError)) {
      throw error;
    }
    const refusal: AssetRepoRefusal =
      error instanceof Refused
        ? error.refusal
        : { status: "refused", code: "request_invalid", message: error.message };
    result = refusal;
  }
  await writeFile(
    join(directory, ASSET_REPO_OUTPUT_DIRECTORY, ASSET_REPO_RESULT_FILE),
    JSON.stringify(result),
    { flag: "wx" }
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "The command failed"}\n`);
  process.exitCode = 1;
});
