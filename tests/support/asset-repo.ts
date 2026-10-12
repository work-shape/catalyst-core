import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import {
  ASSET_REPO_BUNDLES_DIRECTORY,
  ASSET_REPO_FOLDER_DIRECTORY,
  ASSET_REPO_OUTPUT_DIRECTORY,
  ASSET_REPO_REQUEST_FILE,
  ASSET_REPO_RESULT_FILE,
  type CommitFolderResult,
  type MaterialiseResult
} from "@vivd-catalyst/asset-repo";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/asset-repo");
const run = promisify(execFile);

let command: Promise<string> | undefined;

/** The command, bundled from the sources as they are now and not from the last build. */
function assetRepoCommandFromSource(): Promise<string> {
  command ??= (async () => {
    const outfile = resolve(packageRoot, `.tmp/cli-${process.pid}.mjs`);
    await mkdir(dirname(outfile), { recursive: true });
    await build({
      entryPoints: [resolve(packageRoot, "src/cli.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent"
    });
    return outfile;
  })();
  return command;
}

/** One bundle of a repository under test, as a ledger would name it. */
export interface TestBundle {
  file: string;
  tip: string;
  prerequisite: string | null;
  bytes: Buffer;
  /** What the ledger recorded of the bundle, where that is not what `bytes` are. */
  recorded?: { sha256: string; bytes: number };
}

/** A bundle as a request names it: by what the ledger recorded, which is the file's own bytes
 * unless a test says the ledger recorded others. */
function named(bundle: TestBundle) {
  return {
    file: bundle.file,
    tip: bundle.tip,
    prerequisite: bundle.prerequisite,
    ...(bundle.recorded ?? {
      sha256: createHash("sha256").update(bundle.bytes).digest("hex"),
      bytes: bundle.bytes.byteLength
    })
  };
}

export interface TestCommit {
  result: CommitFolderResult;
  /** The bundle the command wrote, where it committed. */
  bundle?: TestBundle;
  /** The directory the command ran in. */
  directory: string;
}

/**
 * Runs `commit-folder` the way the worker does: a directory with the request, the bundles and
 * the folder, and `out/` read back. `prepare` writes whatever a test wants into the folder
 * beside `files`.
 */
export async function commitFolder(
  scratch: string,
  input: {
    files: Record<string, string | Uint8Array>;
    bundles?: readonly TestBundle[];
    base?: string | null;
    author?: string;
    time?: number;
    message?: string;
    prepare?(folder: string): Promise<void>;
    /** Replaces the list of bundles the request names. The files stay those of `bundles`. */
    named?: readonly TestBundle[];
  }
): Promise<TestCommit> {
  const directory = await mkdtemp(join(scratch, "commit-"));
  const folder = join(directory, ASSET_REPO_FOLDER_DIRECTORY);
  await mkdir(folder);
  await mkdir(join(directory, ASSET_REPO_OUTPUT_DIRECTORY));
  await mkdir(join(directory, ASSET_REPO_BUNDLES_DIRECTORY));
  for (const [path, content] of Object.entries(input.files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), content);
  }
  await input.prepare?.(folder);
  const bundles = input.bundles ?? [];
  for (const bundle of bundles) {
    await writeFile(join(directory, ASSET_REPO_BUNDLES_DIRECTORY, bundle.file), bundle.bytes);
  }
  await writeFile(
    join(directory, ASSET_REPO_REQUEST_FILE),
    JSON.stringify({
      bundles: (input.named ?? bundles).map(named),
      base: input.base ?? null,
      author: input.author ?? "user_7f3a",
      time: input.time ?? 1_760_270_400,
      message: input.message ?? "Revision"
    })
  );
  await run(process.execPath, [await assetRepoCommandFromSource(), "commit-folder", directory]);
  const result = await readResult<CommitFolderResult>(directory);
  if (result.status !== "committed") {
    return { result, directory };
  }
  return {
    result,
    directory,
    bundle: {
      file: result.bundle.file,
      tip: result.commit,
      prerequisite: result.bundle.prerequisite,
      bytes: await readFile(join(directory, ASSET_REPO_OUTPUT_DIRECTORY, result.bundle.file))
    }
  };
}

/** Runs `materialise` on the bundles and answers the result and where the repository is. */
export async function materialise(
  scratch: string,
  input: {
    bundles: readonly TestBundle[];
    draft: string;
    revisions: readonly { number: number; commit: string }[];
    /** Files that are not written although the request names them. */
    withhold?: readonly string[];
  }
): Promise<{ result: MaterialiseResult; directory: string }> {
  const directory = await mkdtemp(join(scratch, "materialise-"));
  await mkdir(join(directory, ASSET_REPO_OUTPUT_DIRECTORY));
  await mkdir(join(directory, ASSET_REPO_BUNDLES_DIRECTORY));
  for (const bundle of input.bundles) {
    if (!input.withhold?.includes(bundle.file)) {
      await writeFile(join(directory, ASSET_REPO_BUNDLES_DIRECTORY, bundle.file), bundle.bytes);
    }
  }
  await writeFile(
    join(directory, ASSET_REPO_REQUEST_FILE),
    JSON.stringify({
      bundles: input.bundles.map(named),
      draft: input.draft,
      revisions: input.revisions
    })
  );
  await run(process.execPath, [await assetRepoCommandFromSource(), "materialise", directory]);
  return { result: await readResult<MaterialiseResult>(directory), directory };
}

async function readResult<Result>(directory: string): Promise<Result> {
  const text = await readFile(
    join(directory, ASSET_REPO_OUTPUT_DIRECTORY, ASSET_REPO_RESULT_FILE),
    "utf8"
  );
  const parsed: Result = JSON.parse(text);
  return parsed;
}

/**
 * Git as a test uses it to look into a repository the command made, or to make a hostile one.
 * No configuration of the machine takes part.
 */
export async function testGit(
  repository: string,
  args: readonly string[],
  options: { input?: string | Uint8Array; env?: Record<string, string> } = {}
): Promise<string> {
  const child = run("git", [...args], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_DIR: repository,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@catalyst.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@catalyst.invalid",
      GIT_AUTHOR_DATE: "1760270400 +0000",
      GIT_COMMITTER_DATE: "1760270400 +0000",
      ...options.env
    }
  });
  if (options.input !== undefined) {
    child.child.stdin?.end(options.input);
  }
  return (await child).stdout.trim();
}

/** An executable file, such as a hook. */
export async function writeExecutable(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}
