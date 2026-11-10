import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type ConfigCliEnv, environmentUpdatedFrom, readConfigCliEnv } from "./env";
import { CliVersionError, releaseVersionOf } from "./instance-output";

/** The package that is installed. Fixed: nothing the instance answers names another. */
const PACKAGE = "@work-shape/catalyst-cli";
/** The longest an install may take before it counts as failed. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** What the self-update touches of the computer. Tests pass one that touches nothing. */
export interface SelfUpdateHost {
  /** The arguments of the command, run again after the update. */
  argv: readonly string[];
  env: ConfigCliEnv;
  /** Whether a person is at the terminal: standard input and standard error are both one. */
  interactive: boolean;
  platform: NodeJS.Platform;
  execPath: string;
  /** The folder of the package this process runs from. */
  packageRoot: string;
  exists: (path: string) => boolean;
  readText: (path: string) => string | undefined;
  realpath: (path: string) => string;
  /**
   * Runs a program without a shell and captures its output; with `againFrom`, the command run
   * again, on the terminal, told the version it was updated from.
   */
  run: (file: string, args: readonly string[], options: { againFrom?: string }) => Ran;
  stderr: (text: string) => void;
  exit: (code: number) => never;
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** A person at a terminal, no CI, no opt-out, and not already the command run again. */
function mayUpdateItself(env: ConfigCliEnv, interactive: boolean): boolean {
  return (
    interactive &&
    !isSet(env.CATALYST_NO_AUTO_UPDATE) &&
    !isSet(env.CI) &&
    env.CATALYST_CLI_UPDATED_FROM === undefined
  );
}

type Installation = { kind: "project"; folder: string; command: string } | { kind: "elsewhere" };

/**
 * A CLI that a project installed: the folder before the first `node_modules` of its path holds
 * a `package.json` and is no npx or pnpm dlx cache. Answers the command that installs the
 * version there with the project's package manager.
 */
function projectInstallation(host: SelfUpdateHost, version: string): Installation {
  const path = host.platform === "win32" ? win32 : posix;
  const parts = host.packageRoot.split(path.sep);
  const first = parts.indexOf("node_modules");
  if (first <= 0 || parts.includes("_npx") || parts.includes("dlx")) return { kind: "elsewhere" };
  const folder = parts.slice(0, first).join(path.sep) || path.sep;
  if (!host.exists(path.join(folder, "package.json"))) return { kind: "elsewhere" };
  const spec = `${PACKAGE}@${version}`;
  const command = host.exists(path.join(folder, "pnpm-lock.yaml"))
    ? `pnpm add --save-exact ${spec}`
    : host.exists(path.join(folder, "yarn.lock"))
      ? `yarn add --exact ${spec}`
      : `npm install --save-exact ${spec}`;
  return { kind: "project", folder, command };
}

/**
 * How to run npm without a shell: the npm that ships with this Node, run by this Node, which
 * also covers Windows, where `npm.cmd` cannot be started without one. Elsewhere `npm` on PATH.
 */
export function npmCommand(host: SelfUpdateHost): { file: string; args: string[] } | undefined {
  const path = host.platform === "win32" ? win32 : posix;
  const bin = path.dirname(host.execPath);
  const script = [
    path.join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ].find((candidate) => host.exists(candidate));
  if (script) return { file: host.execPath, args: [script] };
  return host.platform === "win32" ? undefined : { file: "npm", args: [] };
}

function lastErrorLine(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  // npm's first error line names the cause; its last only points at the log.
  const line =
    lines.find((entry) => /^npm (?:error|ERR!)/u.test(entry) && !/complete log/u.test(entry)) ??
    lines.at(-1);
  return line === undefined ? "npm gave no reason" : line.slice(0, 200);
}

const manifestSchema = z.object({
  version: z.string().optional(),
  bin: z.object({ catalyst: z.string().optional() }).optional()
});

/** The version and entry of the package now installed at this CLI's folder. */
function installedVersion(host: SelfUpdateHost): { version?: string; bin?: string } {
  const path = host.platform === "win32" ? win32 : posix;
  let parsed: unknown;
  try {
    parsed = JSON.parse(host.readText(path.join(host.packageRoot, "package.json")) ?? "{}");
  } catch {
    return {};
  }
  const manifest = manifestSchema.safeParse(parsed);
  if (!manifest.success) return {};
  return {
    ...(manifest.data.version === undefined ? {} : { version: manifest.data.version }),
    ...(manifest.data.bin?.catalyst === undefined ? {} : { bin: manifest.data.bin.catalyst })
  };
}

/**
 * On a CLI that does not match its instance: installs the instance's version of the CLI where
 * this one is installed globally and runs the same command again, once, with one line saying
 * so. Answers the error to report where it did not: today's, or for a project's CLI the
 * project's install command.
 */
export function updateToServerVersion(
  mismatch: CliVersionError,
  host: SelfUpdateHost
): CliVersionError {
  const version = releaseVersionOf(mismatch.serverVersion);
  if (version === undefined) return mismatch;
  const project = projectInstallation(host, version);
  if (project.kind === "project") {
    return new CliVersionError(
      mismatch.cliVersion,
      mismatch.serverVersion,
      `in ${project.folder} run: ${project.command}`
    );
  }
  if (!mayUpdateItself(host.env, host.interactive)) return mismatch;
  const npm = npmCommand(host);
  if (npm === undefined) return mismatch;
  const path = host.platform === "win32" ? win32 : posix;
  // Only the global install npm manages is replaced; any other copy stays as it is.
  const root = host.run(npm.file, [...npm.args, "root", "--global"], {});
  const globalRoot = root.status === 0 ? root.stdout.trim() : "";
  let ours: boolean;
  try {
    ours =
      globalRoot !== "" &&
      host.realpath(path.join(globalRoot, ...PACKAGE.split("/"))) ===
        host.realpath(host.packageRoot);
  } catch {
    ours = false;
  }
  if (!ours) return mismatch;

  host.stderr(
    `The instance runs ${version}; installing ${PACKAGE}@${version} in place of ${mismatch.cliVersion} and running the command again.\n`
  );
  const install = host.run(
    npm.file,
    [
      ...npm.args,
      "install",
      "--global",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
      `${PACKAGE}@${version}`
    ],
    {}
  );
  const installed = installedVersion(host);
  if (install.status !== 0 || installed.version !== version) {
    host.stderr(
      `Could not install ${PACKAGE}@${version}: ${lastErrorLine(`${install.stdout}\n${install.stderr}`)}\n`
    );
    return mismatch;
  }
  const entry = path.resolve(host.packageRoot, installed.bin ?? "dist/index.js");
  if (!entry.startsWith(host.packageRoot + path.sep)) return mismatch;
  const again = host.run(host.execPath, [entry, ...host.argv], {
    againFrom: mismatch.cliVersion
  });
  return host.exit(again.status ?? 1);
}

let attempt: Promise<CliVersionError> | undefined;
let host: SelfUpdateHost | undefined;

/**
 * Called by `instanceFetch` on a version mismatch. Without `enableSelfUpdate`, as for every
 * caller of `runCli` but the `catalyst` command itself, it answers the mismatch unchanged.
 */
export function onCliVersionMismatch(mismatch: CliVersionError): Promise<CliVersionError> {
  if (host === undefined) return Promise.resolve(mismatch);
  const active = host;
  attempt ??= Promise.resolve().then(() => updateToServerVersion(mismatch, active));
  return attempt;
}

/** Turns the self-update on for this process, the `catalyst` command run with `argv`. */
export function enableSelfUpdate(argv: readonly string[]): void {
  host = {
    argv,
    env: readConfigCliEnv(),
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    platform: process.platform,
    execPath: process.execPath,
    packageRoot: realpathSync(fileURLToPath(new URL("..", import.meta.url))).replace(/[\\/]$/u, ""),
    exists: existsSync,
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    realpath: realpathSync,
    run: (file, args, options) => {
      const result = spawnSync(file, args, {
        shell: false,
        windowsHide: true,
        ...(options.againFrom !== undefined
          ? { stdio: "inherit", env: environmentUpdatedFrom(options.againFrom) }
          : { encoding: "utf8", timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
      });
      return {
        status: result.status,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : ""
      };
    },
    stderr: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code)
  };
}
