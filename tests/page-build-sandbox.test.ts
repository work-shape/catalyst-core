import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PAGE_BUILD_MAX_OUTPUT_DEPTH,
  PAGE_BUILD_MAX_OUTPUT_ENTRIES,
  PAGE_BUILD_MAX_RESULT_BYTES,
  readPageBuildOutput,
  type PageBuildOutcome
} from "@work-shape/catalyst-app-build";
import { createSandboxPageBuild, removeStalePageBuilds } from "@work-shape/catalyst-server";
import {
  DockerWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";
import {
  fileRoute,
  htmlManifest,
  pageBuildCommandFromSource,
  pageFiles,
  reactManifest,
  rootRoute
} from "./support/page-build";

// A Page is built by a command in the sandbox, and what the command left behind is read back
// as data nobody trusts. The sandbox here is the local one, which runs the command as a
// process: what is under test is the handover in both directions, not the container.

let scratch: string;
let tempRoot: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "page-build-sandbox-test-"));
  tempRoot = join(scratch, "builds");
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const decoder = new TextDecoder();
const failure = (outcome: PageBuildOutcome) =>
  outcome.status === "failed" ? { reason: outcome.reason, message: outcome.message } : outcome;

async function sandboxBuild(command?: string) {
  return createSandboxPageBuild({
    sandbox: new LocalWorkspaceCommandProcessExecutor(),
    tempRoot,
    command: command ?? (await pageBuildCommandFromSource())
  });
}

describe("a Page build in the sandbox", () => {
  const htmlPage = pageFiles({
    "app.yaml": htmlManifest,
    "index.html": `<!doctype html><style>p { color: teal; }</style><p>x</p>`
  });

  it("writes the files in, runs the command and reads the built files back", async () => {
    const build = await sandboxBuild();
    const outcome = await build({
      id: "one",
      signal: new AbortController().signal,
      files: pageFiles({
        "app.yaml": reactManifest,
        "src/routes/__root.tsx": rootRoute,
        "src/routes/index.tsx": fileRoute("/"),
        "src/routes/history.tsx": fileRoute("/history")
      })
    });

    if (outcome.status !== "built") {
      throw new Error(`The Page did not build: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.kitVersion).toBe("1.0.0");
    expect(outcome.manifest).toMatchObject({
      id: "demo-page",
      entry: "index.html",
      pages: [{ path: "/" }, { path: "/history" }]
    });
    const files = new Map(outcome.files.map((file) => [file.path, decoder.decode(file.bytes)]));
    expect([...files.keys()].sort()).toEqual(["app.js", "index.html"]);
    expect(files.get("app.js")).toContain("/app-runtime/kit/1.0.0/router.js");
    // The directory of the build is gone.
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("returns the errors of the Page, with file and line", async () => {
    const build = await sandboxBuild();
    const outcome = await build({
      id: "two",
      signal: new AbortController().signal,
      files: pageFiles({
        "app.yaml": reactManifest,
        "src/routes/__root.tsx": rootRoute,
        "src/routes/index.tsx": "export const Route = (;\n"
      })
    });

    expect(outcome).toEqual({
      status: "errors",
      errors: [expect.objectContaining({ file: "src/routes/index.tsx", line: 1, code: "syntax" })]
    });
  });

  // Ran the file before the refusal matched the generator's own pattern: the marker existed.
  it("refuses a file the route generator would execute, in a nested folder, and does not run it", async () => {
    const marker = join(scratch, "marker-virtual");
    const build = await sandboxBuild();
    const outcome = await build({
      id: "three",
      signal: new AbortController().signal,
      files: pageFiles({
        "app.yaml": reactManifest,
        "src/routes/__root.tsx": rootRoute,
        "src/routes/index.tsx": fileRoute("/"),
        "src/routes/sub/a__virtual.js": `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nmodule.exports = [];\n`
      })
    });

    expect(outcome).toEqual({
      status: "errors",
      errors: [
        expect.objectContaining({ file: "src/routes/sub/a__virtual.js", code: "routes_invalid" })
      ]
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a file whose path would leave the build's directory, before anything runs", async () => {
    const build = await sandboxBuild("touch ran #");
    const outcome = await build({
      id: "four",
      signal: new AbortController().signal,
      files: [...htmlPage, ...pageFiles({ "../outside.txt": "x" })]
    });

    expect(outcome).toEqual({
      status: "errors",
      errors: [expect.objectContaining({ file: "../outside.txt", code: "file_invalid" })]
    });
    expect(await readdir(scratch)).not.toContain("outside.txt");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("ends a build at its time limit and removes its directory", async () => {
    const build = await sandboxBuild("sleep 30 #");
    const outcome = await build({
      id: "five",
      signal: new AbortController().signal,
      files: htmlPage,
      limits: { timeoutMs: 1000 }
    });

    expect(failure(outcome)).toEqual({
      reason: "timeout",
      message: expect.stringContaining("did not finish within 1 seconds")
    });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("says that the runner image is too old when the command is not there", async () => {
    const build = await sandboxBuild("catalyst-page-build-of-no-image");

    expect(
      failure(await build({ id: "six", signal: new AbortController().signal, files: htmlPage }))
    ).toEqual({
      reason: "command_missing",
      message: expect.stringContaining(
        "The runner image of this instance has no 'catalyst-page-build'"
      )
    });
  });

  it("reports a build that ended without a result, and one that was stopped", async () => {
    const crashed = await sandboxBuild("exit 3 #");
    expect(
      failure(await crashed({ id: "seven", signal: new AbortController().signal, files: htmlPage }))
    ).toEqual({ reason: "crashed", message: "The build ended without a result." });

    const silent = await sandboxBuild("true #");
    expect(
      failure(await silent({ id: "eight", signal: new AbortController().signal, files: htmlPage }))
    ).toMatchObject({ reason: "output_refused" });

    const stopping = new AbortController();
    const slow = await sandboxBuild("sleep 30 #");
    const pending = slow({ id: "nine", signal: stopping.signal, files: htmlPage });
    setTimeout(() => stopping.abort(), 200);
    expect(failure(await pending)).toMatchObject({ reason: "stopped" });
  });
});

describe("what a killed worker left of its builds", () => {
  it("is removed when it is older than any running build, and nothing else is", async () => {
    const root = join(scratch, "sweep");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const stale = join(root, "catalyst-page-build-stale");
    const running = join(root, "catalyst-page-build-running");
    const fresh = join(root, "catalyst-page-build-fresh");
    const other = join(root, "catalyst-workspace-other");
    for (const directory of [stale, running, fresh, other]) {
      await mkdir(join(directory, "build/out"), { recursive: true });
      await writeFile(join(directory, "build/out/result.json"), "{}");
    }
    for (const directory of [stale, running, other]) {
      await utimes(directory, old, old);
    }
    const asked: { idPrefix: string; olderThanMs: number }[] = [];
    const sandbox = Object.assign(new LocalWorkspaceCommandProcessExecutor(), {
      removeLeftovers: async (input: { idPrefix: string; olderThanMs: number }) => {
        asked.push(input);
        return 2;
      }
    });

    const removed = await removeStalePageBuilds({
      sandbox,
      tempRoot: root,
      active: new Set([running])
    });

    expect(removed).toEqual({ directories: 1, containers: 2 });
    expect((await readdir(root)).sort()).toEqual([
      "catalyst-page-build-fresh",
      "catalyst-page-build-running",
      "catalyst-workspace-other"
    ]);
    // The containers of builds are asked for by the prefix of their command's id.
    expect(asked).toEqual([{ idPrefix: "page-build-", olderThanMs: 15 * 60 * 1000 }]);
  });

  it("is removed by the first build of a worker", async () => {
    const root = join(scratch, "sweep-on-build");
    const stale = join(root, "catalyst-page-build-left");
    await mkdir(stale, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(stale, old, old);
    const build = createSandboxPageBuild({
      sandbox: new LocalWorkspaceCommandProcessExecutor(),
      tempRoot: root,
      command: "true #"
    });

    await build({
      id: "sweeps",
      signal: new AbortController().signal,
      files: pageFiles({ "app.yaml": htmlManifest, "index.html": "<!doctype html><p>x</p>" })
    });

    await expect.poll(() => readdir(root)).toEqual([]);
  });
});

describe("what a build left in its output directory", () => {
  const result = JSON.stringify({
    status: "built",
    manifest: { id: "demo-page", name: "Demo Page", kit: "1.0.0", entry: "index.html" }
  });
  let counter = 0;

  /** An output directory with a valid result and one built file, to be spoiled by a test. */
  async function output(): Promise<{ out: string; files: string }> {
    counter += 1;
    const out = join(scratch, `out-${counter}`);
    const files = join(out, "files");
    await mkdir(files, { recursive: true });
    await writeFile(join(out, "result.json"), result);
    await writeFile(join(files, "index.html"), "<p>built</p>");
    return { out, files };
  }

  it("is read when it is what a build writes", async () => {
    const { out, files } = await output();
    await mkdir(join(files, "assets"));
    await writeFile(join(files, "assets/app.js"), "export {};");

    const outcome = await readPageBuildOutput(out);

    expect(outcome).toMatchObject({ status: "built", kitVersion: "1.0.0" });
    expect(outcome.status === "built" ? outcome.files.map((file) => file.path).sort() : []).toEqual(
      ["assets/app.js", "index.html"]
    );
  });

  it("is refused when a built file is a symbolic link, and the target is not read", async () => {
    const secret = join(scratch, "secret.txt");
    await writeFile(secret, "a secret of the worker");
    const { out, files } = await output();
    await symlink(secret, join(files, "leak.txt"));

    expect(failure(await readPageBuildOutput(out))).toEqual({
      reason: "output_refused",
      message: "'leak.txt' in the build's output is not a regular file."
    });

    const entry = await output();
    await rm(join(entry.files, "index.html"));
    await symlink(secret, join(entry.files, "index.html"));
    expect(failure(await readPageBuildOutput(entry.out))).toMatchObject({
      reason: "output_refused"
    });
  });

  it("is refused when a folder of built files or the result is a symbolic link", async () => {
    const elsewhere = join(scratch, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "passwd"), "root");
    const folder = await output();
    await symlink(elsewhere, join(folder.files, "assets"));
    expect(failure(await readPageBuildOutput(folder.out))).toMatchObject({
      reason: "output_refused",
      message: "'assets' in the build's output is not a regular file."
    });

    const whole = await output();
    await rm(whole.files, { recursive: true });
    await symlink(elsewhere, whole.files);
    expect(failure(await readPageBuildOutput(whole.out))).toMatchObject({
      reason: "output_refused"
    });

    const linked = await output();
    await rm(join(linked.out, "result.json"));
    await writeFile(join(scratch, "result-elsewhere.json"), result);
    await symlink(join(scratch, "result-elsewhere.json"), join(linked.out, "result.json"));
    expect(failure(await readPageBuildOutput(linked.out))).toMatchObject({
      reason: "output_refused",
      message: "'result.json' in the build's output is missing or is not a regular file."
    });
  });

  it("is refused when the output directory or its folder of files is a link to a directory", async () => {
    // A real directory with a valid result and a file: what a link would lead the reader to.
    const real = await output();

    const linkedOut = join(scratch, "out-linked");
    await symlink(real.out, linkedOut);
    expect(failure(await readPageBuildOutput(linkedOut))).toEqual({
      reason: "output_refused",
      message: "The build left no output directory."
    });
    expect(failure(await readPageBuildOutput(join(scratch, "out-missing")))).toMatchObject({
      reason: "output_refused"
    });

    const linkedFiles = await output();
    await rm(linkedFiles.files, { recursive: true });
    await symlink(real.files, linkedFiles.files);
    expect(failure(await readPageBuildOutput(linkedFiles.out))).toEqual({
      reason: "output_refused",
      message: "The build wrote no directory of built files."
    });

    const noFiles = await output();
    await rm(noFiles.files, { recursive: true });
    expect(failure(await readPageBuildOutput(noFiles.out))).toEqual({
      reason: "output_refused",
      message: "The build wrote no directory of built files."
    });
  });

  it("is refused, without waiting, when the result or a built file is a pipe", async () => {
    const piped = await output();
    await rm(join(piped.out, "result.json"));
    execFileSync("mkfifo", [join(piped.out, "result.json")]);
    // Opening a pipe to read waits for a writer. Nobody writes: the answer must come anyway.
    expect(failure(await readPageBuildOutput(piped.out))).toEqual({
      reason: "output_refused",
      message: "'result.json' in the build's output is missing or is not a regular file."
    });

    const file = await output();
    execFileSync("mkfifo", [join(file.files, "pipe.js")]);
    expect(failure(await readPageBuildOutput(file.out))).toEqual({
      reason: "output_refused",
      message: "'pipe.js' in the build's output is not a regular file."
    });
  }, 5000);

  it("is refused at the entry that takes it over the count of names or the depth", async () => {
    // Folders hold no bytes and are no files: only the count of names stops them.
    const wide = await output();
    await Promise.all(
      Array.from({ length: PAGE_BUILD_MAX_OUTPUT_ENTRIES + 1 }, (_, index) =>
        mkdir(join(wide.files, `d${index}`))
      )
    );
    expect(failure(await readPageBuildOutput(wide.out))).toEqual({
      reason: "output_refused",
      message: "The build wrote more files and folders than a Page may have."
    });

    const deep = await output();
    await mkdir(
      join(deep.files, ...Array.from({ length: PAGE_BUILD_MAX_OUTPUT_DEPTH + 1 }, () => "d")),
      { recursive: true }
    );
    expect(failure(await readPageBuildOutput(deep.out))).toEqual({
      reason: "output_refused",
      message: "The built files are nested too deep."
    });
  });

  it("is refused when a built file has a second name", async () => {
    const secret = join(scratch, "linked-secret.txt");
    await writeFile(secret, "a secret of the worker");
    const { out, files } = await output();
    await link(secret, join(files, "leak.txt"));

    expect(failure(await readPageBuildOutput(out))).toEqual({
      reason: "output_refused",
      message: "'leak.txt' in the build's output is not a regular file of its own."
    });
  });

  it("is refused when the result is larger than a result may be, or is not one", async () => {
    const large = await output();
    await writeFile(
      join(large.out, "result.json"),
      JSON.stringify({
        status: "errors",
        errors: [],
        padding: "x".repeat(PAGE_BUILD_MAX_RESULT_BYTES)
      })
    );
    expect(failure(await readPageBuildOutput(large.out))).toEqual({
      reason: "output_refused",
      message: "'result.json' takes the build's output over its size limit."
    });

    for (const text of [
      "not json",
      JSON.stringify({ status: "built", manifest: { id: "demo-page" } }),
      JSON.stringify({ status: "built", manifest: JSON.parse(result).manifest, extra: true }),
      JSON.stringify({ status: "errors", errors: [{ file: "a", message: "m", code: "made_up" }] })
    ]) {
      const wrong = await output();
      await writeFile(join(wrong.out, "result.json"), text);
      expect(failure(await readPageBuildOutput(wrong.out))).toMatchObject({
        reason: "output_refused"
      });
    }
  });

  it("is refused at the file that takes it over the count or the size, without reading on", async () => {
    const many = await output();
    for (const name of ["a.js", "b.js", "c.js"]) {
      await writeFile(join(many.files, name), "x");
    }
    expect(failure(await readPageBuildOutput(many.out, { maxOutputFiles: 3 }))).toEqual({
      reason: "output_refused",
      message: "The build wrote more files than a Page may have."
    });
    expect((await readPageBuildOutput(many.out, { maxOutputFiles: 4 })).status).toBe("built");

    const heavy = await output();
    await writeFile(join(heavy.files, "big.bin"), new Uint8Array(4096));
    expect(failure(await readPageBuildOutput(heavy.out, { maxOutputBytes: 4000 }))).toMatchObject({
      reason: "output_refused",
      message: expect.stringContaining("over its size limit")
    });
  });

  it("is refused when a path could not be a file of a Page", async () => {
    // A name on disk cannot be `..`; these are the forms of it a file system does hold.
    for (const name of ["..\\outside.js", "a\\..\\..\\b.js", "..%2f..%2fb.js", "bad:name.js"]) {
      const { out, files } = await output();
      await writeFile(join(files, name), "x");
      expect(failure(await readPageBuildOutput(out))).toMatchObject({
        reason: "output_refused",
        message: expect.stringContaining("a path that cannot be stored")
      });
    }

    const reserved = await output();
    await mkdir(join(reserved.files, "assets/__catalyst"), { recursive: true });
    await writeFile(join(reserved.files, "assets/__catalyst/guard.js"), "x");
    expect(failure(await readPageBuildOutput(reserved.out))).toMatchObject({
      reason: "output_refused",
      message: expect.stringContaining("__catalyst")
    });

    // The entry the result names is a path too.
    for (const entry of ["../index.html", "/etc/passwd", "missing.html"]) {
      const named = await output();
      await writeFile(
        join(named.out, "result.json"),
        JSON.stringify({
          status: "built",
          manifest: { id: "demo-page", name: "Demo Page", kit: "1.0.0", entry }
        })
      );
      expect(failure(await readPageBuildOutput(named.out))).toMatchObject({
        reason: "output_refused"
      });
    }
  });
});

// The same handover with the container sandbox and the runner image of a release. It needs a
// Docker engine and a built image, so it runs only where one is named:
// CATALYST_PAGE_BUILD_RUNNER_IMAGE=<image> pnpm exec vitest run tests/page-build-sandbox.test.ts
const runnerImage = process.env.CATALYST_PAGE_BUILD_RUNNER_IMAGE;

describe.skipIf(!runnerImage)("a Page build in the runner image", () => {
  const container = (command?: string) =>
    createSandboxPageBuild({
      sandbox: new DockerWorkspaceCommandProcessExecutor({
        image: runnerImage ?? "",
        networkMode: "none",
        readOnlyRootFilesystem: true,
        cpuCount: 1,
        memoryBytes: 4 * 1024 * 1024 * 1024,
        pidsLimit: 128
      }),
      tempRoot,
      ...(command ? { command } : {})
    });

  it("builds a React Page with the command the image carries", async () => {
    const outcome = await container()({
      id: "container",
      signal: new AbortController().signal,
      files: pageFiles({
        "app.yaml": reactManifest,
        "src/routes/__root.tsx": rootRoute,
        "src/routes/index.tsx": fileRoute("/"),
        "src/routes/history.tsx": fileRoute("/history")
      })
    });
    if (outcome.status !== "built") {
      throw new Error(`The Page did not build: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.manifest.pages).toEqual([{ path: "/" }, { path: "/history" }]);
    expect(outcome.files.map((file) => file.path)).toContain("index.html");
  }, 120_000);

  it("names the runner image when it has no such command", async () => {
    const outcome = await container("catalyst-page-build-of-a-later-release")({
      id: "absent",
      signal: new AbortController().signal,
      files: pageFiles({ "app.yaml": htmlManifest, "index.html": "<!doctype html><p>x</p>" })
    });
    expect(failure(outcome)).toMatchObject({ reason: "command_missing" });
  }, 120_000);
});
