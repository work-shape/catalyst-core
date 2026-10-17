import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A checksum must be known before a Managed File can be written. Spools are private,
// bounded by KNOWLEDGE_FILE_MAX_BYTES in fetch-job, and never read wholly into memory.
// A killed process cannot run finally: its replacement removes only that dead process's
// spools in this Knowledge Base's directory before it resumes the leased work.
function rootOf(clientInstanceId: string, knowledgeBaseId: string): string {
  const owner = createHash("sha256")
    .update(JSON.stringify([clientInstanceId, knowledgeBaseId]))
    .digest("hex");
  return join(tmpdir(), `catalyst-source-${owner}`);
}
export async function removeAbandonedSourceSpools(
  clientInstanceId: string,
  knowledgeBaseId: string
): Promise<void> {
  const root = rootOf(clientInstanceId, knowledgeBaseId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const pid = Number(/^([0-9]+)-/u.exec(entry.name)?.[1]);
    if (!entry.isDirectory() || !Number.isSafeInteger(pid) || pid < 1 || pid === process.pid)
      continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
        await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
}
export async function sourceSpool(
  clientInstanceId: string,
  knowledgeBaseId: string
): Promise<string> {
  const root = rootOf(clientInstanceId, knowledgeBaseId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, `${process.pid}-`));
}
