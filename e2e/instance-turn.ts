import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reclaim an unidentifiable or stalled holder after this budget; live queues have no deadline.
const ACCESS_STATE_WAIT_MS = 180_000;
// A waiter checks for a released or dead holder four times per second.
const POLL_MS = 250;
const pause = () => new Promise((resolve) => setTimeout(resolve, POLL_MS));

/**
 * Waits for a turn on something of the instance that only one test may hold at a time, and
 * answers with what ends the turn. The specs run side by side in several processes, so the
 * turn is a directory: making one succeeds for one process alone.
 */
export async function takeInstanceTurn(
  name: "access" | "release-connections",
  baseURL: string | undefined,
  holder: { worker: number; project: string; file: string; title: string }
): Promise<() => Promise<void>> {
  const lock = join(tmpdir(), `catalyst-e2e-${name}-${(baseURL ?? "").replace(/\W+/gu, "-")}`);
  // The sidecar keeps the directory empty, so abandoning a lock still uses atomic rmdir.
  const holderPath = `${lock}.holder.json`;
  for (;;) {
    try {
      await mkdir(lock);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
      // Queue time is unbounded: only the age of the current holder matters. Each new
      // holder creates a fresh directory, so progress restarts the abandonment clock.
      const entry = await stat(lock).catch(() => undefined);
      const age = entry === undefined ? undefined : Date.now() - entry.mtimeMs;
      const previous = await readFile(holderPath, "utf8").catch(() => "unavailable");
      let dead = false;
      try {
        const parsed: unknown = JSON.parse(previous);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "pid" in parsed &&
          typeof parsed.pid === "number" &&
          Number.isSafeInteger(parsed.pid) &&
          parsed.pid > 0 &&
          // A prior holder's sidecar can survive briefly after a new mkdir.
          "lockInode" in parsed &&
          parsed.lockInode === entry?.ino
        ) {
          try {
            process.kill(parsed.pid, 0);
          } catch (cause) {
            dead = cause instanceof Error && "code" in cause && cause.code === "ESRCH";
          }
        }
      } catch {
        /* Missing or malformed diagnostics use the age fallback. */
      }
      if (dead || (age !== undefined && age > ACCESS_STATE_WAIT_MS)) {
        try {
          if ((await stat(lock)).ino !== entry?.ino) continue;
          await rmdir(lock);
          console.warn(`Reclaimed ${dead ? "dead" : "expired"} holder of "${name}": ${previous}`);
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
            continue;
          }
          const holder = await readFile(holderPath, "utf8").catch(() => "unavailable");
          throw new Error(
            `The turn "${name}" on the instance could not reclaim a holder older than ${ACCESS_STATE_WAIT_MS} ms: ${lock}. Holder: ${holder}`,
            { cause }
          );
        }
      } else {
        await pause();
      }
      continue;
    }
    try {
      await writeFile(
        holderPath,
        JSON.stringify({
          pid: process.pid,
          ...holder,
          lockInode: (await stat(lock)).ino,
          startedAt: new Date().toISOString()
        })
      );
    } catch (error) {
      await rmdir(lock);
      throw error;
    }
    return async () => {
      await rm(holderPath, { force: true });
      await rmdir(lock).catch(() => undefined);
    };
  }
}
