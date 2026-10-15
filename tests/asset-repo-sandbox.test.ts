import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxAssetRepo, type AssetRepoCommitOutcome } from "@work-shape/catalyst-server";
import { ASSET_REPO_MAX_TREE_BYTES } from "@work-shape/catalyst-asset-repo";
import {
  DockerWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";
import { assetRepoCommandFromSource } from "./support/asset-repo";

// A commit to the repository of an asset is made by a command in the sandbox, and what the
// command left behind is read back as data nobody trusts. The sandbox here is the local one,
// which runs the command as a process with the git of this machine: what is under test is the
// handover in both directions, not the container.

let scratch: string;
let tempRoot: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "asset-repo-sandbox-test-"));
  tempRoot = join(scratch, "commits");
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const files = (contents: Record<string, string>) =>
  Object.entries(contents).map(([path, text]) => ({ path, bytes: encoder.encode(text) }));
const signal = () => new AbortController().signal;
const request = (base: string | null, time = 1_760_000_000) => ({
  base,
  author: "usr_author",
  time,
  message: "Save rates"
});
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const MIB = 1024 * 1024;
/** `count` files of `bytes` random bytes each: nothing of them compresses. */
const incompressible = (count: number, bytes: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `data/${String(index).padStart(3, "0")}.bin`,
    bytes: new Uint8Array(randomBytes(bytes))
  }));

function committed(outcome: AssetRepoCommitOutcome) {
  if (outcome.status !== "committed") {
    throw new Error(`Not committed: ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

async function local(command?: string) {
  return createSandboxAssetRepo({
    sandbox: new LocalWorkspaceCommandProcessExecutor(),
    tempRoot,
    command: command ?? `'${process.execPath}' '${await assetRepoCommandFromSource()}'`
  });
}

/** A command that writes `result` and whatever `prepare` does, in place of the real one. */
async function fake(name: string, body: string): Promise<string> {
  const script = join(scratch, `${name}.mjs`);
  await writeFile(script, body);
  return `'${process.execPath}' '${script}'`;
}

const commit = "a".repeat(40);
const claimed = (bundle: { sha256: string; bytes: number }) =>
  JSON.stringify({
    status: "committed",
    commit,
    tree: "b".repeat(40),
    parent: null,
    files: 1,
    bundle: { file: `${commit}.bundle`, kind: "full", prerequisite: null, ...bundle }
  });

describe("a commit to an asset's repository in the sandbox", () => {
  it("refuses a tree over the cap by name before the sandbox starts", async () => {
    let started = 0;
    const sandbox: WorkspaceCommandProcessExecutor = {
      execute() {
        started += 1;
        throw new Error("The sandbox was started");
      }
    };
    const run = createSandboxAssetRepo({ sandbox, tempRoot });

    const outcome = await run({
      id: "over-cap",
      request: request(null),
      files: incompressible(ASSET_REPO_MAX_TREE_BYTES / MIB + 1, MIB),
      bundles: [],
      signal: signal()
    });

    expect(outcome).toMatchObject({
      status: "refused",
      code: "tree_too_large",
      message: expect.stringContaining("The files are larger than 50 MiB together")
    });
    expect(started).toBe(0);
  });

  it("answers a command that ran out of disk as a refusal an operator can act on", async () => {
    const full = await fake(
      "full",
      `process.stderr.write("catalyst-asset-repo: no space\\n"); process.exit(1);`
    );
    expect(
      await (
        await local(full)
      )({
        id: "full",
        request: request(null),
        files: files({ "a.txt": "a" }),
        bundles: [],
        signal: signal()
      })
    ).toMatchObject({
      status: "refused",
      code: "no_space",
      message: expect.stringContaining("too little free disk space for this save")
    });
  });

  it("writes the folder in, runs the command and reads the commit and its bundle back", async () => {
    const run = await local();
    const first = committed(
      await run({
        id: "first",
        request: request(null),
        files: files({ "app.yaml": "name: rates\n", "src/index.html": "<p>1</p>" }),
        bundles: [],
        signal: signal()
      })
    );
    expect(first).toMatchObject({ files: 2, bundle: { kind: "full", prerequisite: null } });
    expect(first.bundle.sha256).toBe(sha256(first.bundle.bytes));
    // The same files, author and time give the same commit: a save that is tried again.
    const again = committed(
      await run({
        id: "again",
        request: request(null),
        files: files({ "src/index.html": "<p>1</p>", "app.yaml": "name: rates\n" }),
        bundles: [],
        signal: signal()
      })
    );
    expect(again.commit).toBe(first.commit);
    expect(again.bundle.sha256).toBe(first.bundle.sha256);

    const second = committed(
      await run({
        id: "second",
        request: request(first.commit, 1_760_000_100),
        files: files({ "app.yaml": "name: rates\n", "src/index.html": "<p>2</p>" }),
        bundles: [
          {
            tip: first.commit,
            prerequisite: null,
            sha256: first.bundle.sha256,
            bytes: first.bundle.bytes
          }
        ],
        signal: signal()
      })
    );
    expect(second.commit).not.toBe(first.commit);
    expect(second.bundle).toMatchObject({ kind: "incremental", prerequisite: first.commit });
    // Nothing of a commit stays behind.
    expect(await readdir(tempRoot)).toEqual([]);
  }, 60_000);

  it("gives the command's refusal with the path", async () => {
    const run = await local();
    const first = committed(
      await run({
        id: "base",
        request: request(null),
        files: files({ "a.txt": "a" }),
        bundles: [],
        signal: signal()
      })
    );
    // The bundle is not the bytes the request names: the command reads none of it.
    const other = new Uint8Array(first.bundle.bytes);
    other[other.byteLength - 1] = (other[other.byteLength - 1] ?? 0) ^ 1;
    expect(
      await run({
        id: "other-bytes",
        request: request(first.commit),
        files: files({ "a.txt": "b" }),
        bundles: [
          { tip: first.commit, prerequisite: null, sha256: first.bundle.sha256, bytes: other }
        ],
        signal: signal()
      })
    ).toMatchObject({ status: "refused", code: "bundle_hash_mismatch" });
  }, 60_000);

  it("refuses a path a repository does not take before it writes anything", async () => {
    let started = 0;
    const sandbox = new LocalWorkspaceCommandProcessExecutor();
    const run = createSandboxAssetRepo({
      sandbox: {
        execute: (input) => {
          started += 1;
          return sandbox.execute(input);
        }
      },
      tempRoot,
      command: "true"
    });
    for (const path of ["../outside.txt", ".git/config", "a/.GIT/hooks/pre-commit", "/etc/x"]) {
      expect(
        await run({
          id: "refused",
          request: request(null),
          files: files({ [path]: "x" }),
          bundles: [],
          signal: signal()
        })
      ).toMatchObject({ status: "refused", code: "path_refused", path });
    }
    expect(
      await run({
        id: "collision",
        request: request(null),
        files: files({ "Readme.md": "x", "README.md": "y" }),
        bundles: [],
        signal: signal()
      })
    ).toMatchObject({ status: "refused", code: "case_collision" });
    expect(started).toBe(0);
    expect(await readdir(tempRoot).catch(() => [])).toEqual([]);
  });

  it("says that the runner image is too old when the command is not there", async () => {
    const run = await local("catalyst-asset-repo-of-a-later-release");
    const outcome = await run({
      id: "absent",
      request: request(null),
      files: files({ "a.txt": "a" }),
      bundles: [],
      signal: signal()
    });
    expect(outcome).toMatchObject({ status: "failed", reason: "command_missing" });
    expect(outcome.status === "failed" ? outcome.message : "").toContain(
      "The runner image of this instance has no 'catalyst-asset-repo'"
    );
  });

  // Fails where the worker believes the result: each of these would hand it bytes the command
  // did not make, or a commit on another base.
  it("believes no result that its files do not bear out", async () => {
    const bytes = encoder.encode("bytes");
    const write = (result: string, more = "") => `
      import { symlinkSync, writeFileSync } from "node:fs";
      ${more}
      writeFileSync("out/result.json", ${JSON.stringify(result)});`;
    const cases: Record<string, string> = {
      "other-hash": write(
        claimed({ sha256: "c".repeat(64), bytes: bytes.byteLength }),
        `writeFileSync("out/${commit}.bundle", "bytes");`
      ),
      "other-size": write(
        claimed({ sha256: sha256(bytes), bytes: 4 }),
        `writeFileSync("out/${commit}.bundle", "bytes");`
      ),
      link: write(
        claimed({ sha256: sha256(bytes), bytes: bytes.byteLength }),
        `writeFileSync("elsewhere", "bytes"); symlinkSync("../elsewhere", "out/${commit}.bundle");`
      ),
      "no-bundle": write(claimed({ sha256: sha256(bytes), bytes: bytes.byteLength })),
      "other-base": write(
        claimed({ sha256: sha256(bytes), bytes: bytes.byteLength }).replace(
          '"parent":null',
          `"parent":"${"d".repeat(40)}"`
        ),
        `writeFileSync("out/${commit}.bundle", "bytes");`
      ),
      "other-file": write(
        claimed({ sha256: sha256(bytes), bytes: bytes.byteLength }).replace(
          `${commit}.bundle`,
          "../request.json"
        )
      ),
      "not-json": write("committed"),
      "no-result": "",
      "result-link": `
        import { symlinkSync, writeFileSync } from "node:fs";
        writeFileSync("elsewhere.json", ${JSON.stringify(claimed({ sha256: sha256(bytes), bytes: 5 }))});
        symlinkSync("../elsewhere.json", "out/result.json");`
    };
    for (const [name, body] of Object.entries(cases)) {
      const run = await local(await fake(name, body));
      const outcome = await run({
        id: name,
        request: request(null),
        files: files({ "a.txt": "a" }),
        bundles: [],
        signal: signal()
      });
      expect({ name, outcome }).toMatchObject({
        name,
        outcome: { status: "failed", reason: "crashed" }
      });
    }
    // And the same command with a bundle that is what it says is believed.
    const honest = await local(
      await fake(
        "honest",
        write(
          claimed({ sha256: sha256(bytes), bytes: bytes.byteLength }),
          `writeFileSync("out/${commit}.bundle", "bytes");`
        )
      )
    );
    expect(
      await honest({
        id: "honest",
        request: request(null),
        files: files({ "a.txt": "a" }),
        bundles: [],
        signal: signal()
      })
    ).toMatchObject({ status: "committed", commit });
  }, 60_000);
});

// The same handover with the container sandbox and the runner image of a release. It needs a
// Docker engine and a built image, so it runs only where one is named:
// CATALYST_PAGE_BUILD_RUNNER_IMAGE=<image> pnpm exec vitest run tests/asset-repo-sandbox.test.ts
const runnerImage = process.env.CATALYST_PAGE_BUILD_RUNNER_IMAGE;

describe.skipIf(!runnerImage)("a commit to an asset's repository in the runner image", () => {
  const container = (command?: string) =>
    createSandboxAssetRepo({
      sandbox: new DockerWorkspaceCommandProcessExecutor({
        image: runnerImage ?? "",
        networkMode: "none",
        readOnlyRootFilesystem: true,
        cpuCount: 1,
        memoryBytes: 1024 * 1024 * 1024,
        pidsLimit: 128
      }),
      tempRoot,
      ...(command ? { command } : {})
    });

  it("commits a folder with the command and the git the image carries", async () => {
    const run = container();
    const first = committed(
      await run({
        id: "container-first",
        request: request(null),
        files: files({ "app.yaml": "name: rates\n", "src/index.html": "<p>1</p>" }),
        bundles: [],
        signal: signal()
      })
    );
    const second = committed(
      await run({
        id: "container-second",
        request: request(first.commit, 1_760_000_100),
        files: files({ "app.yaml": "name: rates\n", "src/index.html": "<p>2</p>" }),
        bundles: [
          {
            tip: first.commit,
            prerequisite: null,
            sha256: first.bundle.sha256,
            bytes: first.bundle.bytes
          }
        ],
        signal: signal()
      })
    );
    expect(second.bundle).toMatchObject({ kind: "incremental", prerequisite: first.commit });
    // The commit of the image is the commit of this machine's git for the same files.
    const here = committed(
      await (
        await local()
      )({
        id: "here",
        request: request(null),
        files: files({ "app.yaml": "name: rates\n", "src/index.html": "<p>1</p>" }),
        bundles: [],
        signal: signal()
      })
    );
    expect(here.commit).toBe(first.commit);
  }, 120_000);

  // A Page at its cap (25 MiB) and an App at the cap of a repository's tree (50 MiB), of bytes
  // that do not compress: the repository, the copies and the bundle of each are larger than
  // the 64 MiB `/tmp` of the sandbox, and the container has 1 GiB of memory.
  it.each([
    { name: "a Page at its cap", count: 25, bytes: MIB },
    { name: "a tree at the cap of a repository", count: 25, bytes: 2 * MIB }
  ])(
    "commits $name of incompressible bytes, and a second save on top of it",
    async ({ count, bytes }) => {
      const run = container();
      const tree = incompressible(count, bytes);
      const first = committed(
        await run({
          id: `cap-first-${count * bytes}`,
          request: request(null),
          files: tree,
          bundles: [],
          signal: signal()
        })
      );
      expect(first.files).toBe(count);
      expect(first.bundle.bytes.byteLength).toBeGreaterThan(count * bytes);

      // The second save reads the whole history and changes one file.
      const [changed, ...rest] = tree;
      const second = committed(
        await run({
          id: `cap-second-${count * bytes}`,
          request: request(first.commit, 1_760_000_100),
          files: [
            { path: changed?.path ?? "", bytes: new Uint8Array(randomBytes(bytes)) },
            ...rest
          ],
          bundles: [
            {
              tip: first.commit,
              prerequisite: null,
              sha256: first.bundle.sha256,
              bytes: first.bundle.bytes
            }
          ],
          signal: signal()
        })
      );
      expect(second.bundle).toMatchObject({ kind: "incremental", prerequisite: first.commit });
      expect(second.bundle.bytes.byteLength).toBeGreaterThan(bytes);
      expect(second.bundle.bytes.byteLength).toBeLessThan(2 * bytes);
    },
    300_000
  );

  it("names the runner image when it has no such command", async () => {
    expect(
      await container("catalyst-asset-repo-of-a-later-release")({
        id: "container-absent",
        request: request(null),
        files: files({ "a.txt": "a" }),
        bundles: [],
        signal: signal()
      })
    ).toMatchObject({ status: "failed", reason: "command_missing" });
  }, 120_000);
});
