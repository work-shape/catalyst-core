import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

/**
 * Starts a TypeScript file as a process of its own, for a test that watches a process end or
 * ends one. `env` is the whole environment of the process. The caller ends it with
 * `killTestProcess`.
 */
export function startTestProcess(
  file: URL,
  options: {
    args?: string[];
    env: NodeJS.ProcessEnv;
    stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "inherit"];
  }
): ChildProcess {
  return spawn(
    process.execPath,
    ["--conditions=development", "--import", "tsx", fileURLToPath(file), ...(options.args ?? [])],
    {
      // The TypeScript loader is a development dependency of this package, and Node
      // resolves `--import` from the working directory. The loader reads the package paths
      // of the tests from their TypeScript project.
      cwd: fileURLToPath(new URL("../../packages/api-contract/", import.meta.url)),
      env: {
        ...options.env,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.tests.json", import.meta.url))
      },
      stdio: options.stdio
    }
  );
}

/** Ends the process as a crash or the kernel does: at once, with no chance to clean up. */
export async function killTestProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
