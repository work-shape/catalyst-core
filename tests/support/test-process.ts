import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";

const TEST_TSCONFIG = fileURLToPath(new URL("../../tsconfig.tests.json", import.meta.url));

/**
 * Bundles a TypeScript file and the platform source it imports into one JavaScript file in
 * `directory`, for a test that starts the file many times. Loading the platform source through
 * the TypeScript loader takes seconds in each process; the bundle starts in under one. The
 * platform packages are read from their source, as the loader reads them, and every other
 * package is imported from where it is installed.
 */
export async function bundleTestProcess(file: URL, directory: string): Promise<URL> {
  const outfile = join(directory, `${basename(fileURLToPath(file), ".ts")}.mjs`);
  await build({
    entryPoints: [fileURLToPath(file)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    conditions: ["development"],
    tsconfig: TEST_TSCONFIG,
    plugins: [installedPackagesExternal],
    logLevel: "silent"
  });
  return pathToFileURL(outfile);
}

/** Leaves each installed package out of a bundle, imported by the path it resolved to. */
const installedPackagesExternal: Plugin = {
  name: "installed-packages-external",
  // esbuild compiles a filter as a Go expression, which has no `u` flag.
  setup(bundle) {
    bundle.onResolve({ filter: new RegExp("^[^./]") }, async (args) => {
      if (args.pluginData === "resolving" || args.path.startsWith("node:")) return undefined;
      const resolved = await bundle.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: "resolving"
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      // A platform package resolves to its source in this repository, outside node_modules.
      return resolved.path.includes("/node_modules/")
        ? { path: resolved.path, external: true }
        : resolved;
    });
  }
};

/**
 * Starts a TypeScript file, or a bundle of one from `bundleTestProcess`, as a process of its
 * own, for a test that watches a process end or ends one. `env` is the whole environment of the
 * process. The caller ends it with `killTestProcess`.
 */
export function startTestProcess(
  file: URL,
  options: {
    args?: string[];
    env: NodeJS.ProcessEnv;
    stdio: ["pipe" | "ignore", "pipe" | "ignore", "pipe" | "inherit"];
  }
): ChildProcess {
  const path = fileURLToPath(file);
  const loader = path.endsWith(".ts") ? ["--conditions=development", "--import", "tsx"] : [];
  return spawn(process.execPath, [...loader, path, ...(options.args ?? [])], {
    // The TypeScript loader is a development dependency of this package, and Node
    // resolves `--import` from the working directory. The loader reads the package paths
    // of the tests from their TypeScript project.
    cwd: fileURLToPath(new URL("../../packages/api-contract/", import.meta.url)),
    env: {
      ...options.env,
      TSX_TSCONFIG_PATH: TEST_TSCONFIG
    },
    stdio: options.stdio
  });
}

/** Ends the process as a crash or the kernel does: at once, with no chance to clean up. */
export async function killTestProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
