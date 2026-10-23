import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASSET_REPO_MAX_FILE_BYTES,
  ASSET_REPO_MAX_FILES,
  ASSET_REPO_MAX_TREE_BYTES,
  ASSET_REPO_OUTPUT_DIRECTORY,
  ASSET_REPO_REPOSITORY_DIRECTORY,
  treeRefusal,
  type TreeEntry
} from "@work-shape/catalyst-asset-repo";
import {
  commitFolder,
  materialise,
  pathWithGitThatFirstRuns,
  testGit,
  writeExecutable,
  type TestBundle
} from "./support/asset-repo";

// The command that keeps the repository of an asset, run the way the worker runs it: a
// directory in, `out/` read back. Git is the one on this machine's path; the container the
// command runs in on an instance is not under test here.

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "asset-repo-test-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const source = {
  "app.yaml": "id: rates\nname: Rates\n",
  "src/rates.ts": "export const rate = 1;\n",
  "src/routes/index.tsx": "export default null;\n"
};

/** The committed result, or a failed test that shows the refusal. */
function committed(commit: Awaited<ReturnType<typeof commitFolder>>) {
  if (commit.result.status !== "committed" || !commit.bundle) {
    throw new Error(`not committed: ${JSON.stringify(commit.result)}`);
  }
  return { ...commit.result, bundle: commit.bundle };
}

/** A repository of two revisions, with its bundles, for the tests that read one. */
async function twoRevisions() {
  const first = committed(await commitFolder(scratch, { files: source }));
  const second = committed(
    await commitFolder(scratch, {
      files: { ...source, "src/rates.ts": "export const rate = 2;\n" },
      bundles: [first.bundle],
      base: first.commit,
      time: 1_760_270_500
    })
  );
  return { first, second, bundles: [first.bundle, second.bundle] };
}

async function repositoryOf(
  bundles: readonly TestBundle[],
  draft: string,
  revisions: string[]
): Promise<string> {
  const { result, directory } = await materialise(scratch, {
    bundles,
    draft,
    revisions: revisions.map((commit, index) => ({ number: index + 1, commit }))
  });
  expect(result).toMatchObject({ status: "materialised" });
  return join(directory, ASSET_REPO_OUTPUT_DIRECTORY, ASSET_REPO_REPOSITORY_DIRECTORY);
}

describe("committing a folder", () => {
  it("commits every file with mode 100644 and writes one full bundle", async () => {
    const commit = await commitFolder(scratch, {
      files: source,
      prepare: (folder) => writeExecutable(join(folder, "bin/run.sh"), "#!/bin/sh\n")
    });
    const result = committed(commit);
    expect(result).toMatchObject({ parent: null, files: 4 });
    expect(result.bundle).toMatchObject({ file: `${result.commit}.bundle`, prerequisite: null });
    const repository = await repositoryOf([result.bundle], result.commit, [result.commit]);
    const tree = await testGit(repository, ["ls-tree", "-r", "refs/revisions/1"]);
    expect(tree.split("\n").map((line) => line.split(/\s+/u))).toEqual([
      ["100644", "blob", expect.any(String), "app.yaml"],
      ["100644", "blob", expect.any(String), "bin/run.sh"],
      ["100644", "blob", expect.any(String), "src/rates.ts"],
      ["100644", "blob", expect.any(String), "src/routes/index.tsx"]
    ]);
    expect(await testGit(repository, ["rev-parse", "refs/heads/draft"])).toBe(result.commit);
    expect(await testGit(repository, ["rev-parse", `${result.commit}^{tree}`])).toBe(result.tree);
  });

  it("commits a file a .gitignore of the folder names, and the .gitignore", async () => {
    const result = committed(
      await commitFolder(scratch, {
        files: { ...source, ".gitignore": "src/rates.ts\n*.tsx\n" }
      })
    );
    const repository = await repositoryOf([result.bundle], result.commit, [result.commit]);
    const paths = await testGit(repository, ["ls-tree", "-r", "--name-only", result.commit]);
    expect(paths.split("\n")).toEqual([
      ".gitignore",
      "app.yaml",
      "src/rates.ts",
      "src/routes/index.tsx"
    ]);
  });

  it("stores the bytes of a file as they are", async () => {
    const bytes = "line one\r\nline two\r\n";
    const result = committed(
      await commitFolder(scratch, { files: { ...source, "data/windows.txt": bytes } })
    );
    const repository = await repositoryOf([result.bundle], result.commit, [result.commit]);
    const size = await testGit(repository, ["cat-file", "-s", `${result.commit}:data/windows.txt`]);
    expect(Number(size)).toBe(bytes.length);
  });

  it("gives the same commit id when the save is repeated, and another for another time", async () => {
    const first = committed(await commitFolder(scratch, { files: source }));
    const again = committed(await commitFolder(scratch, { files: source }));
    const later = committed(await commitFolder(scratch, { files: source, time: 1_760_270_401 }));
    expect(again.commit).toBe(first.commit);
    expect(again.tree).toBe(first.tree);
    expect(later.commit).not.toBe(first.commit);
    expect(later.tree).toBe(first.tree);
  });

  it("names the ledger's author and time in the commit, and no person", async () => {
    const result = committed(
      await commitFolder(scratch, { files: source, author: "user_7f3a", time: 1_760_270_400 })
    );
    const repository = await repositoryOf([result.bundle], result.commit, [result.commit]);
    const header = await testGit(repository, ["cat-file", "commit", result.commit]);
    expect(header).toContain(
      "author user_7f3a <user_7f3a@users.catalyst.invalid> 1760270400 +0000"
    );
    expect(header).toContain("committer catalyst <platform@catalyst.invalid> 1760270400 +0000");
  });

  it("commits on the base and writes an incremental bundle that stands on it", async () => {
    const { first, second, bundles } = await twoRevisions();
    expect(second).toMatchObject({ parent: first.commit });
    expect(second.bundle.prerequisite).toBe(first.commit);
    const repository = await repositoryOf(bundles, second.commit, [first.commit, second.commit]);
    expect(await testGit(repository, ["rev-parse", `${second.commit}^`])).toBe(first.commit);
    expect(await testGit(repository, ["rev-parse", "refs/revisions/1"])).toBe(first.commit);
    expect(await testGit(repository, ["rev-parse", "refs/revisions/2"])).toBe(second.commit);
    expect(await testGit(repository, ["for-each-ref", "--format=%(refname)"])).toBe(
      "refs/heads/draft\nrefs/revisions/1\nrefs/revisions/2"
    );
  });

  it("refuses a folder with a symbolic link and names it", async () => {
    const commit = await commitFolder(scratch, {
      files: source,
      prepare: (folder) => symlink("/etc/passwd", join(folder, "src/link"))
    });
    expect(commit.result).toMatchObject({
      status: "refused",
      code: "symbolic_link",
      path: "src/link"
    });
    expect(existsSync(join(commit.directory, ASSET_REPO_OUTPUT_DIRECTORY, "result.json"))).toBe(
      true
    );
  });

  it("refuses a folder with a .git component, and runs neither its fsmonitor nor its hook", async () => {
    const marker = join(scratch, "ran");
    const commit = await commitFolder(scratch, {
      files: source,
      prepare: async (folder) => {
        const git = join(folder, "vendor/.git");
        await mkdir(join(git, "objects"), { recursive: true });
        await mkdir(join(git, "refs"));
        await writeFile(join(git, "HEAD"), "ref: refs/heads/main\n");
        await writeFile(
          join(git, "config"),
          `[core]\n\tfsmonitor = "touch ${marker}-fsmonitor; false"\n\thooksPath = ${git}/hooks\n`
        );
        for (const hook of ["pre-commit", "post-index-change", "reference-transaction"]) {
          await writeExecutable(join(git, "hooks", hook), `#!/bin/sh\ntouch ${marker}-hook\n`);
        }
      }
    });
    expect(commit.result).toMatchObject({
      status: "refused",
      code: "path_refused",
      path: "vendor/.git"
    });
    expect(existsSync(`${marker}-fsmonitor`)).toBe(false);
    expect(existsSync(`${marker}-hook`)).toBe(false);
  });

  it("runs no hook and no fsmonitor of a folder that is itself a repository's work tree", async () => {
    // The folder is refused for its `.git`. Before that the command made its own repository
    // and read the bundles, and nothing of the folder's configuration ran then either.
    const marker = join(scratch, "top");
    const { first } = await twoRevisions();
    const commit = await commitFolder(scratch, {
      files: source,
      bundles: [first.bundle],
      base: first.commit,
      prepare: async (folder) => {
        await writeFile(join(folder, ".git"), "gitdir: /nonexistent\n");
        await writeExecutable(join(folder, "hooks/pre-commit"), `#!/bin/sh\ntouch ${marker}\n`);
      }
    });
    expect(commit.result).toMatchObject({ status: "refused", path: ".git" });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a folder that is itself a symbolic link", async () => {
    const elsewhere = await mkdtemp(join(scratch, "elsewhere-"));
    await writeFile(join(elsewhere, "secret.txt"), "not of this folder\n");
    const commit = await commitFolder(scratch, {
      files: {},
      prepare: async (folder) => {
        await rm(folder, { recursive: true });
        await symlink(elsewhere, folder);
      }
    });
    expect(commit.result).toMatchObject({ status: "refused", code: "folder_invalid" });
  });

  // Fails where a file is read by its path a second time, after the walk: the commit would
  // hold the bytes of a file outside the folder.
  it("commits the bytes it read, also when a file becomes a link while it runs", async () => {
    const elsewhere = await mkdtemp(join(scratch, "elsewhere-"));
    await writeFile(join(elsewhere, "secret.txt"), "not of this folder\n");
    const commit = committed(
      await commitFolder(scratch, {
        files: source,
        path: (directory) => {
          const file = join(directory, "folder/src/rates.ts");
          return pathWithGitThatFirstRuns(
            scratch,
            "hash-object",
            1,
            `rm '${file}' && ln -s '${join(elsewhere, "secret.txt")}' '${file}'`
          );
        }
      })
    );
    const repository = await repositoryOf([commit.bundle], commit.commit, [commit.commit]);
    expect(await testGit(repository, ["cat-file", "-p", `${commit.commit}:src/rates.ts`])).toBe(
      source["src/rates.ts"].trim()
    );
  });

  // Fails where such a name reaches git: git refuses it and the command ends without a result.
  it("refuses a name with a character that is not shown, with a refusal that names the path", async () => {
    for (const path of [".g\u200cit/config", ".gitmodule\u200cs"]) {
      const commit = await commitFolder(scratch, { files: { ...source, [path]: "x\n" } });
      expect(commit.result, path).toMatchObject({ status: "refused", code: "path_refused" });
    }
  });

  it("refuses a file over the cap and names it", async () => {
    const commit = await commitFolder(scratch, {
      files: { ...source, "data/big.bin": new Uint8Array(ASSET_REPO_MAX_FILE_BYTES + 1) }
    });
    expect(commit.result).toMatchObject({
      status: "refused",
      code: "file_too_large",
      path: "data/big.bin"
    });
  });

  it("refuses a folder with more directories than a walk takes", async () => {
    // Directories hold no bytes and count for no file: the walk has a cap of its own.
    const deep = await commitFolder(scratch, {
      files: source,
      prepare: async (folder) => {
        for (let index = 0; index < 4 * ASSET_REPO_MAX_FILES; index += 1) {
          await mkdir(join(folder, "d", String(index)), { recursive: true });
        }
      }
    });
    expect(deep.result).toMatchObject({ status: "refused", code: "too_many_files" });
  });

  it("refuses .gitattributes, .gitmodules and a Git LFS pointer, each by its path", async () => {
    const refusalOf = async (files: Record<string, string>) =>
      (await commitFolder(scratch, { files: { ...source, ...files } })).result;
    expect(await refusalOf({ ".gitattributes": "* text eol=crlf\n" })).toMatchObject({
      status: "refused",
      path: ".gitattributes"
    });
    expect(await refusalOf({ "lib/.gitmodules": "" })).toMatchObject({
      status: "refused",
      path: "lib/.gitmodules"
    });
    expect(
      await refusalOf({
        "model.bin": "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a\nsize 12345\n"
      })
    ).toMatchObject({ status: "refused", code: "lfs_pointer", path: "model.bin" });
  });

  it("refuses a base no bundle holds", async () => {
    const { first, second } = await twoRevisions();
    const commit = await commitFolder(scratch, {
      files: source,
      bundles: [first.bundle],
      base: second.commit
    });
    expect(commit.result).toMatchObject({ status: "refused", code: "commit_missing" });
  });
});

describe("the trees the store takes", () => {
  const file = (path: string, size = 1): TreeEntry => ({ mode: "100644", path, size });

  it("refuses each entry of the list with its path", () => {
    const refused = (entries: TreeEntry[]) => {
      const refusal = treeRefusal(entries);
      return refusal ? [refusal.code, refusal.path] : undefined;
    };
    expect(refused([file("a.txt"), { mode: "40000", path: "src" }, file("src/b.txt")])).toBe(
      undefined
    );
    expect(refused([{ mode: "120000", path: "link" }])).toEqual(["symbolic_link", "link"]);
    expect(refused([{ mode: "160000", path: "sub" }])).toEqual(["submodule", "sub"]);
    expect(refused([file("App.yaml"), file("app.yaml")])).toEqual(["case_collision", "app.yaml"]);
    for (const path of [
      ".git/config",
      "a/.GIT/config",
      "a/../b",
      "a/./b",
      "/etc/passwd",
      "a\\b",
      "a\nb",
      "a//b",
      "GIT~1/config",
      "a/.gitmodules",
      ".gitattributes",
      "c:stream",
      "trailing./x",
      "trailing /x",
      // What HFS+ drops from a name: these read as `.git` and `.gitmodules` there.
      ".g\u200cit/config",
      ".gitmodule\u200cs",
      "a/.gi\u200dt",
      "\ufeff.git",
      "left\u202eright"
    ]) {
      expect(refused([file(path)]), path).toEqual(["path_refused", path]);
    }
    expect(treeRefusal([file(".g\u200cit")])?.message).toContain(".g<U+200C>it");
    const long = "a".repeat(513);
    expect(refused([file(long)])).toEqual(["path_too_long", long]);
    expect(refused([file("big", ASSET_REPO_MAX_FILE_BYTES + 1)])).toEqual([
      "file_too_large",
      "big"
    ]);
    const many = Array.from({ length: ASSET_REPO_MAX_FILES + 1 }, (_, index) => file(`f${index}`));
    expect(refused(many)).toEqual(["too_many_files", `f${ASSET_REPO_MAX_FILES}`]);
    expect(refused(many.slice(0, ASSET_REPO_MAX_FILES))).toBe(undefined);
    const heavy = Array.from(
      { length: ASSET_REPO_MAX_TREE_BYTES / ASSET_REPO_MAX_FILE_BYTES + 1 },
      (_, index) => file(`h${index}`, ASSET_REPO_MAX_FILE_BYTES)
    );
    expect(refused(heavy)).toEqual(["tree_too_large", `h${heavy.length - 1}`]);
    expect(refused(heavy.slice(0, -1))).toBe(undefined);
  });
});

describe("making a repository from bundles", () => {
  it("refuses a bundle that is not there and names it", async () => {
    const { first, second, bundles } = await twoRevisions();
    const { result } = await materialise(scratch, {
      bundles,
      draft: second.commit,
      revisions: [{ number: 1, commit: first.commit }],
      withhold: [second.bundle.file]
    });
    expect(result).toMatchObject({
      status: "refused",
      code: "bundle_missing",
      path: second.bundle.file
    });
  });

  it("says what the ledger records of the bundle it wrote: its size and SHA-256", async () => {
    const { result, bundle } = await commitFolder(scratch, { files: source });
    expect(result).toMatchObject({
      status: "committed",
      bundle: {
        bytes: bundle?.bytes.byteLength,
        sha256: createHash("sha256")
          .update(bundle?.bytes ?? "")
          .digest("hex")
      }
    });
  });

  it("refuses a bundle whose bytes are not the ones the ledger recorded", async () => {
    const { first, second } = await twoRevisions();
    // Another bundle that is whole and ends on a commit of its own, under the name of the second.
    const other = committed(
      await commitFolder(scratch, {
        files: { ...source, "src/rates.ts": "export const rate = 3;\n" },
        bundles: [first.bundle],
        base: first.commit
      })
    );
    const recorded = {
      sha256: createHash("sha256").update(second.bundle.bytes).digest("hex"),
      bytes: second.bundle.bytes.byteLength
    };
    const flipped = Buffer.from(second.bundle.bytes);
    flipped[flipped.byteLength - 1] = (flipped.at(-1) ?? 0) ^ 1;
    const wrong = {
      swapped: other.bundle.bytes,
      truncated: second.bundle.bytes.subarray(0, second.bundle.bytes.byteLength - 20),
      "of the same size": flipped
    };
    for (const [what, bytes] of Object.entries(wrong)) {
      const { result, directory } = await materialise(scratch, {
        bundles: [first.bundle, { ...second.bundle, bytes, recorded }],
        draft: second.commit,
        revisions: [{ number: 1, commit: first.commit }]
      });
      expect(result, what).toMatchObject({
        status: "refused",
        code: "bundle_hash_mismatch",
        path: second.bundle.file
      });
      // Refused before git saw it: the repository holds the first bundle and nothing of this one.
      const repository = join(
        directory,
        ASSET_REPO_OUTPUT_DIRECTORY,
        ASSET_REPO_REPOSITORY_DIRECTORY
      );
      await expect(testGit(repository, ["cat-file", "-e", other.commit]), what).rejects.toThrow();
    }
    // A save reads the same bundles and refuses the same way.
    const save = await commitFolder(scratch, {
      files: source,
      bundles: [
        { ...first.bundle, recorded: { ...recorded, bytes: first.bundle.bytes.byteLength } }
      ],
      base: first.commit
    });
    expect(save.result).toMatchObject({ status: "refused", code: "bundle_hash_mismatch" });
  });

  // Fails where the file is opened again for git after it was hashed: the repository would
  // hold objects of a bundle the ledger never recorded.
  it("gives git the bytes it hashed, also when the file is exchanged while it runs", async () => {
    const { first, second, bundles } = await twoRevisions();
    const honest = await repositoryOf(bundles, second.commit, [first.commit, second.commit]);
    // A bundle with the header of the second and a pack that holds one object more.
    const smuggled = await testGit(honest, ["hash-object", "-w", "--stdin"], {
      input: "smuggled\n"
    });
    const objects = await testGit(honest, [
      "rev-list",
      "--objects",
      `${first.commit}..${second.commit}`
    ]);
    const packs = await mkdtemp(join(scratch, "pack-"));
    await testGit(honest, ["pack-objects", join(packs, "pack")], {
      input: `${[...objects.split("\n").map((line) => line.slice(0, 40)), smuggled].join("\n")}\n`
    });
    const pack = (await readdir(packs)).find((name) => name.endsWith(".pack")) ?? "";
    const header = second.bundle.bytes.subarray(0, second.bundle.bytes.indexOf("\n\n") + 2);
    const exchanged = join(packs, "exchanged.bundle");
    await writeFile(exchanged, Buffer.concat([header, await readFile(join(packs, pack))]));

    // The second call of `cat-file` asks for the commit the second bundle stands on: after the
    // bundle was hashed and before its pack is read.
    const { result, directory } = await materialise(scratch, {
      bundles,
      draft: second.commit,
      revisions: [{ number: 1, commit: first.commit }],
      path: (target) =>
        pathWithGitThatFirstRuns(
          scratch,
          "cat-file",
          2,
          `cp '${exchanged}' '${join(target, "bundles", second.bundle.file)}'`
        )
    });
    expect(result).toMatchObject({ status: "materialised" });
    const repository = join(
      directory,
      ASSET_REPO_OUTPUT_DIRECTORY,
      ASSET_REPO_REPOSITORY_DIRECTORY
    );
    expect(await readFile(join(directory, "bundles", second.bundle.file))).toEqual(
      await readFile(exchanged)
    );
    await expect(testGit(repository, ["cat-file", "-e", smuggled])).rejects.toThrow();
  });

  it("makes its repository new: refuses one that is there already, and a request that names no bundle", async () => {
    const { first, second, bundles } = await twoRevisions();
    const honest = await repositoryOf(bundles, second.commit, [first.commit, second.commit]);
    const request = { draft: second.commit, revisions: [{ number: 1, commit: first.commit }] };
    const output = (directory: string) =>
      join(directory, ASSET_REPO_OUTPUT_DIRECTORY, ASSET_REPO_REPOSITORY_DIRECTORY);
    // A repository that holds the commits already, put where the command writes its own.
    const planted = await materialise(scratch, {
      ...request,
      bundles: [],
      prepare: (directory) => symlink(honest, output(directory))
    });
    expect(planted.result).toMatchObject({ status: "refused" });
    const copied = await materialise(scratch, {
      ...request,
      bundles,
      prepare: async (directory) => {
        await mkdir(output(directory));
      }
    });
    expect(copied.result).toMatchObject({ status: "refused", code: "output_exists" });
    const none = await materialise(scratch, { ...request, bundles: [] });
    expect(none.result).toMatchObject({ status: "refused", code: "request_invalid" });
  });

  it("refuses a bundle whose base no earlier bundle holds", async () => {
    const { first, second } = await twoRevisions();
    const third = committed(
      await commitFolder(scratch, {
        files: { ...source, "src/added.ts": "export {};\n" },
        bundles: [first.bundle, second.bundle],
        base: second.commit,
        time: 1_760_270_600
      })
    );
    const { result } = await materialise(scratch, {
      bundles: [first.bundle, third.bundle],
      draft: third.commit,
      revisions: []
    });
    expect(result).toMatchObject({
      status: "refused",
      code: "bundle_prerequisite_missing",
      path: third.bundle.file
    });
  });

  it("takes a bundle that is named twice as it takes it once", async () => {
    const { first, second } = await twoRevisions();
    const repository = await repositoryOf(
      [first.bundle, second.bundle, second.bundle],
      second.commit,
      [first.commit, second.commit]
    );
    expect(await testGit(repository, ["rev-list", "--count", "refs/heads/draft"])).toBe("2");
    await testGit(repository, ["fsck", "--strict", "--no-dangling"]);
  });

  it("takes the tip from the ledger and never reads a bundle the ledger does not name", async () => {
    // A save that stopped after it wrote its bundle left an object no row names.
    const { first, second } = await twoRevisions();
    const { result, directory } = await materialise(scratch, {
      bundles: [first.bundle],
      draft: first.commit,
      revisions: [{ number: 1, commit: first.commit }]
    });
    expect(result).toEqual({
      status: "materialised",
      draft: first.commit,
      revisions: 1,
      commits: 1
    });
    const repository = join(
      directory,
      ASSET_REPO_OUTPUT_DIRECTORY,
      ASSET_REPO_REPOSITORY_DIRECTORY
    );
    await expect(testGit(repository, ["cat-file", "-e", second.commit])).rejects.toThrow();
  });

  it("refuses a revision whose commit no bundle holds", async () => {
    const { first, second } = await twoRevisions();
    const { result } = await materialise(scratch, {
      bundles: [first.bundle],
      draft: first.commit,
      revisions: [
        { number: 1, commit: first.commit },
        { number: 2, commit: second.commit }
      ]
    });
    expect(result).toMatchObject({ status: "refused", code: "commit_missing" });
    expect(result.status === "refused" && result.message).toContain("revision 2");
  });

  describe("a bundle somebody else wrote", () => {
    /** A repository the test may write to, at the first revision, and a way to bundle onto it. */
    async function hostile() {
      const { first } = await twoRevisions();
      const repository = await repositoryOf([first.bundle], first.commit, [first.commit]);
      const bundle = async (name: string, commit: string, refs = ["refs/heads/draft"]) => {
        await testGit(repository, ["update-ref", "refs/heads/draft", commit]);
        const path = join(scratch, `${name}-${Date.now()}.bundle`);
        await testGit(repository, [
          "bundle",
          "create",
          "--quiet",
          path,
          `${first.commit}..refs/heads/draft`,
          ...refs.slice(1)
        ]);
        const { readFile } = await import("node:fs/promises");
        return {
          file: `${commit}.bundle`,
          tip: commit,
          prerequisite: first.commit,
          bytes: await readFile(path)
        };
      };
      const tree = await testGit(repository, ["rev-parse", `${first.commit}^{tree}`]);
      return { first, repository, bundle, tree };
    }
    const refusalOf = async (bundles: TestBundle[], draft: string) =>
      (await materialise(scratch, { bundles, draft, revisions: [] })).result;

    it("is refused when a commit in it is one git's object check refuses", async () => {
      const { first, repository, bundle, tree } = await hostile();
      const commit = await testGit(
        repository,
        ["hash-object", "-t", "commit", "-w", "--stdin", "--literally"],
        {
          input: `tree ${tree}\nparent ${first.commit}\ncommitter x <x@x> 1 +0000\n\nno author\n`
        }
      );
      const bad = await bundle("bad-commit", commit);
      // Git's own `bundle unbundle` takes it: the check is the command's.
      expect(await refusalOf([first.bundle, bad], commit)).toMatchObject({
        status: "refused",
        code: "bundle_invalid",
        path: bad.file
      });
    });

    it("is refused when it holds a second ref", async () => {
      const { first, repository, bundle, tree } = await hostile();
      const commit = await testGit(repository, [
        "commit-tree",
        tree,
        "-p",
        first.commit,
        "-m",
        "two refs"
      ]);
      await testGit(repository, ["update-ref", "refs/heads/other", commit]);
      const two = await bundle("two-refs", commit, ["refs/heads/draft", "refs/heads/other"]);
      expect(await refusalOf([first.bundle, two], commit)).toMatchObject({
        status: "refused",
        code: "bundle_invalid"
      });
    });

    it("is refused when it ends on another commit than the ledger names, or stands on another", async () => {
      const { first, repository, bundle, tree } = await hostile();
      const commit = await testGit(repository, [
        "commit-tree",
        tree,
        "-p",
        first.commit,
        "-m",
        "honest"
      ]);
      const honest = await bundle("honest", commit);
      expect(
        await refusalOf([first.bundle, { ...honest, tip: first.commit }], first.commit)
      ).toMatchObject({ status: "refused", code: "bundle_invalid" });
      expect(
        await refusalOf([first.bundle, { ...honest, prerequisite: commit }], commit)
      ).toMatchObject({ status: "refused", code: "bundle_invalid" });
      // The header rewritten to stand on a commit nobody has.
      const text = honest.bytes.toString("latin1");
      const lying = Buffer.from(text.replace(`-${first.commit}`, `-${"1".repeat(40)}`), "latin1");
      expect(await refusalOf([first.bundle, { ...honest, bytes: lying }], commit)).toMatchObject({
        status: "refused",
        code: "bundle_invalid"
      });
      expect(await refusalOf([first.bundle, honest], commit)).toMatchObject({
        status: "materialised"
      });
    });

    it("is refused when it is not a version 2 bundle", async () => {
      const { first } = await hostile();
      const text = first.bundle.bytes.toString("latin1");
      const v3 = Buffer.from(text.replace("# v2 git bundle\n", "# v3 git bundle\n"), "latin1");
      expect(await refusalOf([{ ...first.bundle, bytes: v3 }], first.commit)).toMatchObject({
        status: "refused",
        code: "bundle_invalid",
        path: first.bundle.file
      });
    });
  });
});
