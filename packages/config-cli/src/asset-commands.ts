import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  MAX_LIST_LIMIT,
  type AssetSummary,
  type ConfigAssetRevision,
  type PlatformContext
} from "@vivd-catalyst/api-contract";
import type { OperationOutcome } from "@vivd-catalyst/api-client";
import { ConfigApiError, type ConfigApi } from "./api";
import { readAssetSource, readDefinition } from "./asset-sources";
import {
  formatAsset,
  formatAssetList,
  formatContext,
  formatHistory,
  formatKinds,
  formatRefusal,
  formatReferences,
  formatWarnings,
  kindNoun
} from "./asset-output";
import {
  connectApi,
  formatCommandError,
  resolveWorkingDir,
  type ConfigCommandOptions
} from "./command-support";
import { readManifestIfPresent, resolveInstance } from "./working-copy";

// `catalyst context`, `kinds`, `references` and `catalyst <kind> <verb>`: one command per
// operation of the instance, for every kind it registers. A command reads its arguments, sends
// the one call and prints the answer; the instance decides every right, revision and check,
// and its refusal is printed as it gave it.

type AssetKind = PlatformContext["kinds"][number];

/** Exit codes. A call that waits for somebody else's approval changed nothing yet. */
const EXIT = { done: 0, refused: 1, usage: 2, pending: 3 } as const;

const OPTIONS = {
  instance: { type: "string" },
  dir: { type: "string" },
  json: { type: "boolean", default: false },
  workspace: { type: "string" },
  prefix: { type: "string" },
  text: { type: "string" },
  revision: { type: "string" },
  files: { type: "boolean", default: false },
  from: { type: "string" },
  "if-revision": { type: "string" },
  to: { type: "string" },
  mode: { type: "string" },
  personal: { type: "boolean", default: false },
  "available-in": { type: "string", multiple: true },
  none: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false }
} as const;

function parseCommandLine(args: string[]) {
  return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
}

type Values = ReturnType<typeof parseCommandLine>["values"];
type OptionName = keyof typeof OPTIONS;

interface Session {
  api: ConfigApi;
  kind: AssetKind;
  values: Values;
  /** The workspace the call addresses. Left out, it addresses the instance's own assets. */
  scope: { workspaceId?: string };
  options: ConfigCommandOptions;
}

/**
 * What a command line asks. `prepare` reads and checks the arguments before anything is sent,
 * and answers the call to make once the instance is reached.
 */
interface Verb {
  usage: string;
  summary: string;
  /** Whether the verb names one asset. */
  named: boolean;
  /** Options beside `--instance`, `--dir`, `--workspace` and `--json`. */
  flags: readonly OptionName[];
  prepare(values: Values, name: string, cwd: string): (session: Session) => Promise<number>;
}

const COMMON_FLAGS: readonly OptionName[] = ["instance", "dir", "workspace", "json", "help"];

const VERBS: Record<string, Verb> = {
  list: {
    usage: "list [--prefix <text>] [--text <text>]",
    summary: "List the assets of the kind you may read (assets.list)",
    named: false,
    flags: ["prefix", "text"],
    prepare: (values) => async (session) => {
      const items: AssetSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await session.api.read((client) =>
          client.assets.list({
            params: { kind: session.kind.kind },
            query: {
              limit: MAX_LIST_LIMIT,
              ...session.scope,
              ...(values.prefix === undefined ? {} : { prefix: values.prefix }),
              ...(values.text === undefined ? {} : { text: values.text }),
              ...(cursor === undefined ? {} : { cursor })
            }
          })
        );
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return print(session, items, () => formatAssetList(session.kind, items));
    }
  },
  show: {
    usage: "show <name> [--revision draft|published|<n>] [--files]",
    summary: "Print one asset, or one revision of it (assets.get)",
    named: true,
    flags: ["revision", "files"],
    prepare: (values, name) => async (session) => {
      const asset = await session.api.read((client) =>
        client.assets.get({
          params: { kind: session.kind.kind, name },
          query: {
            ...session.scope,
            ...(values.revision === undefined ? {} : { revision: values.revision }),
            ...(values.files ? { files: "true" as const } : {})
          }
        })
      );
      return print(session, asset, () => formatAsset(asset));
    }
  },
  history: {
    usage: "history <name>",
    summary: "List the revisions of one asset, newest first (assets.revisions.list)",
    named: true,
    flags: [],
    prepare: (_values, name) => async (session) => {
      const revisions: ConfigAssetRevision[] = [];
      let cursor: string | undefined;
      do {
        const page = await session.api.read((client) =>
          client.assets.revisions.list({
            params: { kind: session.kind.kind, name },
            query: {
              limit: MAX_LIST_LIMIT,
              ...session.scope,
              ...(cursor === undefined ? {} : { cursor })
            }
          })
        );
        revisions.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return print(session, revisions, () => formatHistory(revisions));
    }
  },
  validate: {
    usage: "validate --from <file>",
    summary: "Check a definition against the instance without writing it (assets.validate)",
    named: false,
    flags: ["from"],
    prepare: (values, _name, cwd) => {
      const from = fromPath(values, cwd, "--from <file>");
      return async (session) => {
        const config = await readDefinition(from);
        const result = await session.api.read((client) =>
          client.assets.validate({
            params: { kind: session.kind.kind },
            body: { config, ...session.scope }
          })
        );
        writeOut(
          session.options,
          session.values.json
            ? JSON.stringify(result, null, 2)
            : result.valid
              ? "Valid."
              : [
                  "Not valid:",
                  ...result.issues.map(
                    (issue) =>
                      `- ${issue.path?.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`
                  )
                ].join("\n")
        );
        return result.valid ? EXIT.done : EXIT.refused;
      };
    }
  },
  put: {
    usage: "put <name> --from <file-or-folder> --if-revision <n|new>",
    summary:
      "Create an asset (--if-revision new) or replace it at the revision you read (assets.put)",
    named: true,
    flags: ["from", "if-revision"],
    prepare: (values, name, cwd) => {
      const expectedRevision = ifRevision(values["if-revision"], true);
      const from = fromPath(values, cwd, "--from <file-or-folder>");
      return async (session) => {
        const source = await readAssetSource(from, session.kind.representation);
        if ("config" in source && source.config.name !== undefined && source.config.name !== name) {
          throw new UsageError(
            `The definition names '${String(source.config.name)}', and the command '${name}'.`
          );
        }
        const body =
          "config" in source
            ? { config: { ...source.config, name }, expectedRevision, ...session.scope }
            : { files: source.files, expectedRevision, ...session.scope };
        const outcome = await session.api.change(
          (client, idempotencyKey) =>
            client.assets.put({ params: { kind: session.kind.kind, name }, body, idempotencyKey }),
          `It may have been written: run 'catalyst ${kindNoun(session.kind)} show ${name}' before sending it again.`
        );
        return settle(session, outcome, (output) => [
          `Wrote ${session.kind.kind} '${name}' at revision ${output.revision}.${session.kind.lifecycle === "draft_published" ? " It is a draft until it is published." : ""}`,
          ...formatWarnings(output.warnings)
        ]);
      };
    }
  },
  publish: {
    usage: "publish <name> --revision <n>",
    summary: "Make one revision the one its users are served (assets.publish)",
    named: true,
    flags: ["revision"],
    prepare: (values, name) => {
      const revision = revisionNumber(required(values.revision, "--revision <n>"));
      return async (session) => {
        const outcome = await session.api.change(
          (client, idempotencyKey) =>
            client.assets.publish({
              params: { kind: session.kind.kind, name },
              body: { revision, ...session.scope },
              idempotencyKey
            }),
          "It may have been applied: run 'show' before sending it again."
        );
        return settle(session, outcome, (output) => [
          `Published revision ${output.publishedRevision} of ${session.kind.kind} '${name}'${output.replacedRevision === undefined ? "" : ` in place of revision ${output.replacedRevision}`}.`
        ]);
      };
    }
  },
  "discard-draft": {
    usage: "discard-draft <name> --if-revision <n>",
    summary: "Move the draft back to the published revision (assets.discard_draft)",
    named: true,
    flags: ["if-revision"],
    prepare: (values, name) => {
      const expectedRevision = ifRevision(values["if-revision"], false);
      return async (session) => {
        const outcome = await session.api.change(
          (client, idempotencyKey) =>
            client.assets.discard_draft({
              params: { kind: session.kind.kind, name },
              body: { expectedRevision, ...session.scope },
              idempotencyKey
            }),
          "It may have been applied: run 'show' before sending it again."
        );
        return settle(session, outcome, (output) => [
          `The draft of ${session.kind.kind} '${name}' is revision ${output.draftRevision} again.`
        ]);
      };
    }
  },
  delete: {
    usage: "delete <name> --if-revision <n>",
    summary: "Delete one asset and keep its revisions (assets.delete)",
    named: true,
    flags: ["if-revision"],
    prepare: (values, name) => {
      const expectedRevision = ifRevision(values["if-revision"], false);
      return async (session) => {
        const outcome = await session.api.change(
          (client, idempotencyKey) =>
            client.assets.delete({
              params: { kind: session.kind.kind, name },
              body: { expectedRevision, ...session.scope },
              idempotencyKey
            }),
          "It may have been applied: run 'history' before sending it again."
        );
        return settle(session, outcome, (output) => [
          `Deleted ${session.kind.kind} '${name}'; its delete is revision ${output.revision}.`,
          ...formatWarnings(output.warnings)
        ]);
      };
    }
  },
  revert: {
    usage: "revert <name> --to <n> --if-revision <n>",
    summary: "Make an earlier revision the content again (assets.revert)",
    named: true,
    flags: ["to", "if-revision"],
    prepare: (values, name) => {
      const revision = revisionNumber(required(values.to, "--to <n>"));
      const expectedRevision = ifRevision(values["if-revision"], false);
      return async (session) => {
        const outcome = await session.api.change(
          (client, idempotencyKey) =>
            client.assets.revert({
              params: { kind: session.kind.kind, name },
              body: { revision, expectedRevision, ...session.scope },
              idempotencyKey
            }),
          "It may have been applied: run 'history' before sending it again."
        );
        return settle(session, outcome, (output) => [
          `Reverted ${session.kind.kind} '${name}' to the content of revision ${revision}; it is revision ${output.revision} now.`,
          ...formatWarnings(output.warnings)
        ]);
      };
    }
  },
  "set-availability": {
    usage:
      "set-availability <name> --mode all|selected [--personal] [--available-in <workspace-id>]...",
    summary: "Set the workspaces one asset is offered in (assets.set_availability)",
    named: true,
    flags: ["mode", "personal", "available-in"],
    prepare: (values, name) => {
      const { mode } = values;
      if (mode !== "all" && mode !== "selected") {
        throw new UsageError("--mode is 'all' or 'selected'.");
      }
      const body = {
        mode: mode === "all" ? ("all" as const) : ("selected" as const),
        personalWorkspaces: values.personal,
        collaborationWorkspaceIds: values["available-in"] ?? []
      };
      return async (session) => {
        const outcome = await session.api.change(
          (client, idempotencyKey) =>
            client.assets.set_availability({
              params: { kind: session.kind.kind, name },
              body,
              idempotencyKey
            }),
          "It may have been applied: run 'show' before sending it again."
        );
        return settle(session, outcome, (output) => [
          `${session.kind.kind} '${name}' is offered in ${output.mode === "all" ? "every workspace" : `${output.personalWorkspaces ? "personal workspaces and " : ""}${output.collaborationWorkspaceIds.length} shared workspaces`}.`
        ]);
      };
    }
  },
  "set-default": {
    usage: "set-default <name> | set-default --none",
    summary: "Set or clear the instance's default asset of the kind (assets.set_default)",
    named: false,
    flags: ["none"],
    prepare: (values, name) => {
      if (values.none === (name !== "")) {
        throw new UsageError("Name the asset, or pass --none to clear the default.");
      }
      const chosen = values.none ? null : name;
      return async (session) => {
        const outcome = await session.api.change(
          (client, idempotencyKey) =>
            client.assets.set_default({
              params: { kind: session.kind.kind },
              body: { name: chosen },
              idempotencyKey
            }),
          "It may have been applied: run 'list' before sending it again."
        );
        return settle(session, outcome, () => [
          chosen === null
            ? `The instance has no default ${session.kind.kind} now.`
            : `'${chosen}' is the instance's default ${session.kind.kind} now.`
        ]);
      };
    }
  }
};

/** The words before the kind that are commands of their own. */
const INSTANCE_COMMANDS = ["context", "kinds", "references"] as const;

/** Runs `catalyst <argv>` for every command but `config`. */
export async function runAssetCommand(
  argv: readonly string[],
  base: Omit<ConfigCommandOptions, "dir" | "instance">
): Promise<number> {
  const [noun = "", ...rest] = argv;
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseCommandLine(rest));
  } catch (error) {
    writeErr(base, `${error instanceof Error ? error.message : String(error)}\n\n${assetHelpText}`);
    return EXIT.usage;
  }
  const options: ConfigCommandOptions = {
    ...base,
    ...(values.dir === undefined ? {} : { dir: values.dir }),
    ...(values.instance === undefined ? {} : { instance: values.instance })
  };
  const instanceCommand = INSTANCE_COMMANDS.find((command) => command === noun);
  const [verbName = "", name = "", ...extra] = positionals;
  if (values.help || (instanceCommand === undefined && verbName === "")) {
    writeOut(options, assetHelpText);
    return EXIT.done;
  }
  try {
    if (instanceCommand !== undefined) {
      if (positionals.length > 0) throw new UsageError(`Unexpected argument '${positionals[0]}'.`);
      refuseFlags(values, COMMON_FLAGS, instanceCommand);
      return await runInstanceCommand(instanceCommand, values, options);
    }
    const verb = VERBS[verbName];
    if (verb === undefined) throw new UsageError(`Unknown command '${noun} ${verbName}'.`);
    refuseFlags(values, [...COMMON_FLAGS, ...verb.flags], verbName);
    if (verb.named && name === "") throw new UsageError(`Usage: catalyst ${noun} ${verb.usage}`);
    if (extra.length > 0 || (!verb.named && verbName !== "set-default" && name !== "")) {
      throw new UsageError(`Unexpected argument '${extra[0] ?? name}'.`);
    }
    const call = verb.prepare(values, name, options.cwd);
    const api = await openInstance(options);
    const context = await api.read((client) => client.platform.context.get());
    return await call({
      api,
      kind: findKind(context.kinds, noun),
      values,
      scope: values.workspace === undefined ? {} : { workspaceId: values.workspace },
      options
    });
  } catch (error) {
    if (error instanceof UsageError) {
      writeErr(options, error.message);
      return EXIT.usage;
    }
    writeErr(
      options,
      error instanceof ConfigApiError ? formatRefusal(error) : formatCommandError(error)
    );
    return EXIT.refused;
  }
}

async function runInstanceCommand(
  command: (typeof INSTANCE_COMMANDS)[number],
  values: Values,
  options: ConfigCommandOptions
): Promise<number> {
  const api = await openInstance(options);
  const json = values.json;
  const out = (value: unknown, text: () => string) =>
    writeOut(options, json ? JSON.stringify(value, null, 2) : text());
  if (command === "references") {
    const references = await api.read((client) => client.platform.references.get());
    out(references, () => formatReferences(references));
  } else {
    const context = await api.read((client) => client.platform.context.get());
    if (command === "kinds") out(context.kinds, () => formatKinds(context.kinds));
    else out(context, () => formatContext(context));
  }
  return EXIT.done;
}

/**
 * The client of the instance the command names: `--instance` as a URL, or as an instance of
 * the working copy's `catalyst.yaml`, or the working copy's default instance. The key is the
 * one every command signs in with (`connectApi`).
 */
async function openInstance(options: ConfigCommandOptions): Promise<ConfigApi> {
  const manifest = await readManifestIfPresent(resolveWorkingDir(options));
  const instance = resolveInstance(
    manifest ?? { instances: {}, agents: [], skills: [] },
    options.instance
  );
  return connectApi(instance.url, options);
}

/** The kind a noun names: its id, its plural, or either with dashes for underscores. */
function findKind(kinds: readonly AssetKind[], noun: string): AssetKind {
  const wanted = noun.replaceAll("-", "_");
  const kind = kinds.find((candidate) => candidate.kind === wanted || candidate.plural === wanted);
  if (kind === undefined) {
    throw new UsageError(
      `The instance has no asset kind '${noun}' you can reach. Its kinds: ${kinds.map(kindNoun).join(", ")}.`
    );
  }
  return kind;
}

/** Prints what a changing call answered, or that it waits and has changed nothing yet. */
function settle<Output>(
  session: Session,
  outcome: OperationOutcome<Output, { id: string }>,
  lines: (output: Output) => string[]
): number {
  if (outcome.status === "pending_approval") {
    const text = `Waits for an approval on the instance; nothing has changed yet (Operation Run ${outcome.run.id}).`;
    if (session.values.json)
      writeOut(
        session.options,
        JSON.stringify({ status: "pending_approval", run: outcome.run }, null, 2)
      );
    else writeErr(session.options, text);
    return EXIT.pending;
  }
  if (session.values.json) writeOut(session.options, JSON.stringify(outcome.output, null, 2));
  else writeOut(session.options, lines(outcome.output).join("\n"));
  return EXIT.done;
}

function print(session: Session, value: unknown, text: () => string): number {
  writeOut(session.options, session.values.json ? JSON.stringify(value, null, 2) : text());
  return EXIT.done;
}

/** `--if-revision`: the revision the caller read, or `new` where it creates the asset. */
function ifRevision(value: string | undefined, creates: true): number | null;
function ifRevision(value: string | undefined, creates: false): number;
function ifRevision(value: string | undefined, creates: boolean): number | null {
  const named = required(value, creates ? "--if-revision <n|new>" : "--if-revision <n>");
  if (creates && named === "new") return null;
  return revisionNumber(named);
}

function revisionNumber(value: string): number {
  if (!/^[1-9]\d{0,8}$/u.test(value)) throw new UsageError(`'${value}' is no revision number.`);
  return Number(value);
}

/** `--from`, against the folder the command runs in. */
function fromPath(values: Values, cwd: string, flag: string): string {
  return resolve(cwd, required(values.from, flag));
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new UsageError(`Missing ${flag}.`);
  return value;
}

function refuseFlags(values: Values, allowed: readonly OptionName[], command: string): void {
  for (const [flag, value] of Object.entries(values)) {
    const given = value !== undefined && value !== false;
    if (given && !allowed.some((name) => name === flag)) {
      throw new UsageError(`--${flag} is not an option of '${command}'.`);
    }
  }
}

/** A command line this tool cannot run. Nothing was sent. */
class UsageError extends Error {}

function writeOut(target: Pick<ConfigCommandOptions, "stdout">, text: string): void {
  (target.stdout ?? ((value: string) => process.stdout.write(value)))(`${text}\n`);
}

function writeErr(target: Pick<ConfigCommandOptions, "stderr">, text: string): void {
  (target.stderr ?? ((value: string) => process.stderr.write(value)))(`${text}\n`);
}

export const assetHelpText = `Usage: catalyst <command> [options]

Instance:
  context                   The instance, your rights on it and its asset kinds (platform.context.get)
  kinds                     The asset kinds: their command word, lifecycle and rights
  references                Models, efforts and tools a definition may name (platform.references.get)

Assets, for every kind the instance registers (agent, skill, app, workflow, data-store, ...):
${Object.values(VERBS)
  .map((verb) => `  catalyst <kind> ${verb.usage}\n      ${verb.summary}`)
  .join("\n")}

Options:
  --instance <name-or-url>  An instance of catalyst.yaml, or its URL
  --dir <working-copy-dir>  Directory containing catalyst.yaml (default: .)
  --workspace <id>          Address the assets one workspace owns
  --json                    Print the instance's answer as JSON
  --help                    Show this help

The instance decides every right and every check, and a refusal is printed as it gave it.
A write names the revision it was made against: read it with 'show' or 'history'.
Exit codes: 0 done, 1 refused or failed, 2 usage, 3 waits for an approval (nothing changed yet).
`;
