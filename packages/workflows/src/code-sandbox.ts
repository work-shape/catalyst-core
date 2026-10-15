import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkflowCodeOutcome,
  WorkflowStagedCode,
  WorkflowStepRunLog
} from "@work-shape/catalyst-core";
import {
  SANDBOX_SOURCE_DIRECTORY,
  type SandboxCommandLimits,
  type WorkspaceCommandProcessExecutor
} from "@work-shape/catalyst-tool-execution";
import { WORKFLOW_CODE_ERRORS, WORKFLOW_CODE_LOG_MAX_BYTES, codeLanguageOf } from "./code-step";
import { jsonValueSchema } from "./json";

// One code step is one command in the sandbox the instance runs agent commands in: a
// container without a network, with a read-only root, without capabilities and without a
// variable of the worker's environment. The worker writes the script and the input into a
// directory of its own, which the container is handed read-only. The script works in a
// directory in memory of a stated size, so nothing it writes reaches the worker's disk.
//
// The worker never opens what a script left behind. The command that runs the script also
// reads its result, inside the container and within the script's time limit, and prints it
// after the script's own output: a pipe, a link or a file without end that a script leaves
// in place of its result is the container's to deal with, and ends with it.

const INPUT_FILE = "input.json";
/** The file a script writes its result to. A script that writes none prints its result. */
const OUTPUT_FILE = "output.json";

const DIRECTORY_PREFIX = "catalyst-code-step-";
const COMMAND_ID_PREFIX = "code-step-";

export interface CodeSandboxOptions {
  /** The sandbox of the instance, the one that runs agent commands. */
  sandbox: WorkspaceCommandProcessExecutor;
  /** Where the directories of code steps are made. The sandbox must be able to mount below it. */
  tempRoot: string;
  /** What one code step's container gets, in place of what an agent's command gets. */
  limits: SandboxCommandLimits;
  /** How large a result may be, as JSON in UTF-8: what every step output may be. */
  outputMaxBytes: number;
}

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
}): string {
  const { interpreter, script, mark } = input;
  const most = String(input.maxBytes + 1);
  return [
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
export function createCodeSandbox(options: CodeSandboxOptions) {
  const { sandbox, tempRoot, limits, outputMaxBytes } = options;
  const active = new Set<string>();

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
      if (!entry.isDirectory() || !entry.name.startsWith(DIRECTORY_PREFIX)) continue;
      if (active.has(directory)) continue;
      try {
        if ((await lstat(directory)).mtimeMs <= cutoff) {
          await rm(directory, { recursive: true, force: true });
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
  }): Promise<CodeSandboxResult> {
    const { staged, signal } = input;
    if (signal.aborted) return { kind: "stopped" };
    const language = codeLanguageOf(staged.file);
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
    await mkdir(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, DIRECTORY_PREFIX));
    active.add(root);
    try {
      // The directory the sandbox is handed lies inside the one made above, which no other
      // user of the host can enter. It holds the script and the input, and nothing else.
      const directory = join(root, "run");
      await mkdir(directory);
      const script = `step.${staged.file.split(".").at(-1) ?? ""}`;
      await writeFile(join(directory, script), staged.source, { flag: "wx" });
      await writeFile(join(directory, INPUT_FILE), JSON.stringify(staged.input), { flag: "wx" });
      const mark = `catalyst-result-${randomUUID()}`;
      const result = await sandbox.execute({
        command: {
          id: `${COMMAND_ID_PREFIX}${input.id}`,
          command: scriptCommand({
            interpreter: language.command,
            script,
            mark,
            maxBytes: outputMaxBytes
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
        // Nothing of the worker's environment: the sandbox adds a path and a home of its own.
        env: {},
        signal
      });
      if (result.cancelled) return { kind: "stopped" };
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
      try {
        // What a script wrote is read as data: text that is no JSON, and JSON nested deeper
        // than it can be read, are both a result that is none.
        const json = jsonValueSchema.parse(JSON.parse(text));
        return ended({ kind: "output", value: json });
      } catch {
        return ended(failed(WORKFLOW_CODE_ERRORS.notJson, "The result of the script is not JSON"));
      }
    } finally {
      active.delete(root);
      // A directory that cannot be removed now is removed by a later sweep.
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { run, sweep };
}
