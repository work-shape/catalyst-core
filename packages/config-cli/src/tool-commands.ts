import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { toolCodeTimeoutSeconds } from "@work-shape/catalyst-asset-schemas";
import { z } from "zod";
import { ConfigApiError, type ConfigApi } from "./api";
import {
  filedForApproval,
  openInstance,
  writeError,
  writeOutput,
  type ConfigCommandOptions
} from "./command-support";
import { formatWarnings } from "./asset-output";
import { readConfigCliEnv, toolHandlerEnv, type ConfigCliEnv } from "./env";
import { EXIT, UsageError, ifRevision, settle } from "./asset-verbs/support";
import type { Values } from "./asset-verbs/types";
import {
  ToolFolderError,
  bundleTool,
  readToolFolder,
  writeToolLibrary,
  type ToolFolder
} from "./tool-folder";

// `catalyst tool put <folder>` and `catalyst tool run <folder>` (TOOL-2d, platform-access.md,
// section 3a): a code tool written as a folder. `put` reads the folder's definition here and
// writes it as the tool's next draft; the instance never runs the code to learn it. `run` runs
// the handler on this computer as the sandbox runs it, with the same library and request
// channel. Its Connection calls go to the instance as calls of a draft, made with the person's
// key: to the test credential where the Connection has one, and simulated where a call would
// change something and it has none.

const TOOL_KIND = "tool";

/** Whether the command line is one of the commands of a tool's folder. */
export function isToolFolderCommand(noun: string, verb: string, values: Values): boolean {
  if (noun !== TOOL_KIND && noun !== `${TOOL_KIND}s`) return false;
  return verb === "run" || (verb === "put" && values.from === undefined);
}

export const TOOL_FOLDER_FLAGS = {
  put: ["instance", "dir", "json", "help", "workspace", "if-revision"],
  run: ["instance", "dir", "json", "help", "input"]
} as const;

/** `catalyst tool put <folder>` or `catalyst tool run <folder>`. */
export async function runToolFolderCommand(
  verb: "put" | "run",
  folderArgument: string,
  values: Values,
  options: ConfigCommandOptions
): Promise<number> {
  if (folderArgument === "") {
    throw new UsageError(
      verb === "put"
        ? "Usage: catalyst tool put <folder> [--if-revision <n|new>]"
        : "Usage: catalyst tool run <folder> [--input <json>]"
    );
  }
  const folder = resolve(options.cwd ?? process.cwd(), folderArgument);
  const env = readConfigCliEnv(options.env);
  try {
    return verb === "put"
      ? await putFolder(folder, values, options, env)
      : await runFolder(folder, values, options, env);
  } catch (error) {
    if (error instanceof ToolFolderError) {
      writeError(options, error.message);
      return EXIT.refused;
    }
    throw error;
  }
}

async function putFolder(
  folder: string,
  values: Values,
  options: ConfigCommandOptions,
  env: ConfigCliEnv
): Promise<number> {
  const expected =
    values["if-revision"] === undefined ? undefined : ifRevision(values["if-revision"], true);
  const tool = await readToolFolder(folder, env);
  const { name } = tool.config;
  const { api, workspace } = await openInstance(options);
  const workspaceId = values.workspace ?? workspace;
  const scope = workspaceId === undefined ? {} : { workspaceId };
  // Left out, the write replaces the revision read now: a folder is the tool's source.
  const expectedRevision =
    expected === undefined ? await latestRevision(api, name, scope) : expected;
  const outcome = await api.change(
    (client, idempotencyKey) =>
      client.assets.put({
        params: { kind: TOOL_KIND, name },
        body: { config: tool.config, expectedRevision, ...scope },
        idempotencyKey
      }),
    `It may have been written: run 'catalyst tool show ${name}' before sending it again.`
  );
  return settle({ values, options }, outcome, (output) => [
    output.approvalRequestId !== undefined
      ? filedForApproval(`tool '${name}'`, output.approvalRequestId, output.revision)
      : `Wrote tool '${name}' as revision ${output.revision} from '${folderLabel(folder, options)}'. Agents call it once it is published: 'catalyst tool publish ${name} --revision ${output.revision}'.`,
    ...formatWarnings(output.warnings)
  ]);
}

async function latestRevision(
  api: ConfigApi,
  name: string,
  scope: { workspaceId?: string }
): Promise<number | null> {
  try {
    const asset = await api.read((client) =>
      client.assets.get({ params: { kind: TOOL_KIND, name }, query: scope })
    );
    return asset.revision;
  } catch (error) {
    if (error instanceof ConfigApiError && error.status === 404) return null;
    throw error;
  }
}

function folderLabel(folder: string, options: ConfigCommandOptions): string {
  const cwd = options.cwd ?? process.cwd();
  return folder.startsWith(`${cwd}/`) ? folder.slice(cwd.length + 1) : folder;
}

/** One request of the handler, as the request channel carries it. */
const channelRequestSchema = z.object({
  connection: z.string().min(1),
  operation: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional()
});
type ChannelRequest = z.infer<typeof channelRequestSchema>;

const objectSchema = z.record(z.string(), z.unknown());
/** What a handler answers. */
const handlerAnswerSchema = z.looseObject({ output: z.unknown(), display: z.unknown() });

type ChannelAnswer =
  | { ok: true; output: unknown; simulated?: true }
  | { ok: false; error: { code: string; message: string } };

function parseInput(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`--input is not JSON: ${text}`);
  }
  const parsed = objectSchema.safeParse(value);
  if (!parsed.success || Array.isArray(value)) {
    throw new UsageError("--input is a JSON object, the tool's input.");
  }
  return parsed.data;
}

async function runFolder(
  folder: string,
  values: Values,
  options: ConfigCommandOptions,
  env: ConfigCliEnv
): Promise<number> {
  const input = parseInput(values.input);
  const tool = await readToolFolder(folder, env, { bundle: false });
  const work = await mkdtemp(join(tmpdir(), "catalyst-tool-run-"));
  const library = join(work, "lib");
  await mkdir(library);
  await writeToolLibrary(library);
  const inputFile = join(work, "input.json");
  const outputFile = join(work, "output.json");
  await writeFile(inputFile, JSON.stringify(input));
  let command: string;
  let args: string[];
  if (tool.config.runtime === "python") {
    command = "python3";
    args = [tool.config.entry];
  } else {
    const bundle = join(work, "tool.mjs");
    await writeFile(
      bundle,
      await bundleTool({
        folder,
        source: tool.source ?? "index.ts",
        ...(tool.exportName === undefined ? {} : { exportName: tool.exportName }),
        library
      })
    );
    command = process.execPath;
    args = ["--enable-source-maps", bundle];
  }
  let instance: Promise<{ api: ConfigApi }> | undefined;
  const connect = () => (instance ??= openInstance(options));
  const ended = await runHandler({
    command,
    args,
    folder,
    input,
    env: {
      ...toolHandlerEnv(env),
      WORKFLOW_INPUT_FILE: inputFile,
      WORKFLOW_OUTPUT_FILE: outputFile,
      CATALYST_LIBRARY: library,
      CATALYST_REQUEST_FD: "3",
      CATALYST_ANSWER_FD: "4",
      PYTHONPATH: [folder, library].join(":")
    },
    timeoutSeconds: toolCodeTimeoutSeconds(tool.config),
    stderr: (text) => (options.stderr ?? process.stderr.write.bind(process.stderr))(text),
    answer: (request) => answerRequest(tool, request, connect)
  });
  const written = await readFile(outputFile, "utf8").catch(() => undefined);
  if (ended.timedOut) {
    writeError(
      options,
      `The handler ran longer than ${toolCodeTimeoutSeconds(tool.config)} seconds and was stopped.`
    );
    return EXIT.refused;
  }
  if (ended.code !== 0) {
    writeError(options, `The handler failed (exit ${String(ended.code)}).`);
    return EXIT.refused;
  }
  let answer: z.infer<typeof handlerAnswerSchema>;
  try {
    answer = handlerAnswerSchema.parse(JSON.parse(written ?? ended.stdout));
  } catch {
    writeError(options, "The handler answered no JSON object: it writes { output, display? }.");
    return EXIT.refused;
  }
  if (values.json) writeOutput(options, JSON.stringify(answer, null, 2));
  else writeOutput(options, JSON.stringify(answer.output ?? null, null, 2));
  if (answer.display !== undefined) {
    const page = join(work, "display.html");
    await writeFile(page, displayPage(answer.display));
    writeError(options, `The handler showed a display: open ${page} in a browser.`);
  } else {
    await rm(work, { recursive: true, force: true });
  }
  return EXIT.done;
}

/** Carries one request out: to the instance where the tool declares the operation. */
async function answerRequest(
  tool: ToolFolder,
  request: ChannelRequest,
  connect: () => Promise<{ api: ConfigApi }>
): Promise<ChannelAnswer> {
  const name = `connection.${request.connection}.${request.operation}`;
  if (!(tool.config.connections ?? []).includes(name)) {
    return {
      ok: false,
      error: {
        code: "connection_not_declared",
        message: `The tool does not declare '${name}' in its connections, so its handler may not call it.`
      }
    };
  }
  try {
    const { api } = await connect();
    const input = request.input ?? {};
    const result = await api.change(
      (client, idempotencyKey) =>
        client.connections.try_call({
          params: { name: request.connection, operation: request.operation },
          body: { input },
          idempotencyKey
        }),
      "The Connection call has no answer."
    );
    if (result.status !== "done") {
      return {
        ok: false,
        error: {
          code: "approval_required",
          message: `The call waits for a decision (run ${result.run.id}); a local run does not wait for it.`
        }
      };
    }
    return {
      ok: true,
      output: result.output.output ?? null,
      ...(result.output.target === "dry_run" ? { simulated: true as const } : {})
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ConfigApiError
          ? { code: (error.code ?? "failed").toLowerCase(), message: error.message }
          : { code: "failed", message: error instanceof Error ? error.message : String(error) }
    };
  }
}

/** Runs the handler with the request channel on descriptors 3 and 4, as the sandbox does. */
function runHandler(input: {
  command: string;
  args: string[];
  folder: string;
  input: Record<string, unknown>;
  env: Record<string, string>;
  timeoutSeconds: number;
  stderr: (text: string) => void;
  answer: (request: ChannelRequest) => Promise<ChannelAnswer>;
}): Promise<{ code: number | null; stdout: string; timedOut: boolean }> {
  return new Promise((done, failed) => {
    const child = spawn(input.command, input.args, {
      cwd: input.folder,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", input.stderr);
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input.input));
    const [, , , requests, answers] = child.stdio;
    if (!(requests instanceof Readable) || !(answers instanceof Writable)) {
      child.kill("SIGKILL");
      failed(new ToolFolderError("Could not open the handler's request channel."));
      return;
    }
    answers.on("error", () => undefined);
    // Requests are answered one after another, in order: the handler waits for each answer.
    let queue = Promise.resolve();
    createInterface({ input: requests }).on("line", (line) => {
      queue = queue.then(async () => {
        let request: ChannelRequest | undefined;
        try {
          const parsed = channelRequestSchema.safeParse(JSON.parse(line));
          request = parsed.success ? parsed.data : undefined;
        } catch {
          request = undefined;
        }
        const answer: ChannelAnswer = request
          ? await input.answer(request)
          : {
              ok: false,
              error: {
                code: "request_invalid",
                message:
                  'A request is one line of JSON: { "connection": ..., "operation": ..., "input": ... }.'
              }
            };
        if (!answers.destroyed) answers.write(`${JSON.stringify(answer)}\n`);
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutSeconds * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      failed(
        new ToolFolderError(`Could not start '${input.command}': ${error.message}.`, {
          cause: error
        })
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, timedOut });
    });
  });
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char
  );

/**
 * A page of what the handler showed. An HTML display is its own page, as the chat shows it in a
 * frame; a data display is shown as its kind and data, since its widget lives in the instance.
 */
function displayPage(display: unknown): string {
  const parsed = objectSchema.safeParse(display);
  const shown = parsed.success ? parsed.data : {};
  const title = typeof shown.title === "string" ? shown.title : "Display";
  if (shown.type === "html" && typeof shown.html === "string") return shown.html;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>',
    escapeHtml(title),
    '</title></head><body style="font-family:system-ui,sans-serif;margin:2rem">',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>A data display of kind <code>${escapeHtml(String(shown.kind ?? ""))}</code>. The chat shows it with the widget registered for that kind.</p>`,
    `<pre>${escapeHtml(JSON.stringify(shown.data ?? null, null, 2))}</pre>`,
    "</body></html>",
    ""
  ].join("\n");
}
