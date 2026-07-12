import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { runConfigCommand, type ConfigCommandName, type ConfigCommandOptions } from "./commands";

export * from "./api";
export * from "./commands";
export * from "./diff";
export * from "./serialization";
export * from "./working-copy";

export interface CliRuntimeOptions {
  cwd?: string;
  fetchImpl?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

const helpText = `Usage: catalyst config <command> [options]

Sync local config assets with a live Catalyst instance.

Commands:
  pull       Replace the local working copy with remote config assets
  push       Replace remote config assets with the local working copy
  diff       Compare canonical remote and local config assets
  validate   Validate local assets and remote references

Options:
  --instance <name-or-url>  Manifest instance name or direct URL
  --dir <working-copy-dir>  Directory containing catalyst.yaml (default: .)
  --force                   Push without optimistic concurrency protection
  --help                    Show this help

Environment:
  CATALYST_API_KEY           API key exchanged for a short-lived access token (preferred)
  CATALYST_SERVER_CREDENTIAL Legacy server credential (deprecated compatibility fallback)
  CHAT_SERVER_CREDENTIAL     Legacy fallback when CATALYST_SERVER_CREDENTIAL is unset
`;

export async function runCli(
  argv: string[],
  runtime: CliRuntimeOptions = {}
): Promise<number> {
  const stdout = runtime.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = runtime.stderr ?? ((text: string) => process.stderr.write(text));
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    stdout(helpText);
    return 0;
  }
  if (argv[0] !== "config") {
    stderr(`Unknown command '${argv[0]}'.\n\n${helpText}`);
    return 2;
  }
  if (argv.length === 1 || argv[1] === "--help" || argv[1] === "-h") {
    stdout(helpText);
    return 0;
  }
  const command = argv[1]!;
  if (!isConfigCommand(command)) {
    stderr(`Unknown config command '${command}'.\n\n${helpText}`);
    return 2;
  }

  try {
    const parsed = parseArgs({
      args: argv.slice(2),
      options: {
        instance: { type: "string" },
        dir: { type: "string" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false }
      },
      allowPositionals: false,
      strict: true
    });
    if (parsed.values.help) {
      stdout(helpText);
      return 0;
    }
    if (parsed.values.force && command !== "push") {
      stderr("--force is only valid with 'catalyst config push'.\n");
      return 2;
    }
    const options: ConfigCommandOptions = {
      cwd: runtime.cwd ?? process.cwd(),
      ...(parsed.values.dir === undefined ? {} : { dir: parsed.values.dir }),
      ...(parsed.values.instance === undefined ? {} : { instance: parsed.values.instance }),
      ...(parsed.values.force ? { force: true } : {}),
      ...(runtime.fetchImpl === undefined ? {} : { fetchImpl: runtime.fetchImpl }),
      ...(runtime.env === undefined ? {} : { env: runtime.env }),
      stdout,
      stderr
    };
    return runConfigCommand(command, options);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function isConfigCommand(value: string): value is ConfigCommandName {
  return value === "pull" || value === "push" || value === "diff" || value === "validate";
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
