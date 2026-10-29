import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import yaml from "js-yaml";
import { apiOperations, MAX_LIST_LIMIT, type Operation } from "@work-shape/catalyst-api-contract";
import { ConfigApiError, toConfigApiError } from "./api";
import { formatRefusal } from "./asset-output";
import {
  formatCommandError,
  isRecord,
  openInstance,
  writeError,
  type ConfigCommandOptions
} from "./command-support";
import { readStdin, type CommandInput } from "./input";
import { call, printCall } from "./operation-commands";

interface NamedCommand {
  operation: Operation;
  usage: string;
  param?: string;
  optionalName?: boolean;
  listField?: "apps";
  from?: boolean;
  /** What `--from` must hold, for the usage error when it does not. */
  fromShape?: string;
  /** `--sql <statement>` stands for `--from` with `{"sql": "<statement>"}`. */
  sql?: boolean;
  /** The flags that become the query of the call, each with the query field it fills. */
  queryFlags?: Readonly<Partial<Record<QueryFlag, string>>>;
  requiredFlags?: readonly QueryFlag[];
  /**
   * Prints the one page asked for with its `nextCursor`, where the feed is too long to read to
   * its end (audit events, jobs, Operation Runs). `--limit` sets its size, `--cursor` takes the
   * next page.
   */
  onePage?: boolean;
}

/** Every flag that fills a query. A command takes only the ones it names in `queryFlags`. */
const QUERY_FLAG_OPTIONS = {
  table: { type: "string" },
  limit: { type: "string" },
  after: { type: "string" },
  cursor: { type: "string" },
  kind: { type: "string" },
  status: { type: "string" },
  operation: { type: "string" },
  effect: { type: "string" },
  actor: { type: "string" },
  origin: { type: "string" },
  workspace: { type: "string" },
  since: { type: "string" },
  start: { type: "string" },
  end: { type: "string" },
  "group-by": { type: "string" },
  agent: { type: "string" },
  app: { type: "string" },
  workflow: { type: "string" },
  model: { type: "string" }
} as const;
type QueryFlag = keyof typeof QUERY_FLAG_OPTIONS;

function isQueryFlag(flag: string): flag is QueryFlag {
  return Object.hasOwn(QUERY_FLAG_OPTIONS, flag);
}

const QUERY_FLAGS = Object.keys(QUERY_FLAG_OPTIONS).filter(isQueryFlag);

/** The page flags of the feeds that print one page. */
const PAGE_FLAGS = { limit: "limit", cursor: "cursor" } as const;

// Each face names an existing operation. Rights, policy and execution stay in the instance.
const commands: Readonly<Record<string, NamedCommand>> = {
  "workflow test": {
    operation: apiOperations["workflows.test"],
    usage: "workflow test <name> [--from <file|->]",
    param: "workflow",
    from: true,
    fromShape: 'Workflow test input must be a JSON object: {"input": {...}}.'
  },
  "workflow runs": {
    operation: apiOperations["workflows.list_runs"],
    usage: "workflow runs <name>",
    param: "workflow"
  },
  "workflow run": {
    operation: apiOperations["workflows.get_run"],
    usage: "workflow run <run-id>",
    param: "runId"
  },
  "workflow steps": {
    operation: apiOperations["workflows.list_step_runs"],
    usage: "workflow steps <run-id>",
    param: "runId"
  },
  "workflow cancel": {
    operation: apiOperations["workflows.cancel_run"],
    usage: "workflow cancel <run-id>",
    param: "runId"
  },
  "guardrail hits": {
    operation: apiOperations["guardrails.list_hits"],
    usage: "guardrail hits <name>",
    param: "name"
  },
  "knowledge-base check": {
    operation: apiOperations["knowledge_bases.check"],
    usage: "knowledge-base check <name>",
    param: "knowledgeBase"
  },
  "data-store describe": {
    operation: apiOperations["data_stores.describe"],
    usage: "data-store describe <name>",
    param: "store"
  },
  "data-store used-by": {
    operation: apiOperations["data_stores.used_by"],
    usage: "data-store used-by <name>",
    param: "store"
  },
  "app actions": {
    operation: apiOperations["apps.actions.list"],
    usage: "app actions [<name>]",
    optionalName: true,
    listField: "apps"
  },
  "keys list": { operation: apiOperations["me.api_keys.list"], usage: "keys list" },
  "instance workspaces": {
    operation: apiOperations["instance.workspaces.list"],
    usage: "instance workspaces"
  },
  "workflow start": {
    operation: apiOperations["workflows.start"],
    usage: "workflow start <name> [--from <file|->]",
    param: "workflow",
    from: true,
    fromShape:
      'Workflow start input must be a JSON object: {"input": {...}, "key": "<run key>"}; both are optional.'
  },
  "data-store rows": {
    operation: apiOperations["data_stores.rows"],
    usage: "data-store rows <name> --table <table> [--limit <n>] [--after <cursor>]",
    param: "store",
    queryFlags: { table: "table", limit: "limit", after: "after" },
    requiredFlags: ["table"]
  },
  "data-store query": {
    operation: apiOperations["data_stores.query"],
    usage: "data-store query <name> (--sql <statement> | --from <file|->)",
    param: "store",
    from: true,
    sql: true,
    fromShape:
      'Data Store query input must be a JSON object: {"sql": "select ... where id = $1", "parameters": [...]}.'
  },
  "data-store insert": {
    operation: apiOperations["data_stores.insert"],
    usage: "data-store insert <name> --from <file|->",
    param: "store",
    from: true,
    fromShape:
      'Data Store insert input must be a JSON object: {"table": "<table>", "rows": [{...}], "onConflict": "fail|skip"}.'
  },
  "knowledge-base query": {
    operation: apiOperations["knowledge_bases.query"],
    usage: "knowledge-base query <name> (--sql <statement> | --from <file|->)",
    param: "knowledgeBase",
    from: true,
    sql: true,
    fromShape:
      'Knowledge Base query input must be a JSON object: {"sql": "select ..."} or {"query": "<named query>", "parameters": {...}}.'
  },
  // The instance level of a key (CLI-PARITY-6a): read-only, one command per read operation.
  "usage show": { operation: apiOperations["usage.get_summary"], usage: "usage show" },
  "usage breakdown": {
    operation: apiOperations["usage.breakdown.get"],
    usage:
      "usage breakdown --start <YYYY-MM-DD> --end <YYYY-MM-DD> --group-by <dimension> [--workspace <id>] [--agent <name>] [--app <name>] [--workflow <name>] [--model <name>] [--origin <origin>]",
    queryFlags: {
      start: "from",
      end: "to",
      "group-by": "groupBy",
      workspace: "workspace",
      agent: "agent",
      app: "app",
      workflow: "workflow",
      model: "model",
      origin: "origin"
    },
    requiredFlags: ["start", "end", "group-by"]
  },
  "audit events": {
    operation: apiOperations["audit_events.list"],
    usage: "audit events [--limit <n>] [--cursor <cursor>]",
    queryFlags: PAGE_FLAGS,
    onePage: true
  },
  "audit activities": {
    operation: apiOperations["audit_activities.list"],
    usage: "audit activities"
  },
  "jobs summary": { operation: apiOperations["instance.jobs.summary"], usage: "jobs summary" },
  "jobs list": {
    operation: apiOperations["instance.jobs.list"],
    usage:
      "jobs list [--kind <kind>] [--status <status[,status]>] [--limit <n>] [--cursor <cursor>]",
    queryFlags: { ...PAGE_FLAGS, kind: "kind", status: "status" },
    onePage: true
  },
  "operation runs": {
    operation: apiOperations["operations.list_runs"],
    usage:
      "operation runs [--operation <id>] [--effect reading|changing] [--status <status>] [--actor <id>] [--origin <kind>] [--workspace <id>] [--since <timestamp>] [--limit <n>] [--cursor <cursor>]",
    queryFlags: {
      ...PAGE_FLAGS,
      operation: "operation",
      effect: "effect",
      status: "status",
      actor: "actor",
      origin: "origin",
      workspace: "workspaceId",
      since: "since"
    },
    onePage: true
  },
  "modules list": { operation: apiOperations["instance.modules.list"], usage: "modules list" },
  "infrastructure show": {
    operation: apiOperations["instance.infrastructure.get"],
    usage: "infrastructure show"
  },
  "limits show": { operation: apiOperations["usage.limits.get"], usage: "limits show" },
  "limits set": {
    operation: apiOperations["usage.limits.set"],
    usage: "limits set --from <file|->",
    from: true,
    fromShape:
      'Limit input must be a JSON object: {"level": "user", "target": "<user id>", "limits": {"monthly": 50}}; "limits": null removes the value.'
  }
};

export function namedCommandNames(): string[] {
  return Object.keys(commands);
}

export function isNamedCommand(argv: readonly string[]): boolean {
  return Object.hasOwn(commands, `${argv[0]} ${argv[1]}`);
}

/** `keys` and `instance`: the words that only lead named operations, for their help. */
export function isNamedNoun(noun: string | undefined): boolean {
  // `operation` leads `operation show` of the asset commands too, which keep its bare help.
  return (
    noun !== "operation" && Object.keys(commands).some((command) => command.split(" ")[0] === noun)
  );
}

class UsageError extends Error {}

export async function runNamedCommand(
  argv: readonly string[],
  base: ConfigCommandOptions & { stdin?: CommandInput }
): Promise<number> {
  try {
    const command = commands[`${argv[0]} ${argv[1]}`];
    if (!command) throw new UsageError("Unknown command. See 'catalyst --help'.");
    let parsed;
    try {
      parsed = parseArgs({
        args: argv.slice(2),
        options: {
          instance: { type: "string" },
          dir: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
          from: { type: "string" },
          sql: { type: "string" },
          ...QUERY_FLAG_OPTIONS
        },
        allowPositionals: true,
        strict: true
      });
    } catch {
      throw new UsageError(`Usage: catalyst ${command.usage}`);
    }
    const { values, positionals } = parsed;
    if (values.help) {
      base.stdout?.(`Usage: catalyst ${command.usage}\n${command.operation.summary}\n`);
      return 0;
    }
    const [name] = positionals;
    const count = command.param ? 1 : 0;
    if (
      (command.optionalName ? positionals.length > 1 : positionals.length !== count) ||
      (name !== undefined && name === "") ||
      (!command.from && values.from !== undefined) ||
      (!command.sql && values.sql !== undefined) ||
      (values.sql !== undefined && values.from !== undefined) ||
      QUERY_FLAGS.some(
        (flag) => values[flag] !== undefined && !Object.hasOwn(command.queryFlags ?? {}, flag)
      ) ||
      (command.requiredFlags ?? []).some((flag) => !values[flag])
    ) {
      throw new UsageError(`Usage: catalyst ${command.usage}`);
    }
    let body: unknown;
    if (command.from) {
      const source = values.from;
      const text =
        values.sql !== undefined
          ? JSON.stringify({ sql: values.sql })
          : source === undefined
            ? "{}"
            : source === "-"
              ? await readStdin(base.stdin ?? process.stdin)
              : await readFile(resolve(base.cwd, source), "utf8");
      try {
        const input: unknown = JSON.parse(text);
        // This is the operation's request body, not the generic call envelope.
        body = command.operation.body?.parse(input);
      } catch {
        throw new UsageError(command.fromShape ?? `Usage: catalyst ${command.usage}`);
      }
    }
    const options = { ...base, instance: values.instance, dir: values.dir };
    const { api } = await openInstance(options);
    const params =
      command.param !== undefined && name !== undefined ? { [command.param]: name } : undefined;
    const query: Record<string, string> = {
      ...(command.optionalName && name !== undefined ? { app: name } : {}),
      ...Object.fromEntries(
        Object.entries(command.queryFlags ?? {}).flatMap(([flag, field]) => {
          const value = isQueryFlag(flag) ? values[flag] : undefined;
          return value === undefined ? [] : [[field, value] as const];
        })
      )
    };
    let result: unknown;
    const listField =
      command.onePage === true
        ? undefined
        : command.operation.response.kind === "page"
          ? "items"
          : name === undefined
            ? command.listField
            : undefined;
    if (listField !== undefined) {
      const items: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = await call(api, command.operation, {
          params,
          query: { ...query, limit: MAX_LIST_LIMIT, ...(cursor === undefined ? {} : { cursor }) }
        });
        if (!isRecord(page) || !Array.isArray(page[listField]))
          throw new Error("Invalid list response.");
        items.push(...page[listField]);
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      } while (cursor !== undefined);
      result = listField === "apps" ? { apps: items, truncated: false } : items;
    } else {
      result = await call(api, command.operation, { params, query, body });
    }
    return await printCall(
      options,
      command.operation,
      result,
      values.json
        ? undefined
        : (value) => yaml.dump(value, { lineWidth: -1, noRefs: true }).trimEnd()
    );
  } catch (error) {
    const converted = toConfigApiError(error);
    writeError(
      base,
      converted instanceof ConfigApiError ? formatRefusal(converted) : formatCommandError(converted)
    );
    return error instanceof UsageError ? 2 : 1;
  }
}

export const namedHelpText = `Named operations (readable output by default; --json for JSON):
${Object.values(commands)
  .map((command) => `  ${command.usage} (${command.operation.id})`)
  .join("\n")}

Workflow test and start --from read the request body {"input": {...}}; omitted, it sends {}.
workflow start runs the published Workflow and needs workflow.use on the key. data-store
rows, query and insert and knowledge-base query need the key's use level (Verwenden): name
data_store.execute (rows, query), data_store.insert (insert) or knowledge_base.use (knowledge-base
query), as well as data_store.read for rows and query. Each is limited to the workspace and
asset the key's scope names. A refusal names what the key lacks.
usage show and breakdown, audit events and activities, jobs summary and list, operation runs,
modules list and infrastructure show read the instance and need the key's read-only instance
level: the key names usage.view (usage), audit.view (audit), or system.view (jobs, operation
runs, modules, infrastructure), and you hold the same right yourself at the moment of the call.
The key catalyst setup creates does not carry it; tick it when you issue a key in Settings > API
keys. audit events and activities show the instance's minimized governance events, never a
payload; operation runs show hashes of inputs, never inputs. The three feeds (audit events,
jobs list, operation runs) print one page, 50 entries unless --limit says otherwise (up to 200),
with the nextCursor for --cursor. Reading another person's Operation Run by id (operation show)
needs audit.view on the key.
Lists read every page. instance workspaces shows Shared Workspaces for agent availability
and needs config_assets:write and agent.write; it is not the membership list.
Options: --instance <name-or-url>, --dir <working-copy-dir>, --json, --help
Exit codes: 0 done, 1 refused or failed, 2 usage, 3 waits for approval.
`;
