// The server of an instance from the built packages, as a deployment runs it: no TypeScript
// loader and no source. For the volume probe of the Workflow engine, which measures the memory
// of this process. With WORKFLOW_PROBE_MEMORY_FILE set it appends what `process.memoryUsage()`
// answers to that file every second; started with `--expose-gc` it collects before each
// sample, so the sample is what the process holds and not what it has yet to give back.
import { appendFileSync } from "node:fs";

const { defineClientInstance } = await import(
  new URL("../../packages/client-assembly/dist/index.js", import.meta.url).href
);

const file = process.env.WORKFLOW_PROBE_MEMORY_FILE;
if (file) {
  const sample = () => {
    globalThis.gc?.();
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...process.memoryUsage() })}\n`);
  };
  sample();
  setInterval(sample, 1_000).unref();
}

const client = defineClientInstance({ rootDir: process.cwd(), loadEnv: false, capabilities: [] });
await client.listen();
