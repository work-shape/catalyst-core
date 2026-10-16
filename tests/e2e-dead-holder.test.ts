import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Bound the real-process proof to seconds, far below the 180 s age fallback.
const TAKEOVER_MS = 5_000;
const moduleUrl = new URL("../e2e/instance-turn.ts", import.meta.url).href;

function taker(name: string, baseURL: string, hold: boolean): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `import { takeInstanceTurn } from ${JSON.stringify(moduleUrl)};
     const release = await takeInstanceTurn(${JSON.stringify(name)}, ${JSON.stringify(baseURL)},
       { worker: 7, project: "killed-project", file: "killed.spec.ts", title: "killed test" });
     ${hold ? 'process.stdout.write("held"); setInterval(() => {}, 1000);' : 'await release(); process.stdout.write("taken");'}`
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

it.each(["access", "release-connections"] as const)(
  "takes %s in seconds after SIGKILL and names the dead holder",
  async (name) => {
    const baseURL = `http://lock-${randomUUID()}.test`;
    const lock = join(tmpdir(), `catalyst-e2e-${name}-${baseURL.replace(/\W+/gu, "-")}`);
    const holder = taker(name, baseURL, true);
    let waiter: ChildProcess | undefined;
    try {
      if (!holder.stdout) throw new Error("Holder has no stdout.");
      await once(holder.stdout, "data", { signal: AbortSignal.timeout(TAKEOVER_MS) });
      expect(JSON.parse(await readFile(`${lock}.holder.json`, "utf8"))).toMatchObject({
        pid: holder.pid,
        title: "killed test"
      });
      const exited = once(holder, "exit");
      holder.kill("SIGKILL");
      await exited;
      const started = Date.now();
      waiter = taker(name, baseURL, false);
      let output = "";
      let diagnostics = "";
      waiter.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      waiter.stderr?.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString();
      });
      const [code] = await once(waiter, "exit", { signal: AbortSignal.timeout(TAKEOVER_MS) });
      expect(code, diagnostics).toBe(0);
      expect(output).toBe("taken");
      expect(Date.now() - started).toBeLessThan(TAKEOVER_MS);
      expect(diagnostics).toContain(`Reclaimed dead holder of "${name}"`);
      expect(diagnostics).toContain(`"pid":${holder.pid}`);
      expect(diagnostics).toContain('"title":"killed test"');
    } finally {
      for (const child of [holder, waiter]) {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      await rm(lock, { recursive: true, force: true });
      await rm(`${lock}.holder.json`, { force: true });
    }
  },
  TAKEOVER_MS * 2
);
