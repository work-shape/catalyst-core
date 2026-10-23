import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations, type Asset } from "@work-shape/catalyst-api-contract";
import { runCli, readManifest, readWorkingCopy } from "@work-shape/catalyst-cli";
import platformContext from "./fixtures/cli-platform-context.json";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});
vi.mock("node:child_process", { spy: true });

const directories: string[] = [];
afterEach(async () => {
  vi.mocked(fs.writeFile).mockImplementation(
    (await vi.importActual<typeof fs>("node:fs/promises")).writeFile
  );
  vi.mocked(fs.rename).mockImplementation(
    (await vi.importActual<typeof fs>("node:fs/promises")).rename
  );
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))
  );
});
const instance = "https://catalyst.test";
const stateFile = ".catalyst-skill.json";
const manifest = "---\nname: guide\ndescription: A useful guide.\n---\n\n# Read me\n";
const content = {
  "SKILL.md": Buffer.from(manifest),
  "references/a.md": Buffer.from("Text\r\nwith ü and a BOM: ﻿\r\n"),
  "scripts/run.py": Buffer.from("raise Exception('this must never run')\n"),
  "assets/logo.png": Buffer.from([137, 80, 78, 71, 0, 255, 254, 10])
};
const files = Object.entries(content).map(([path, bytes]) => ({
  path,
  contentType: "application/octet-stream",
  base64: bytes.toString("base64"),
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex")
}));
const at = "2026-10-18T00:00:00.000Z";

async function fixture(workspaceId?: string) {
  const cwd = await fs.mkdtemp(join(tmpdir(), "catalyst-skill-cli-"));
  directories.push(cwd);
  const calls: Array<{ operation: string; url: URL; body: unknown }> = [];
  const state: {
    files: NonNullable<Asset["files"]>;
    revision: number;
    omitted: boolean;
    broken: boolean;
  } = {
    files,
    revision: 1,
    omitted: false,
    broken: false
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const operation = Object.values(apiOperations).find(
      (op) =>
        op.method === request.method &&
        new RegExp(`^${op.path.replace(/:[^/]+/gu, "[^/]+")}$`, "u").test(url.pathname)
    );
    if (!operation) throw new Error(`Unexpected request ${url.pathname}`);
    const body: unknown =
      request.method === "GET" ? undefined : JSON.parse((await request.text()) || "{}");
    calls.push({ operation: operation.id, url, body });
    switch (operation.id) {
      case "access_tokens.exchange":
        return Response.json({ accessToken: "access", expiresAt: "2099-01-01T00:00:00.000Z" });
      case "platform.context.get":
        return Response.json({
          ...platformContext,
          kinds: [
            {
              kind: "skill",
              plural: "skills",
              lifecycle: "active",
              representation: "config",
              owners: ["instance", "workspace"],
              actions: { read: "skill.read", write: "skill.write", delete: "skill.delete" }
            }
          ]
        });
      case "assets.get": {
        const asset: Asset = {
          id: "skill-id",
          kind: "skill",
          name: "guide",
          revision: state.revision,
          config: { name: "guide", description: "A useful guide.", content: "# Read me" },
          scope:
            workspaceId === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId },
          updatedAt: at,
          ...(workspaceId === undefined ? { attributes: { origin: "release" } } : {}),
          ...(state.omitted ? { filesOmitted: true } : { files: state.files })
        };
        if (state.broken) {
          // The single JSON response breaks after its second file. Nothing reaches disk.
          const bytes = new TextEncoder().encode(
            JSON.stringify(asset).split('"scripts/run.py"')[0]
          );
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.error(new Error("transfer broke after second file"));
              }
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
        return Response.json(asset);
      }
      case "assets.put":
        return Response.json({ revision: 2, version: 2, warnings: [] });
      default:
        throw new Error(`Unexpected operation ${operation.id}`);
    }
  };
  const run = async (args: string[]) => {
    const out: string[] = [],
      err: string[] = [];
    const code = await runCli(
      [
        ...args,
        "--instance",
        instance,
        ...(workspaceId === undefined ? [] : ["--workspace", workspaceId])
      ],
      {
        cwd,
        env: { CATALYST_API_KEY: "test-cli-key" },
        fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      }
    );
    return { code, out: out.join(""), err: err.join("") };
  };
  return {
    cwd,
    calls,
    state,
    run,
    pull: (folder = "copy", skill = "guide") => run(["skill", "pull", skill, folder])
  };
}

/** Snapshot bytes, modes and link destinations without following links. */
async function tree(directory: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (folder: string, prefix: string) => {
    for (const name of (await fs.readdir(folder)).sort()) {
      const path = join(folder, name),
        key = `${prefix}${name}`,
        stats = await fs.lstat(path);
      if (stats.isSymbolicLink()) found[key] = `link:${await fs.readlink(path)}`;
      else if (stats.isDirectory()) {
        found[`${key}/`] = "directory";
        await walk(path, `${key}/`);
      } else found[key] = `${stats.mode & 0o777}:${(await fs.readFile(path)).toString("base64")}`;
    }
  };
  await walk(directory, "");
  return found;
}

// Platform Access check 71. These calls use no database and run no skill script.
describe("catalyst skill pull (ADISC-2 check 71)", () => {
  it.each([undefined, "workspace-id"])(
    "pulls a release or workspace skill byte for byte (%s), refreshes it, and runs nothing",
    async (workspaceId) => {
      const f = await fixture(workspaceId);
      if (workspaceId !== undefined) await fs.mkdir(join(f.cwd, "copy"));
      const result = await f.pull();
      expect(result, result.err).toMatchObject({
        code: 0,
        out: "Pulled revision 1 of skill 'guide' into copy (4 files).\n"
      });
      const read = f.calls.filter((call) => call.operation === "assets.get");
      expect(read).toHaveLength(1);
      expect(read[0]?.url.searchParams.get("files")).toBe("true");
      expect(read[0]?.url.searchParams.get("workspaceId")).toBe(workspaceId ?? null);
      for (const [path, bytes] of Object.entries(content)) {
        const target = join(f.cwd, "copy", path);
        expect(await fs.readFile(target)).toEqual(bytes);
        expect((await fs.stat(target)).mode & 0o777).toBe(0o644 & ~process.umask());
      }
      expect(JSON.parse(await fs.readFile(join(f.cwd, "copy", stateFile), "utf8"))).toEqual({
        instance,
        workspaceId: workspaceId ?? "",
        skill: "guide",
        assetId: "skill-id",
        revision: 1,
        files: Object.fromEntries(files.map((file) => [file.path, file.sha256]))
      });
      const before = await tree(f.cwd);
      expect(await f.pull()).toMatchObject({ code: 0 });
      expect(await tree(f.cwd)).toEqual(before);
      f.state.revision = 2;
      f.state.files = files.filter((file) => file.path !== "assets/logo.png");
      expect(await f.run(["skill", "pull", "guide", "copy", "--json"])).toMatchObject({
        code: 0,
        out: expect.stringContaining('"revision": 2')
      });
      expect(await fs.readdir(join(f.cwd, "copy"))).not.toContain("assets");
      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(childProcess.exec).not.toHaveBeenCalled();
      expect(childProcess.execFile).not.toHaveBeenCalled();
      expect(childProcess.spawnSync).not.toHaveBeenCalled();
    }
  );

  it("refuses an unbound repo before walking its node_modules links", async () => {
    const f = await fixture();
    await fs.mkdir(join(f.cwd, "node_modules"));
    await fs.symlink("missing-package", join(f.cwd, "node_modules/package"));
    const before = await tree(f.cwd);
    expect(await f.pull(".")).toMatchObject({
      code: 1,
      err: expect.stringContaining("holds files and no pulled skill")
    });
    expect(f.calls.some((call) => call.operation === "assets.get")).toBe(false);
    expect(await tree(f.cwd)).toEqual(before);
  });

  it.each(["agent", "agents", "workflow", "guardrail", "unknown-kind"])(
    "rejects %s pull as usage before contacting the instance",
    async (kind) => {
      const f = await fixture();
      expect(await f.run([kind, "pull", "guide", "copy"])).toMatchObject({
        code: 2,
        err: expect.stringContaining("'pull' is a command of skills and Apps only")
      });
      expect(f.calls).toEqual([]);
      expect(await tree(f.cwd)).toEqual({});
    }
  );

  it("shows skill pull once in offline help without advertising pull for every kind", async () => {
    const f = await fixture();
    const result = await f.run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out.match(/catalyst skill pull <name> <folder>/gu)).toHaveLength(1);
    expect(result.out).not.toContain("catalyst <kind> pull");
    expect(f.calls).toEqual([]);
  });

  it("cleans up newly created parents after a failed nested pull", async () => {
    const f = await fixture();
    await fs.mkdir(join(f.cwd, "existing"));
    await fs.writeFile(join(f.cwd, "existing/mine"), "keep");
    const before = await tree(f.cwd);
    f.state.files = files.map((file) => ({ ...file, sha256: "0".repeat(64) }));
    for (const target of ["new/nested/copy", "existing/new/nested/copy"])
      expect(await f.pull(target)).toMatchObject({ code: 1 });
    expect(await tree(f.cwd)).toEqual(before);
  });

  it("preserves additions inside newly created parents when a pull fails", async () => {
    const f = await fixture();
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.writeFile).mockImplementation(async () => {
      await actual.writeFile(join(f.cwd, "new/mine"), "concurrent addition");
      throw new Error("staging failed");
    });
    expect(await f.pull("new/nested/copy")).toMatchObject({ code: 1 });
    expect(await tree(f.cwd)).toEqual({
      "new/": "directory",
      "new/mine": `${0o666 & ~process.umask()}:${Buffer.from("concurrent addition").toString("base64")}`
    });
  });

  it("refuses refreshing a folder that contains the process cwd", async () => {
    const f = await fixture();
    expect(await f.pull()).toMatchObject({ code: 0 });
    for (const cwd of [join(f.cwd, "copy"), join(f.cwd, "copy/references")]) {
      const before = await tree(f.cwd);
      f.calls.length = 0;
      const cwdMock = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      try {
        expect(await f.pull()).toMatchObject({
          code: 1,
          err: expect.stringContaining("contains the current working directory")
        });
      } finally {
        cwdMock.mockRestore();
      }
      expect(f.calls.some((call) => call.operation === "assets.get")).toBe(false);
      expect(await tree(f.cwd)).toEqual(before);
    }
  });

  it("ignores only .DS_Store during pull and refresh and never stages it", async () => {
    const f = await fixture();
    await fs.mkdir(join(f.cwd, "copy"));
    await fs.writeFile(join(f.cwd, "copy/.DS_Store"), "Finder visited an empty folder");
    f.state.files = [
      ...files,
      ...files
        .slice(0, 1)
        .flatMap((file) => [".DS_Store", "references/.DS_Store"].map((path) => ({ ...file, path })))
    ];
    expect(await f.pull()).toMatchObject({ code: 0 });
    for (const path of [".DS_Store", "references/.DS_Store"]) {
      await expect(fs.lstat(join(f.cwd, "copy", path))).rejects.toMatchObject({ code: "ENOENT" });
      await fs.writeFile(join(f.cwd, "copy", path), "Finder metadata");
    }
    // Older pulls may already track Finder metadata; neither edits nor removal count.
    const statePath = join(f.cwd, "copy", stateFile);
    const oldState = JSON.parse(await fs.readFile(statePath, "utf8"));
    oldState.files[".DS_Store"] = files[0]?.sha256;
    oldState.files["references/.DS_Store"] = files[0]?.sha256;
    await fs.writeFile(statePath, JSON.stringify(oldState));
    await fs.rm(join(f.cwd, "copy/references/.DS_Store"));
    vi.mocked(fs.writeFile).mockClear();
    f.state.revision = 2;
    expect(await f.pull()).toMatchObject({ code: 0 });
    expect(fs.writeFile).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/\.DS_Store$/u),
      expect.anything(),
      expect.anything()
    );
    const baseline = JSON.parse(await fs.readFile(join(f.cwd, "copy", stateFile), "utf8"));
    expect(Object.keys(baseline.files)).toEqual(files.map((file) => file.path));
    await fs.writeFile(join(f.cwd, "copy/.DS_Store.backup"), "foreign");
    const before = await tree(f.cwd);
    expect(await f.pull()).toMatchObject({
      code: 1,
      err: expect.stringContaining(".DS_Store.backup")
    });
    expect(await tree(f.cwd)).toEqual(before);
    await fs.rm(join(f.cwd, "copy/.DS_Store.backup"));
    await fs.mkdir(join(f.cwd, "copy/.DS_Store"));
    await fs.writeFile(join(f.cwd, "copy/.DS_Store/mine"), "foreign");
    expect(await f.pull()).toMatchObject({
      code: 1,
      err: expect.stringContaining(".DS_Store/mine")
    });
  });

  it("refuses local edits, additions and removals and lists their paths", async () => {
    const f = await fixture();
    expect(await f.pull()).toMatchObject({ code: 0 });
    await fs.writeFile(join(f.cwd, "copy/SKILL.md"), "local edit");
    await fs.writeFile(join(f.cwd, "copy/.foreign"), "mine");
    await fs.rm(join(f.cwd, "copy/references/a.md"));
    const before = await tree(f.cwd);
    expect(await f.pull()).toMatchObject({
      code: 1,
      err: expect.stringMatching(
        /local changes[\s\S]*\.foreign[\s\S]*SKILL.md[\s\S]*references\/a.md/u
      )
    });
    expect(await tree(f.cwd)).toEqual(before);
  });

  it("keeps an edit made while the new files are being staged", async () => {
    const f = await fixture();
    expect(await f.pull()).toMatchObject({ code: 0 });
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.writeFile).mockImplementation(async (path, data, options) => {
      await actual.writeFile(path, data, options);
      if (String(path).endsWith("/scripts/run.py"))
        await actual.writeFile(join(f.cwd, "copy/SKILL.md"), "edited during staging");
    });
    expect(await f.pull()).toMatchObject({
      code: 1,
      err: expect.stringContaining("local changes")
    });
    expect(await fs.readFile(join(f.cwd, "copy/SKILL.md"), "utf8")).toBe("edited during staging");
    expect((await fs.readdir(f.cwd)).sort()).toEqual(["copy"]);
  });

  it("refuses foreign files and a folder of another skill", async () => {
    const f = await fixture();
    await fs.mkdir(join(f.cwd, "foreign"));
    await fs.writeFile(join(f.cwd, "foreign/mine.txt"), "mine");
    let before = await tree(f.cwd);
    expect(await f.pull("foreign")).toMatchObject({ code: 1 });
    expect(await tree(f.cwd)).toEqual(before);
    expect(await f.pull()).toMatchObject({ code: 0 });
    before = await tree(f.cwd);
    expect(await f.pull("copy", "other")).toMatchObject({
      code: 1,
      err: expect.stringContaining("guide")
    });
    expect(await tree(f.cwd)).toEqual(before);
  });

  it.each([
    "wrong hash",
    "broken HTTP",
    "broken file transfer",
    "../x",
    "/abs",
    "a\\b",
    "./a",
    "a/./b"
  ])("keeps both new and earlier targets unchanged after %s", async (failure) => {
    for (const earlier of [false, true]) {
      const f = await fixture();
      if (earlier) expect(await f.pull()).toMatchObject({ code: 0 });
      const before = await tree(f.cwd);
      f.state.revision = 2;
      if (failure === "wrong hash")
        f.state.files = files.map((file, index) =>
          index === 2 ? { ...file, sha256: "0".repeat(64) } : file
        );
      else if (failure === "broken HTTP") f.state.broken = true;
      else if (failure === "broken file transfer") {
        const actual = await vi.importActual<typeof fs>("node:fs/promises");
        let written = 0;
        vi.mocked(fs.writeFile).mockImplementation(async (path, data, options) => {
          if (String(path).endsWith("/scripts/run.py")) {
            expect(written).toBe(2);
            throw new Error("transfer broke after second file");
          }
          await actual.writeFile(path, data, options);
          written += 1;
        });
      } else
        f.state.files = [
          ...files.slice(0, 2),
          {
            ...files[0],
            path: failure,
            sha256: files[0]?.sha256 ?? "",
            bytes: 0,
            contentType: "text/plain"
          }
        ].filter((file): file is NonNullable<Asset["files"]>[number] => file !== undefined);
      expect(await f.pull()).toMatchObject({ code: 1, out: "" });
      expect(await tree(f.cwd)).toEqual(before);
      vi.mocked(fs.writeFile).mockImplementation(
        (await vi.importActual<typeof fs>("node:fs/promises")).writeFile
      );
    }
  });

  it("restores the target when moving the staged folder into place fails", async () => {
    for (const earlier of [false, true]) {
      const f = await fixture();
      if (earlier) expect(await f.pull()).toMatchObject({ code: 0 });
      const before = await tree(f.cwd);
      const actual = await vi.importActual<typeof fs>("node:fs/promises");
      vi.mocked(fs.rename).mockImplementation(async (source, target) => {
        if (String(source).endsWith("/next")) throw new Error("rename failed");
        return actual.rename(source, target);
      });
      expect(await f.pull()).toMatchObject({ code: 1, out: "" });
      expect(await tree(f.cwd)).toEqual(before);
      vi.mocked(fs.rename).mockImplementation(actual.rename);
    }
  });

  it("refuses links at the target, at a tracked file and at an untracked entry", async () => {
    const f = await fixture();
    await fs.mkdir(join(f.cwd, "outside"));
    await fs.writeFile(join(f.cwd, "outside/mine"), "mine");
    await fs.symlink(join(f.cwd, "outside"), join(f.cwd, "linked"));
    let before = await tree(f.cwd);
    expect(await f.pull("linked")).toMatchObject({
      code: 1,
      err: expect.stringContaining("symbolic link")
    });
    expect(await tree(f.cwd)).toEqual(before);
    expect(await f.pull()).toMatchObject({ code: 0 });
    for (const path of ["SKILL.md", stateFile, "new-link"]) {
      const original = await fs.readFile(join(f.cwd, "copy", path)).catch(() => undefined);
      await fs.rm(join(f.cwd, "copy", path), { force: true });
      await fs.symlink(join(f.cwd, "outside/mine"), join(f.cwd, "copy", path));
      before = await tree(f.cwd);
      expect(await f.pull()).toMatchObject({
        code: 1,
        err: expect.stringContaining("symbolic link")
      });
      expect(await tree(f.cwd)).toEqual(before);
      await fs.rm(join(f.cwd, "copy", path));
      if (original !== undefined) await fs.writeFile(join(f.cwd, "copy", path), original);
    }
  });

  it("names both one-read limits when files are omitted", async () => {
    const f = await fixture();
    f.state.omitted = true;
    expect(await f.pull()).toMatchObject({
      code: 1,
      err: expect.stringMatching(/SKILL_MAX_BYTES.*ASSET_GET_FILES_MAX_BYTES/u)
    });
    expect(await tree(f.cwd)).toEqual({});
  });

  it("leaves the pull state out of skill put --from and the config working-copy reader", async () => {
    const f = await fixture();
    // Text resources use today's config push slice; binary push belongs to section 5b.
    f.state.files = files.slice(0, 2);
    expect(await f.pull()).toMatchObject({ code: 0 });
    expect(
      await f.run(["skill", "put", "guide", "--from", "copy", "--if-revision", "1"])
    ).toMatchObject({ code: 0 });
    const put = f.calls.find((call) => call.operation === "assets.put");
    expect(JSON.stringify(put?.body)).not.toContain(stateFile);
    expect(JSON.stringify(put?.body)).toContain("references/a.md");
    await fs.writeFile(
      join(f.cwd, "catalyst.yaml"),
      "instances:\n  local:\n    url: https://catalyst.test\nagents: []\nskills: [copy/SKILL.md]\n"
    );
    const copy = await readWorkingCopy(f.cwd, await readManifest(f.cwd));
    expect(copy.skills[0]?.resources?.map((resource) => resource.path)).toEqual([
      "references/a.md"
    ]);
  });
});
