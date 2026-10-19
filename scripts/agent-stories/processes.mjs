import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Cleanup escalates only against process groups created by this invocation.
const DRAIN_MS = 5_000;
export class Processes {
  children = new Set();
  failure = undefined;
  stopping = false;
  constructor(cwd, env = process.env) {
    this.cwd = cwd;
    this.env = env;
  }
  start(command, args, label, env = this.env, cwd = this.cwd) {
    if (this.stopping || this.failure) throw new Error("Child supervisor stopped");
    this.phase = label;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    this.children.add(child);
    const completion = new Promise((resolve, reject) => {
      child.once("error", () => reject(new Error(`${label}: spawn failed`)));
      child.once("exit", (code, signal) => {
        this.children.delete(child);
        if (code === 0) resolve();
        else reject(new Error(`${label}: exit ${code ?? signal}`));
      });
    });
    completion.catch((error) => {
      if (!this.stopping) this.failure = error;
    });
    return { child, completion, label };
  }
  async run(command, args, label, env, cwd) {
    await this.start(command, args, label, env, cwd).completion;
    this.check();
  }
  check() {
    if (this.failure) throw this.failure;
    if (this.stopping) throw new Error("Invocation stopped");
  }
  release() {
    for (const child of this.children) child.unref();
    this.children.clear();
  }
  async stop() {
    this.stopping = true;
    const children = [...this.children];
    const signal = (sig) => {
      for (const child of children) {
        try {
          process.kill(-child.pid, sig);
        } catch {}
      }
    };
    signal("SIGTERM");
    const deadline = Date.now() + DRAIN_MS;
    while (
      children.some((c) => c.exitCode === null && c.signalCode === null) &&
      Date.now() < deadline
    )
      await delay(25);
    signal("SIGKILL");
    this.children.clear();
  }
}
export async function until(read, accept, deadline, check = () => {}) {
  while (Date.now() < deadline) {
    check();
    const value = await read();
    if (accept(value)) return value;
    await delay(250);
  }
  throw new Error("Condition deadline exceeded");
}
