import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type AgentConfig,
  type SkillConfig,
  type ToolExecutionContext,
  type SkillFolderFile,
  type SkillFolderReader,
  type WorkspaceCommandSkillMount
} from "@work-shape/catalyst-core";
import {
  createDockerRunInvocation,
  createSkillSourceVersion,
  runSkillMounts,
  SkillFolderCache,
  type WorkspaceCommandProcessInput
} from "@work-shape/catalyst-tool-execution";
import { agent } from "./support/access-instance";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";

// The folders of skills on a command worker's disk, and how a container is handed them. A
// folder is filled from the reader, checked against its hashes, read-only, and never one of
// another instance or another revision; a path that would leave the folder is refused; what
// changed on the disk is filled again, never mounted.

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const instance = asClientInstanceId("instance-a");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const file = (path: string, text: string): SkillFolderFile => {
  const bytes = new TextEncoder().encode(text);
  return { path, bytes, sha256: sha256(bytes) };
};
const FOLDER = [
  file("SKILL.md", "---\ndescription: Fill forms.\n---\n\n# Form\n"),
  file("scripts/fill_form.py", "print('filled')\n"),
  {
    path: "assets/template.pdf",
    bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]),
    sha256: sha256(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]))
  }
];
const mount = (overrides: Partial<WorkspaceCommandSkillMount> = {}) => ({
  name: "form",
  revision: 1,
  sourceVersion: `sha256:${"a".repeat(64)}`,
  ...overrides
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(fs.lstat).mockImplementation(
    (await vi.importActual<typeof fs>("node:fs/promises")).lstat
  );
  for (const root of roots.splice(0)) {
    // The cache leaves read-only folders: opened again before they are removed.
    await chmodTree(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function chmodTree(path: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isDirectory()) return;
  await chmod(path, 0o700);
  for (const entry of await readdir(path)) await chmodTree(join(path, entry));
}

async function cacheWith(files: () => SkillFolderFile[]) {
  const root = await mkdtemp(join(tmpdir(), "skill-mount-cache-"));
  roots.push(root);
  const reads: Parameters<SkillFolderReader["read"]>[0][] = [];
  const cache = new SkillFolderCache({
    rootDirectory: root,
    reader: {
      read(input) {
        reads.push(input);
        return Promise.resolve(files());
      }
    }
  });
  return { root, reads, cache };
}

/** Every file below a folder with its bytes and mode, and every folder with its mode. */
async function tree(directory: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const info = await lstat(path);
      const mode = (info.mode & 0o777).toString(8);
      if (entry.isDirectory()) {
        found[`${relative(directory, path)}/`] = mode;
        await walk(path);
      } else {
        found[relative(directory, path)] = `${mode} ${sha256(await readFile(path))}`;
      }
    }
  };
  await walk(directory);
  return found;
}

describe("the skill folder cache of a command worker", () => {
  it("fills a folder read-only, checked against its hashes, and uses it again without a read", async () => {
    const { cache, reads } = await cacheWith(() => FOLDER);
    const first = await cache.acquire(instance, [mount()]);
    first.release();
    const folder = first.folders[0];
    if (!folder) throw new Error("No folder");
    expect(folder.name).toBe("form");
    expect(await tree(folder.directory)).toEqual({
      "SKILL.md": `444 ${FOLDER[0]?.sha256}`,
      "assets/": "555",
      "assets/template.pdf": `444 ${FOLDER[2]?.sha256}`,
      "scripts/": "555",
      "scripts/fill_form.py": `444 ${FOLDER[1]?.sha256}`
    });
    expect(((await lstat(folder.directory)).mode & 0o777).toString(8)).toBe("555");
    // The reader is asked for the recorded revision and its version, never the live one.
    expect(reads).toEqual([
      {
        clientInstanceId: instance,
        name: "form",
        revision: 1,
        sourceVersion: mount().sourceVersion
      }
    ]);

    const second = await cache.acquire(instance, [mount()]);
    second.release();
    expect(second.folders).toEqual(first.folders);
    expect(reads).toHaveLength(1);
  });

  it("keeps two instances with the same bytes, and two revisions of one skill, apart", async () => {
    const { cache, reads } = await cacheWith(() => FOLDER);
    const a = await cache.acquire(instance, [mount()]);
    const b = await cache.acquire(asClientInstanceId("instance-b"), [mount()]);
    const next = await cache.acquire(instance, [mount({ revision: 2 })]);
    const directories = [a, b, next].map((lease) => lease.folders[0]?.directory);
    expect(new Set(directories).size).toBe(3);
    // Another instance is in a folder of its own, beside and not below the first.
    expect(dirname(dirname(directories[0] ?? ""))).not.toBe(dirname(dirname(directories[1] ?? "")));
    expect(reads.map((read) => [read.clientInstanceId, read.revision])).toEqual([
      ["instance-a", 1],
      ["instance-b", 1],
      ["instance-a", 2]
    ]);
    for (const directory of directories) {
      expect(await readFile(join(directory ?? "", "SKILL.md"), "utf8")).toContain("# Form");
    }
  });

  it.each([
    [
      "a changed byte",
      async (directory: string) => {
        await chmod(join(directory, "scripts"), 0o755);
        await chmod(join(directory, "scripts/fill_form.py"), 0o644);
        await writeFile(join(directory, "scripts/fill_form.py"), "import os; os.system('x')\n");
        await chmod(join(directory, "scripts/fill_form.py"), 0o444);
        await chmod(join(directory, "scripts"), 0o555);
      }
    ],
    [
      "a missing file",
      async (directory: string) => {
        await chmod(directory, 0o755);
        await rm(join(directory, "SKILL.md"));
        await chmod(directory, 0o555);
      }
    ],
    [
      "an added file",
      async (directory: string) => {
        await chmod(directory, 0o755);
        await writeFile(join(directory, "extra.txt"), "planted", { mode: 0o444 });
        await chmod(directory, 0o555);
      }
    ],
    [
      "a link in place of a file",
      async (directory: string) => {
        await chmod(directory, 0o755);
        await rm(join(directory, "SKILL.md"));
        await symlink("/etc/passwd", join(directory, "SKILL.md"));
        await chmod(directory, 0o555);
      }
    ],
    [
      "a writable file",
      async (directory: string) => {
        await chmod(join(directory, "SKILL.md"), 0o644);
      }
    ]
  ])("fills a folder with %s again before it is mounted", async (_, corrupt) => {
    const { cache, reads } = await cacheWith(() => FOLDER);
    const first = await cache.acquire(instance, [mount()]);
    first.release();
    const directory = first.folders[0]?.directory ?? "";
    const sound = await tree(directory);
    await corrupt(directory);
    expect(await tree(directory)).not.toEqual(sound);

    const second = await cache.acquire(instance, [mount()]);
    second.release();
    expect(reads).toHaveLength(2);
    expect(second.folders[0]?.directory).toBe(directory);
    expect(await tree(directory)).toEqual(sound);
  });

  it.each([
    ["a parent segment", "../escape.txt"],
    ["a parent segment inside", "scripts/../../escape.txt"],
    ["an absolute path", "/etc/cron.d/escape"],
    ["an empty segment", "scripts//x.py"],
    ["a current segment", "./SKILL.md"],
    ["a drive", "C:/x"],
    ["a backslash", "scripts\\..\\x"],
    ["a control character", "scripts/x\n.py"],
    ["an empty path", ""]
  ])("refuses a folder with %s, and leaves nothing to mount", async (_, path) => {
    const { cache, root } = await cacheWith(() => [...FOLDER, file(path, "x")]);
    await expect(cache.acquire(instance, [mount()])).rejects.toMatchObject({
      code: "WORKSPACE_SKILL_MOUNT_FAILED",
      details: { reason: "skill_mount_failed", skill: "form", cause: "invalid_path" }
    });
    expect(await filesBelow(root)).toEqual([]);
  });

  it("refuses a folder whose bytes are not their hash, two files of one path, or a file below a file", async () => {
    const wrong = { ...file("SKILL.md", "x"), sha256: sha256("other") };
    for (const [files, cause] of [
      [[wrong], "hash_mismatch"],
      [[...FOLDER, file("SKILL.md", "again")], "invalid_path"],
      [[file("SKILL.md", "x"), file("SKILL.md/inner", "y")], "not_written"]
    ] as const) {
      const { cache, root } = await cacheWith(() => [...files]);
      await expect(cache.acquire(instance, [mount()])).rejects.toMatchObject({
        details: { skill: "form", cause }
      });
      expect(await filesBelow(root)).toEqual([]);
    }
  });

  it("refuses a name that is no single folder name before anything is read", async () => {
    const { cache, reads } = await cacheWith(() => FOLDER);
    for (const name of ["../form", "a/b", ".hidden", "", "-x", "x".repeat(129)]) {
      await expect(cache.acquire(instance, [mount({ name })])).rejects.toMatchObject({
        details: { cause: "invalid_mount" }
      });
    }
    await expect(cache.acquire(instance, [mount(), mount({ revision: 2 })])).rejects.toMatchObject({
      details: { cause: "invalid_mount" }
    });
    await expect(
      cache.acquire(instance, [mount({ sourceVersion: "sha256:../../x" })])
    ).rejects.toMatchObject({ details: { cause: "invalid_mount" } });
    expect(reads).toEqual([]);
  });

  it("fails with the skill's name where the reader refuses the revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-mount-cache-"));
    roots.push(root);
    const cache = new SkillFolderCache({
      rootDirectory: root,
      reader: { read: () => Promise.reject(new Error(`no revision at ${root}`)) }
    });
    const failure = await cache.acquire(instance, [mount()]).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "WORKSPACE_SKILL_MOUNT_FAILED",
      category: "runner_error",
      details: { reason: "skill_mount_failed", skill: "form", cause: "not_readable" }
    });
    // No path of the worker is told to the agent.
    expect(JSON.stringify(failure)).not.toContain(root);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").not.toContain(root);
  });

  it("evicts the folders no command used for the time of hydrated workspaces, not one in use", async () => {
    const { cache, root } = await cacheWith(() => FOLDER);
    const idle = await cache.acquire(instance, [mount()]);
    idle.release();
    const held = await cache.acquire(instance, [mount({ revision: 2 })]);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const lease of [idle, held]) {
      const entry = dirname(lease.folders[0]?.directory ?? "");
      await utimes(entry, hourAgo, hourAgo);
    }
    expect(await cache.evictIdle({ olderThanMs: 30 * 60 * 1000 })).toEqual({
      removedCount: 1,
      failedCount: 0
    });
    await expect(lstat(idle.folders[0]?.directory ?? "")).rejects.toThrow();
    expect((await lstat(held.folders[0]?.directory ?? "")).isDirectory()).toBe(true);
    held.release();
    expect(await cache.evictIdle({ olderThanMs: 30 * 60 * 1000 })).toEqual({
      removedCount: 1,
      failedCount: 0
    });
    expect(await filesBelow(root)).toEqual([]);
  });

  it("never removes an entry a command acquires while an eviction is deciding on it", async () => {
    const { cache } = await cacheWith(() => FOLDER);
    const filled = await cache.acquire(instance, [mount()]);
    filled.release();
    const folder = filled.folders[0]?.directory ?? "";
    const entry = dirname(folder);
    const expected = await tree(folder);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(entry, hourAgo, hourAgo);
    // The eviction is held in its look at the entry's age, after it saw the entry unused.
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    let reached: () => void = () => undefined;
    const atAge = new Promise<void>((resolve) => (reached = resolve));
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => (open = resolve));
    vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
      const info = await actual.lstat(path, options);
      if (path === entry) {
        vi.mocked(fs.lstat).mockImplementation(actual.lstat);
        reached();
        await opened;
      }
      return info;
    });
    const eviction = cache.evictIdle({ olderThanMs: 30 * 60 * 1000 });
    await atAge;
    // A command acquires the entry while the eviction waits, and the eviction then goes on.
    const lease = await cache.acquire(instance, [mount()]);
    open();
    await eviction;

    expect(await tree(lease.folders[0]?.directory ?? "")).toEqual(expected);
    lease.release();
  });

  it("fails with the skill's name and no path where the worker's disk refuses the folder", async () => {
    const parent = await mkdtemp(join(tmpdir(), "skill-mount-cache-"));
    roots.push(parent);
    // The cache's root is below a file: every write of the worker fails.
    const blocked = join(parent, "not-a-folder");
    await writeFile(blocked, "");
    const cache = new SkillFolderCache({
      rootDirectory: join(blocked, "cache"),
      reader: { read: () => Promise.resolve(FOLDER) }
    });
    const failure = await cache.acquire(instance, [mount()]).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "WORKSPACE_SKILL_MOUNT_FAILED",
      details: { reason: "skill_mount_failed", skill: "form" }
    });
    expect(JSON.stringify(failure)).not.toContain(parent);
    expect(failure instanceof Error ? failure.message : "").not.toContain(parent);
  });
});

describe("the container of a command with skill folders", () => {
  const input = (
    skillFolders: WorkspaceCommandProcessInput["skillFolders"],
    scratchBytes?: number
  ): WorkspaceCommandProcessInput => ({
    command: { id: "wcmd_skills", command: "ls /skills", limits: { timeoutSeconds: 60 } },
    ...(scratchBytes === undefined
      ? {}
      : { sandboxLimits: { cpuCount: 1, memoryBytes: 1024, pidsLimit: 8, scratchBytes } }),
    skillFolders,
    workspaceDirectory: "/host/workspace",
    workspaceCwd: ".",
    cwd: "/host/workspace",
    tempDirectory: "/host/tmp",
    env: {}
  });
  const options = {
    image: "runner:test",
    runnerUser: { uid: 10001, gid: 10001, receivesWorkspace: false },
    createContainerName: () => "skills"
  };
  const mounts = (args: string[]) =>
    args.flatMap((arg, at) => (arg === "--mount" ? [args[at + 1] ?? ""] : []));

  it.each([undefined, 1024 * 1024])(
    "binds each folder read-only at /skills/<name> and keeps no network (scratch %s)",
    (scratch) => {
      const { args } = createDockerRunInvocation(
        input(
          [
            { name: "form", directory: "/cache/a/b/folder" },
            { name: "pdf.tools", directory: "/cache/a/c/folder" }
          ],
          scratch
        ),
        options
      );
      expect(mounts(args).filter((value) => value.includes("/skills"))).toEqual([
        "type=bind,source=/cache/a/b/folder,target=/skills/form,readonly",
        "type=bind,source=/cache/a/c/folder,target=/skills/pdf.tools,readonly"
      ]);
      expect(args[args.indexOf("--network") + 1]).toBe("none");
      expect(args).toContain("--read-only");
      // The working directory and the change scan stay on /workspace.
      expect(args[args.indexOf("--workdir") + 1]).toBe("/workspace");
    }
  );

  it("binds nothing at /skills for a command without skill folders", () => {
    for (const folders of [undefined, []]) {
      const { args } = createDockerRunInvocation(input(folders), options);
      expect(mounts(args).join(" ")).not.toContain("/skills");
      expect(mounts(args)).toHaveLength(1);
    }
  });

  it.each([
    [{ name: "../etc", directory: "/cache/x" }],
    [{ name: "a/b", directory: "/cache/x" }],
    [{ name: ".hidden", directory: "/cache/x" }],
    [{ name: "form", directory: "relative/folder" }],
    [{ name: "form", directory: "/cache/x,target=/workspace" }],
    [{ name: "form", directory: '/cache/"x' }],
    [{ name: "form", directory: "/cache/x\nreadonly=false" }],
    [
      { name: "form", directory: "/cache/x" },
      { name: "form", directory: "/cache/y" }
    ]
  ])("refuses a folder that could name another target or option: %j", (...folders) => {
    expect(() => createDockerRunInvocation(input(folders), options)).toThrow(/cannot be mounted/u);
  });
});

async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path));
    }
  };
  await walk(root);
  return found;
}

describe("which skills a workspace command records", () => {
  const skill = (name: string): SkillConfig => ({
    name,
    title: name,
    description: `Use for ${name}.`,
    content: `# ${name}`
  });
  const skills = ["form", "offered", "secret", "draft-only"].map(skill);
  const agents = [
    agent("assistant", { toolNames: ["workspace.exec"], skillNames: ["form", "deleted"] }),
    agent("other", { skillNames: ["secret"] })
  ] as AgentConfig[];
  const source = createStaticConfigAssetSource({ agents, skills });
  const conversationOffer = {
    offerOf: () => Promise.resolve({ toolNames: [], skillNames: ["offered"] })
  };
  const context = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
    clientInstanceId: instance,
    correlationId: "corr",
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId: instance,
      authSource: "test"
    },
    toolRequest: {
      toolName: "workspace.exec",
      toolCallId: asToolCallId("toolcall_1"),
      agentRunId: asAgentRunId("run_1"),
      conversationId: asConversationId("conv_1"),
      agentName: "assistant",
      input: {}
    },
    ...overrides
  });
  const recorded = (name: string) => ({
    name,
    revision: 1,
    sourceVersion: createSkillSourceVersion(skill(name))
  });

  it("are the agent's and the conversation's offered skills that exist, as read_skill reads them", async () => {
    expect(await runSkillMounts({ assetSource: source, conversationOffer }, context())).toEqual([
      recorded("form"),
      recorded("offered")
    ]);
  });

  it("are the frozen Try draft's alone, with no conversation offer", async () => {
    const draft = agent("assistant", { toolNames: ["workspace.exec"], skillNames: ["draft-only"] });
    const preview = context({
      agentPreview: { agentId: "agent_1", revision: 2, source: "draft", config: draft }
    });
    expect(await runSkillMounts({ assetSource: source, conversationOffer }, preview)).toEqual([
      recorded("draft-only")
    ]);
  });

  it("are none outside an agent run or for a call that names no agent", async () => {
    const base = context();
    const request = base.toolRequest;
    if (!request) throw new Error("No request");
    const { toolRequest: _request, ...withoutRequest } = base;
    const withoutRun = { ...base, toolRequest: { ...request, agentRunId: asAgentRunId("") } };
    const withoutAgent = { ...base, toolRequest: { ...request, agentName: "" } };
    for (const call of [withoutRequest, withoutRun, withoutAgent]) {
      expect(await runSkillMounts({ assetSource: source, conversationOffer }, call)).toEqual([]);
    }
  });
});
