import { readFile } from "node:fs/promises";
import { RENDERER_MAX_RSS_KIB } from "../protocol";
/** Local renderer watchdog, unrelated to database jobs. It also notices JS that never yields. */
export function watchRendererMemory(
  processes: () => Promise<number[]>,
  exceeded: () => void
): () => void {
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    processes()
      .then(async (ids) => {
        for (const pid of ids) {
          const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
          const rss = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
          if (rss > RENDERER_MAX_RSS_KIB) {
            exceeded();
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* exited */
            }
          }
        }
      })
      .finally(() => {
        checking = false;
      })
      .catch(() => undefined);
  }, 250);
  return () => clearInterval(timer);
}
