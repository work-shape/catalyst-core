import { createWorkflowSourceCache } from "./source-cache";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  JsonObject,
  WorkflowCodeOutcome,
  WorkflowStagedCode,
  WorkflowStepRunLog
} from "@work-shape/catalyst-core";
import {
  SANDBOX_SOURCE_DIRECTORY,
  type SandboxCommandLimits,
  type SandboxDataDirectories,
  type WorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";
import {
  directoryBytes,
  removeScriptDirectory,
  storeOutputDatasets,
  writeInputDatasets,
  type CodeStepDatasets
} from "./code-datasets";
import {
  WORKFLOW_CODE_DISK_BYTES,
  WORKFLOW_CODE_ERRORS,
  WORKFLOW_CODE_LOG_MAX_BYTES,
  codeFileIssue,
  noWorkflowStepFiles,
  type WorkflowStepFiles,
  type WorkflowSourceLimits,
  codeLanguageOf
} from "./code-step";
import { holdsDatasetReference, jsonValueSchema } from "./json";
import { WorkflowStepFailure } from "./step-failure";

// One code step is one command in the sandbox the instance runs agent commands in: a
// container without a network, with a read-only root, without capabilities and without a
// variable of the worker's environment. The worker writes the script and the input into a
// directory of its own, which the container is handed read-only. The script works in a
// directory in memory of a stated size, so nothing it writes reaches the worker's disk.
//
// The worker never opens what a script left behind in its working directory. The command
// that runs the script also reads its result, inside the container and within the script's
// time limit, and prints it after the script's own output: a pipe, a link or a file without
// end that a script leaves in place of its result is the container's to deal with, and ends
// with it.
//
// A step with datasets is the one exception (`code-datasets.ts`). Its script reads the
// datasets of its input as files in a read-only directory and writes its own datasets as files
// to an output directory on the worker's disk, of a bounded size. The worker reads the files
// the result names from there: regular files directly in the directory, no link followed.

const NODE_LOADER_FILE = "node-root-loader.mjs";
const NODE_REGISTER_FILE = "node-root-register.mjs";
const NODE_ROOT_REGISTER = `import {register} from "node:module"; register(new URL("./node-root-loader.mjs", import.meta.url));`;
// Node's NODE_PATH covers CommonJS. ESM needs the same root fallback through its resolver.
const NODE_ROOT_LOADER = `import {resolve as pathResolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) throw error;
    const root = process.env.WORKFLOW_SOURCE_ROOT;
    const candidate = pathResolve(root, specifier);
    if (!candidate.startsWith(root + '/')) throw error;
    try {return await nextResolve(pathToFileURL(candidate).href, context);} catch {throw error;}
  }
}`;
const INPUT_FILE = "input.json";
/** The file a script writes its result to. A script that writes none prints its result. */
const OUTPUT_FILE = "output.json";

const DIRECTORY_PREFIX = "catalyst-code-step-";
const COMMAND_ID_PREFIX = "code-step-";
const CACHE_PREFIX = "catalyst-workflow-source-cache-";

export interface CodeSandboxOptions {
  /** The sandbox of the instance, the one that runs agent commands. */
  sandbox: WorkspaceCommandProcessExecutor;
  stepFiles?: WorkflowStepFiles;
  sourceLimits?: WorkflowSourceLimits;
  /** Where the directories of code steps are made. The sandbox must be able to mount below it. */
  tempRoot: string;
  /** What one code step's container gets, in place of what an agent's command gets. */
  limits: SandboxCommandLimits;
  /** How large a result may be, as JSON in UTF-8: what every step output may be. */
  outputMaxBytes: number;
  /** How much a script may write to its output directory, and so how large a dataset it writes. */
  diskBytes?: number;
}

/** How often the worker measures what a running script has written to its output directory. */
const DISK_CHECK_MS = 500;

/** How one run of a script ended. `stopped` and `notStarted` are no outcome of the step. */
export type CodeSandboxResult =
  | { kind: "ended"; outcome: WorkflowCodeOutcome; log: WorkflowStepRunLog }
  /** The run was stopped from outside: by a cancel, or by a worker that stops. */
  | { kind: "stopped" }
  /** The sandbox could not start the container. Another attempt may. */
  | { kind: "notStarted"; reason: string };

const failed = (code: string, message: string): WorkflowCodeOutcome => ({
  kind: "failed",
  error: { code, message }
});

/** The first bytes of a stream as the log keeps them. */
function cut(text: string): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  return bytes.byteLength <= WORKFLOW_CODE_LOG_MAX_BYTES
    ? { text, cut: false }
    : { text: bytes.subarray(0, WORKFLOW_CODE_LOG_MAX_BYTES).toString("utf8"), cut: true };
}

/**
 * The shell text that runs one script. It copies the script and the input into the working
 * directory where the sandbox handed them in read-only, runs the script with the input on its
 * input stream, and lets through as much of what the script prints as a result may be long.
 * Then, where the script left a regular file as its result, it prints a line nobody but this
 * run knows and at most one byte more of the file than a result may have. It reads nothing
 * else: a link, a pipe, a socket, a device or a directory in the file's place is no result.
 * It ends with the exit code of the script.
 */
function scriptCommand(input: {
  interpreter: string;
  script: string;
  mark: string;
  maxBytes: number;
  /** Where the script writes files on the worker's disk: no file of it may grow past this. */
  diskBytes?: number;
  tree?: boolean;
  sourceRoot?: string;
  legacyIo?: boolean;
  data?: SandboxDataDirectories;
}): string {
  const { interpreter, script, mark } = input;
  const most = String(input.maxBytes + 1);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  if (input.tree)
    return [
      ...(input.diskBytes === undefined
        ? []
        : [`ulimit -f ${String(Math.floor(input.diskBytes / 1024) + 1)} || exit 125`]),
      `source_root=${quote(input.sourceRoot ?? SANDBOX_SOURCE_DIRECTORY)}; [ -d "$source_root/tree" ] || exit 125`,
      'export WORKFLOW_SOURCE_ROOT="$source_root/tree"',
      `export WORKFLOW_INPUT_FILE="$source_root/${INPUT_FILE}"`,
      `export WORKFLOW_OUTPUT_FILE="$PWD/${OUTPUT_FILE}"`,
      ...(input.data
        ? [
            `export WORKFLOW_DATA_INPUT_DIRECTORY=${quote(input.data.input)} WORKFLOW_DATA_OUTPUT_DIRECTORY=${quote(input.data.output)}`
          ]
        : []),
      ...(input.legacyIo
        ? [
            'if [ ! input.json -ef "$WORKFLOW_INPUT_FILE" ]; then cp "$WORKFLOW_INPUT_FILE" input.json || exit 125; fi',
            'export PYTHONPATH="$source_root/tree" NODE_PATH="$source_root/tree" PYTHONDONTWRITEBYTECODE=1'
          ]
        : [
            'cd "$source_root/tree" || exit 125',
            'export PYTHONPATH="$PWD" NODE_PATH="$PWD" PYTHONDONTWRITEBYTECODE=1'
          ]),
      `${interpreter}${interpreter === "node" ? ` --import "$source_root/${NODE_REGISTER_FILE}"` : ""} "$source_root/tree"/${quote(script)} < "$WORKFLOW_INPUT_FILE" | { head -c ${most}; cat > /dev/null; }`,
      "code=${PIPESTATUS[0]}",
      `if [ -f "$WORKFLOW_OUTPUT_FILE" ] && [ ! -L "$WORKFLOW_OUTPUT_FILE" ]; then printf '\\n%s\\n' '${mark}'; head -c ${most} "$WORKFLOW_OUTPUT_FILE"; fi`,
      'exit "$code"'
    ].join("\n");
  return [
    // A file the script writes ends one block past the bound, so the worker sees it is over.
    ...(input.diskBytes === undefined
      ? []
      : [`ulimit -f ${String(Math.floor(input.diskBytes / 1024) + 1)} || exit 125`]),
    // Only where the sandbox handed the files in beside the working directory: a sandbox
    // that runs the command in the worker's own directory has them there already.
    `if [ ! -e ${script} ] && [ -f ${SANDBOX_SOURCE_DIRECTORY}/${script} ]; then cp ${SANDBOX_SOURCE_DIRECTORY}/${script} ${SANDBOX_SOURCE_DIRECTORY}/${INPUT_FILE} . || exit 125; fi`,
    `${interpreter} ${script} < ${INPUT_FILE} | { head -c ${most}; cat > /dev/null; }`,
    "code=${PIPESTATUS[0]}",
    `if [ -f ${OUTPUT_FILE} ] && [ ! -L ${OUTPUT_FILE} ]; then printf '\\n%s\\n' '${mark}'; head -c ${most} ${OUTPUT_FILE}; fi`,
    'exit "$code"'
  ].join("\n");
}

/** Runs scripts of code steps in the sandbox. The function never rejects for what a script did. */
/** The bytes in a step's input and output directories together, measured up to `bound`. */
async function stepBytes(data: SandboxDataDirectories, bound: number): Promise<number> {
  const input = await directoryBytes(data.input, bound);
  return input > bound ? input : input + (await directoryBytes(data.output, bound - input));
}

export function createCodeSandbox(options: CodeSandboxOptions) {
  const { sandbox, tempRoot, limits, outputMaxBytes } = options;
  const diskBytes = options.diskBytes ?? WORKFLOW_CODE_DISK_BYTES;
  const active = new Set<string>();
  const sourceCache = createWorkflowSourceCache({
    directory: join(tempRoot, `${CACHE_PREFIX}${process.pid}`),
    ...(options.sourceLimits ? { limits: options.sourceLimits } : {})
  });

  /**
   * Removes what a killed worker left: the directories and the containers of code steps that
   * are older than `olderThanMs`, which is longer than any script may run. Nothing ends a
   * container whose worker is gone, so the worker calls this when it starts and on a timer
   * of its own, whether or not another code step ever runs.
   */
  async function sweep(olderThanMs: number): Promise<{ directories: number; containers: number }> {
    const cutoff = Date.now() - olderThanMs;
    let directories = 0;
    for (const entry of await readdir(tempRoot, { withFileTypes: true }).catch(() => [])) {
      const directory = join(tempRoot, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(CACHE_PREFIX)) {
        const pid = Number(entry.name.slice(CACHE_PREFIX.length));
        if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH" &&
            (await lstat(directory)).mtimeMs <= cutoff
          )
            await removeScriptDirectory(directory);
        }
        continue;
      }
      if (!entry.name.startsWith(DIRECTORY_PREFIX)) continue;
      if (active.has(directory)) continue;
      try {
        if ((await lstat(directory)).mtimeMs <= cutoff) {
          await removeScriptDirectory(directory);
          directories += 1;
        }
      } catch {
        // Gone already, or not this worker's to remove. The next sweep looks again.
      }
    }
    const containers = await Promise.resolve(
      sandbox.removeLeftovers?.({ idPrefix: COMMAND_ID_PREFIX, olderThanMs }) ?? 0
    ).catch(() => 0);
    return { directories, containers };
  }

  async function run(input: {
    /** Names the container: the id of the step run. */
    id: string;
    staged: WorkflowStagedCode;
    signal: AbortSignal;
    /** Where the datasets of the step are read and stored. Missing where there is no store. */
    datasets?: CodeStepDatasets;
  }): Promise<CodeSandboxResult> {
    const { staged, signal } = input;
    const usesDatasets = staged.datasets !== undefined || holdsDatasetReference(staged.input);
    if (signal.aborted) return { kind: "stopped" };
    const language = codeFileIssue(staged.file) ? undefined : codeLanguageOf(staged.file);
    if (!language) {
      return {
        kind: "ended",
        outcome: failed(
          WORKFLOW_CODE_ERRORS.fileInvalid,
          `'${staged.file}' is in no language of the runner image`
        ),
        log: { stdout: "", stderr: "", truncated: false }
      };
    }
    const noLog: WorkflowStepRunLog = { stdout: "", stderr: "", truncated: false };
    if (usesDatasets && !input.datasets) {
      return {
        kind: "ended",
        outcome: failed("dataset_storage_unavailable", "This instance has no files object store"),
        log: noLog
      };
    }
    await mkdir(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, DIRECTORY_PREFIX));
    active.add(root);
    // Ends the container with the attempt, and where the script writes past the bound.
    const stop = new AbortController();
    const stopped = () => stop.abort(signal.reason);
    signal.addEventListener("abort", stopped, { once: true });
    let overBound = false;
    try {
      // The directory the sandbox is handed lies inside the one made above, which no other
      // user of the host can enter. It holds the script and the input, and nothing else.
      const directory = join(root, "run");
      await mkdir(directory);
      // The datasets of the input in one directory, and one the script writes its own to.
      const data: SandboxDataDirectories | undefined = usesDatasets
        ? { input: join(root, "in"), output: join(root, "out") }
        : undefined;
      let seen: SandboxDataDirectories | undefined;
      let stagedInput: JsonObject = staged.input;
      // The bytes of disk the step may take: its input files and what the script writes.
      let room = diskBytes;
      if (data && input.datasets) {
        await mkdir(data.input);
        await mkdir(data.output);
        // A sandbox without paths of its own runs the script where the worker's paths reach,
        // and the script sees them resolved, as its working directory is.
        seen = sandbox.dataPaths ?? {
          input: await realpath(data.input),
          output: await realpath(data.output)
        };
        try {
          const written = await writeInputDatasets({
            value: staged.input,
            directory: data.input,
            seenAs: seen.input,
            bound: diskBytes,
            datasets: input.datasets,
            signal: stop.signal
          });
          stagedInput = written.value;
          room = diskBytes - written.bytes;
        } catch (error) {
          if (signal.aborted) return { kind: "stopped" };
          if (!(error instanceof WorkflowStepFailure)) throw error;
          return {
            kind: "ended",
            outcome: { kind: "failed", error: error.toRunError() },
            log: noLog
          };
        }
      }
      const script = staged.tree ? staged.file : `step.${staged.file.split(".").at(-1) ?? ""}`;
      if (staged.tree) {
        try {
          const tree = await (options.stepFiles ?? noWorkflowStepFiles).readTree(staged.tree);
          if (
            !tree ||
            tree.hash !== staged.tree.hash ||
            !tree.files.some((file) => file.path === staged.file)
          )
            return {
              kind: "ended",
              outcome: failed(
                WORKFLOW_CODE_ERRORS.fileMissing,
                "The staged revision's tree or entry is missing"
              ),
              log: noLog
            };
          await sourceCache.copy(tree, join(directory, "tree"), stop.signal);
        } catch (error) {
          if (stop.signal.aborted) return { kind: "stopped" };
          if (!(error instanceof WorkflowStepFailure)) throw error;
          return {
            kind: "ended",
            outcome: { kind: "failed", error: error.toRunError() },
            log: noLog
          };
        }
      } else {
        await writeFile(join(directory, script), staged.source ?? "", { flag: "wx" });
      }
      if (staged.tree && language.command === "node") {
        await writeFile(join(directory, NODE_LOADER_FILE), NODE_ROOT_LOADER, { flag: "wx" });
        await writeFile(join(directory, NODE_REGISTER_FILE), NODE_ROOT_REGISTER, { flag: "wx" });
      }
      await writeFile(join(directory, INPUT_FILE), JSON.stringify(stagedInput), { flag: "wx" });
      const mark = `catalyst-result-${randomUUID()}`;
      // The step's data on disk is measured while the script runs: its input files and
      // what the script writes. A script that takes it past the bound is stopped: the worker's
      // disk is no script's to fill.
      let running = true;
      let wake: (() => void) | undefined;
      const watch = async (): Promise<void> => {
        while (data && running && !stop.signal.aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, DISK_CHECK_MS);
          });
          if (!running) return;
          const over = await stepBytes(data, diskBytes).then(
            (bytes) => bytes > diskBytes,
            () => true
          );
          if (over && running) {
            overBound = true;
            stop.abort(new Error("The script wrote past the bound of its output directory"));
          }
        }
      };
      const watching = watch().catch(() => undefined);
      const result = await sandbox
        .execute({
          command: {
            id: `${COMMAND_ID_PREFIX}${input.id}`,
            command: scriptCommand({
              interpreter: language.command,
              script,
              tree: staged.tree !== undefined,
              sourceRoot: sandbox.dataPaths ? SANDBOX_SOURCE_DIRECTORY : directory,
              legacyIo: staged.legacyIo === true,
              ...(seen ? { data: seen } : {}),
              mark,
              maxBytes: outputMaxBytes,
              ...(data ? { diskBytes: room } : {})
            }),
            limits: {
              timeoutSeconds: staged.timeoutSeconds,
              // What the command lets through at most: the script's output and its result,
              // each one byte longer than a result may be, and the line between them.
              maxStdoutBytes: 2 * (outputMaxBytes + 1) + mark.length + 2,
              maxStderrBytes: WORKFLOW_CODE_LOG_MAX_BYTES + 1
            }
          },
          sandboxLimits: limits,
          workspaceDirectory: directory,
          workspaceCwd: ".",
          cwd: directory,
          tempDirectory: join(root, "tmp"),
          ...(data ? { dataDirectories: data } : {}),
          // Nothing of the worker's environment: the sandbox adds a path and a home of its own.
          env: {},
          signal: stop.signal
        })
        .finally(() => {
          running = false;
          wake?.();
        });
      await watching;
      if (result.cancelled && !overBound) return { kind: "stopped" };
      if (result.spawnError) return { kind: "notStarted", reason: result.spawnError.message };
      // What the script printed, and after the line of this run what it left as its result.
      const at = result.stdoutPreview.indexOf(`\n${mark}\n`);
      const printedText = at === -1 ? result.stdoutPreview : result.stdoutPreview.slice(0, at);
      const written = at === -1 ? undefined : result.stdoutPreview.slice(at + mark.length + 2);
      const tooLong = (text: string) => Buffer.byteLength(text, "utf8") > outputMaxBytes;
      // A script that wrote its result to the file printed a log; one that wrote none
      // printed its result, and its error stream is its log.
      const stdout = cut(written === undefined ? "" : printedText);
      const stderr = cut(result.stderrPreview);
      const log: WorkflowStepRunLog = {
        stdout: stdout.text,
        stderr: stderr.text,
        truncated:
          stdout.cut ||
          stderr.cut ||
          result.truncated.stderr ||
          (written !== undefined && tooLong(printedText))
      };
      const ended = (outcome: WorkflowCodeOutcome): CodeSandboxResult => ({
        kind: "ended",
        outcome,
        log
      });
      // A script that did not end by itself has no result, whatever it had written by then.
      const unfinished = (outcome: WorkflowCodeOutcome): CodeSandboxResult => ({
        kind: "ended",
        outcome,
        log: { ...log, stdout: cut(printedText).text }
      });
      // Over the bound, however the script ended: stopped by the watch, ended by its file
      // limit, or done just after it wrote the last byte too many.
      if (
        data &&
        (overBound || (await stepBytes(data, diskBytes).catch(() => Infinity)) > diskBytes)
      ) {
        return unfinished(
          failed(
            WORKFLOW_CODE_ERRORS.diskLimit,
            `The step's input datasets and what its script wrote take more than ${String(diskBytes)} bytes of disk`
          )
        );
      }
      if (result.timeoutKind) {
        return unfinished(
          failed(
            WORKFLOW_CODE_ERRORS.timeout,
            `The script did not end within ${staged.timeoutSeconds} seconds and was stopped`
          )
        );
      }
      // The sandbox's own word, where it has one: a script may end with any exit code it
      // likes, and a process that was killed for another reason ends with the same one.
      if (result.outOfMemory === true) {
        return unfinished(
          failed(
            WORKFLOW_CODE_ERRORS.outOfMemory,
            `The script was ended because it needed more memory than a code step gets (${limits.memoryBytes} bytes)`
          )
        );
      }
      if (result.exitCode !== 0) {
        return unfinished(
          failed(
            WORKFLOW_CODE_ERRORS.failed,
            `The script ended with the exit code ${result.exitCode}`
          )
        );
      }
      const text = written ?? printedText;
      if (tooLong(text) || result.truncated.stdout) {
        return ended(
          failed(
            WORKFLOW_CODE_ERRORS.tooLarge,
            `The result of the script is larger than ${outputMaxBytes} bytes`
          )
        );
      }
      if (text.trim() === "") {
        return ended(
          failed(
            WORKFLOW_CODE_ERRORS.noOutput,
            `The script ended without a result: it wrote no '${OUTPUT_FILE}' and printed nothing`
          )
        );
      }
      let json;
      try {
        // What a script wrote is read as data: text that is no JSON, and JSON nested deeper
        // than it can be read, are both a result that is none.
        json = jsonValueSchema.parse(JSON.parse(text));
      } catch {
        return ended(failed(WORKFLOW_CODE_ERRORS.notJson, "The result of the script is not JSON"));
      }
      if (!data || !seen || !input.datasets || !staged.datasets) {
        return ended({ kind: "output", value: json });
      }
      try {
        const value = await storeOutputDatasets({
          value: json,
          schema: staged.datasets.outputSchema,
          directory: data.output,
          seenAs: seen.output,
          bound: room,
          ...(staged.datasets.maxBytes === undefined ? {} : { maxBytes: staged.datasets.maxBytes }),
          datasets: input.datasets,
          signal: stop.signal
        });
        return ended({ kind: "output", value });
      } catch (error) {
        if (signal.aborted) return { kind: "stopped" };
        if (!(error instanceof WorkflowStepFailure)) throw error;
        return ended({ kind: "failed", error: error.toRunError() });
      }
    } finally {
      signal.removeEventListener("abort", stopped);
      active.delete(root);
      // A directory that cannot be removed now is removed by a later sweep.
      await removeScriptDirectory(root).catch(() => undefined);
    }
  }

  return { run, sweep };
}
