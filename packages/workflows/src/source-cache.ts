import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  utimes,
  writeFile
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  WORKFLOW_SOURCE_DEFAULTS,
  workflowSourcePathIssues,
  type WorkflowSourceLimits,
  type WorkflowSourceTree
} from "./code-step";
import { WorkflowStepFailure } from "./step-failure";

/** Worker-owned immutable exports. Cache entries are never mounted or written by a script. */
export function createWorkflowSourceCache(options: {
  directory: string;
  limits?: WorkflowSourceLimits;
}) {
  const limits = options.limits ?? WORKFLOW_SOURCE_DEFAULTS;
  // Serialise population, eviction and copying: a tree cannot be evicted during a copy.
  let tail: Promise<unknown> = Promise.resolve();
  async function copy(
    tree: WorkflowSourceTree,
    destination: string,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    const issue = workflowSourcePathIssues(tree.files)[0];
    if (issue) throw new WorkflowStepFailure(issue.code, issue.message);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const cacheStat = await lstat(options.directory);
    if (
      !cacheStat.isDirectory() ||
      cacheStat.isSymbolicLink() ||
      (process.getuid && cacheStat.uid !== process.getuid()) ||
      (cacheStat.mode & 0o077) !== 0
    )
      throw new WorkflowStepFailure(
        "code_file_invalid",
        "The source cache must be a private worker-owned directory, never a symlink"
      );
    const key = createHash("sha256").update(tree.hash).digest("hex");
    const held = join(options.directory, key);
    // Validate the disk entry too: never copy a symlink, including a directory symlink.
    async function regularTree(directory: string): Promise<boolean> {
      const stat = await lstat(directory).catch(() => undefined);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
      const walk = async (dir: string): Promise<boolean> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return false;
          if (entry.isDirectory() && !(await walk(join(dir, entry.name)))) return false;
        }
        return true;
      };
      return walk(directory);
    }
    let hit = await regularTree(held);
    if (hit) {
      // A hash-named tree must contain exactly the revision's files, with their sizes.
      for (const file of tree.files) {
        const stat = await lstat(join(held, file.path)).catch(() => undefined);
        if (!stat?.isFile() || stat.size !== file.bytes) {
          hit = false;
          break;
        }
      }
    }
    const bytes = tree.files.reduce((sum, file) => sum + file.bytes, 0);
    if (bytes > limits.cacheBytes) hit = false;
    if (!hit) {
      await rm(held, { recursive: true, force: true });
      await evict(bytes <= limits.cacheBytes ? bytes : 0);
      const fillingRoot = bytes > limits.cacheBytes ? dirname(destination) : options.directory;
      await mkdir(fillingRoot, { recursive: true });
      const temporary = await mkdtemp(join(fillingRoot, ".fill-"));
      try {
        const pending = [...tree.files];
        const writes = await Promise.allSettled(
          Array.from({ length: 8 }, async () => {
            for (let file = pending.shift(); file; file = pending.shift()) {
              signal?.throwIfAborted();
              const content = await tree.readFile(file.path, signal);
              if (!content || content.byteLength !== file.bytes)
                throw new WorkflowStepFailure(
                  "code_file_missing",
                  `The revision has no intact file '${file.path}'`
                );
              const path = join(temporary, file.path);
              await mkdir(dirname(path), { recursive: true });
              await writeFile(path, content, { flag: "wx", mode: 0o444 });
            }
          })
        );
        const failed = writes.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        signal?.throwIfAborted();
        if (bytes > limits.cacheBytes) {
          // Oversized trees run without retention; the cache byte budget is never exceeded.
          await cp(temporary, destination, { recursive: true, errorOnExist: true, force: false });
          await chmod(destination, 0o755);
          return;
        }
        await rename(temporary, held);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    await evict(0, held);
    await utimes(held, new Date(), new Date());
    await cp(held, destination, { recursive: true, errorOnExist: true, force: false });
    await chmod(destination, 0o755);
  }
  async function evict(incoming: number, protectedPath?: string) {
    const entries: { path: string; bytes: number; used: number }[] = [];
    const size = async (path: string): Promise<number> => {
      const stat = await lstat(path);
      if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0;
      let total = 0;
      for (const child of await readdir(path)) total += await size(join(path, child));
      return total;
    };
    for (const name of await readdir(options.directory)) {
      const path = join(options.directory, name);
      if (!/^[a-f0-9]{64}$/u.test(name)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      const stat = await lstat(path);
      entries.push({ path, bytes: await size(path), used: stat.mtimeMs });
    }
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries.sort((a, b) => a.used - b.used)) {
      if (total + incoming <= limits.cacheBytes) break;
      if (entry.path === protectedPath) continue;
      await rm(entry.path, { recursive: true, force: true });
      total -= entry.bytes;
    }
  }
  return {
    copy(tree: WorkflowSourceTree, destination: string, signal?: AbortSignal) {
      const next = tail.then(() => copy(tree, destination, signal));
      tail = next.catch(() => undefined);
      return next;
    }
  };
}
