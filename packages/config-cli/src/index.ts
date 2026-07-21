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
  pull       Sync remote config assets into the local working copy
  push       Merge local config assets into the remote instance
  diff       Compare canonical remote and local config assets
  validate   Validate local assets and remote references
  list       List local and remote config assets and their sync status
  show       Print a remote asset: show <agent|skill> <name>

Options:
  --instance <name-or-url>  Manifest instance name or direct URL
  --dir <working-copy-dir>  Directory containing catalyst.yaml (default: .)
  --force                   Push without optimistic concurrency protection
  --prune                   Mirror on push, deleting remote-only assets
  --only <agent:name|skill:name>
                            Sync selected assets; repeatable on push/pull
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
        prune: { type: "boolean", default: false },
        only: { type: "string", multiple: true },
        help: { type: "boolean", short: "h", default: false }
      },
      allowPositionals: true,
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
    if (parsed.values.prune && command !== "push") {
      stderr("--prune is only valid with 'catalyst config push'.\n");
      return 2;
    }
    if (parsed.values.only && command !== "push" && command !== "pull") {
      stderr("--only is only valid with 'catalyst config push' or 'catalyst config pull'.\n");
      return 2;
    }
    if (parsed.values.prune && parsed.values.only) {
      stderr("--prune cannot be combined with --only.\n");
      return 2;
    }
    if (command === "show") {
      if (
        parsed.positionals.length !== 2 ||
        (parsed.positionals[0] !== "agent" && parsed.positionals[0] !== "skill")
      ) {
        stderr("Usage: catalyst config show <agent|skill> <name>\n");
        return 2;
      }
    } else if (parsed.positionals.length > 0) {
      stderr(`Unexpected argument '${parsed.positionals[0]}'.\n`);
      return 2;
    }
    const options: ConfigCommandOptions = {
      cwd: runtime.cwd ?? process.cwd(),
      ...(parsed.values.dir === undefined ? {} : { dir: parsed.values.dir }),
      ...(parsed.values.instance === undefined ? {} : { instance: parsed.values.instance }),
      ...(parsed.values.force ? { force: true } : {}),
      ...(parsed.values.prune ? { prune: true } : {}),
      ...(parsed.values.only === undefined ? {} : { only: parsed.values.only }),
      ...(command === "show"
        ? {
            assetKind: parsed.positionals[0] as "agent" | "skill",
            assetName: parsed.positionals[1]!
          }
        : {}),
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
  return (
    value === "pull" ||
    value === "push" ||
    value === "diff" ||
    value === "validate" ||
    value === "list" ||
    value === "show"
  );
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
