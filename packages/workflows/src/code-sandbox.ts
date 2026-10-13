import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkflowCodeOutcome,
  WorkflowStagedCode,
  WorkflowStepRunLog
} from "@vivd-catalyst/core";
import type {
  SandboxCommandLimits,
  WorkspaceCommandProcessExecutor
} from "@vivd-catalyst/tool-execution";
import { WORKFLOW_CODE_ERRORS, WORKFLOW_CODE_LOG_MAX_BYTES, codeLanguageOf } from "./code-step";
import { jsonValueSchema } from "./json";

// One code step is one command in the sandbox the instance runs agent commands in: a
// container without a network, with a read-only root, without capabilities, and with one
// writable directory that holds the script and its input and nothing else. No variable of
// the worker's environment reaches it. The worker writes the two files, runs the script with
// the input on its input stream, and reads the result back as data it does not trust.

/** The file of the directory the input is in, beside being the script's input stream. */
const CODE_STEP_INPUT_FILE = "input.json";
/** The file a script writes its result to. A script that writes none prints its result. */
const CODE_STEP_OUTPUT_FILE = "output.json";

const DIRECTORY_PREFIX = "catalyst-code-step-";
const COMMAND_ID_PREFIX = "code-step-";
/** The exit code of a process the kernel killed, which a container over its memory is. */
const EXIT_KILLED = 137;
/** A directory or container this old was left by a worker that was killed. */
const STALE_MS = 30 * 60 * 1_000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1_000;

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
 * The result a script wrote to its file, read without following a link: the script owns the
 * directory, and a link it left there would otherwise be read on the worker's host.
 */
async function readOutputFile(
  path: string,
  maxBytes: number
): Promise<{ text: string } | { missing: true } | { tooLarge: true }> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { missing: true };
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return { missing: true };
    if (stat.size > maxBytes) return { tooLarge: true };
    return { text: await file.readFile("utf8") };
  } finally {
    await file.close();
  }
}

/** Runs scripts of code steps in the sandbox. The function never rejects for what a script did. */
export function createCodeSandbox(options: CodeSandboxOptions) {
  const { sandbox, tempRoot, limits, outputMaxBytes } = options;
  const active = new Set<string>();
  let nextSweep = 0;

  /** Removes what a killed worker left: directories and containers older than any run can be. */
  async function sweep(): Promise<void> {
    const cutoff = Date.now() - STALE_MS;
    for (const entry of await readdir(tempRoot, { withFileTypes: true }).catch(() => [])) {
      const directory = join(tempRoot, entry.name);
      if (!entry.isDirectory() || !entry.name.startsWith(DIRECTORY_PREFIX)) continue;
      if (active.has(directory)) continue;
      try {
        if ((await lstat(directory)).mtimeMs <= cutoff) {
          await rm(directory, { recursive: true, force: true });
        }
      } catch {
        // Gone already, or not this worker's to remove. The next sweep looks again.
      }
    }
    await sandbox.removeLeftovers?.({ idPrefix: COMMAND_ID_PREFIX, olderThanMs: STALE_MS });
  }

  return async function run(input: {
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
    if (Date.now() >= nextSweep) {
      nextSweep = Date.now() + SWEEP_INTERVAL_MS;
      sweep().catch(() => undefined);
    }
    const root = await mkdtemp(join(tempRoot, DIRECTORY_PREFIX));
    active.add(root);
    try {
      // The directory the sandbox mounts lies inside the one made above, which no other user
      // of the host can enter. It holds the script and the input, and nothing else.
      const directory = join(root, "run");
      await mkdir(directory);
      // The script may run as another user than the worker, and writes its result here.
      await chmod(directory, 0o777);
      const script = `step.${staged.file.split(".").at(-1) ?? ""}`;
      await writeFile(join(directory, script), staged.source, { flag: "wx" });
      await writeFile(join(directory, CODE_STEP_INPUT_FILE), JSON.stringify(staged.input), {
        flag: "wx"
      });
      const result = await sandbox.execute({
        command: {
          id: `${COMMAND_ID_PREFIX}${input.id}`,
          command: `${language.command} ${script} < ${CODE_STEP_INPUT_FILE}`,
          limits: {
            timeoutSeconds: staged.timeoutSeconds,
            // One byte more than a result may have, so one that is too large is told apart.
            maxStdoutBytes: outputMaxBytes + 1,
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

      const written = await readOutputFile(join(directory, CODE_STEP_OUTPUT_FILE), outputMaxBytes);
      // A script that wrote its result to the file printed a log; one that wrote none
      // printed its result, and its error stream is its log.
      const printed = "missing" in written;
      const stdout = cut(printed ? "" : result.stdoutPreview);
      const stderr = cut(result.stderrPreview);
      const log: WorkflowStepRunLog = {
        stdout: stdout.text,
        stderr: stderr.text,
        truncated:
          stdout.cut ||
          stderr.cut ||
          result.truncated.stderr ||
          (!printed && result.truncated.stdout)
      };
      const ended = (outcome: WorkflowCodeOutcome): CodeSandboxResult => ({
        kind: "ended",
        outcome,
        log
      });
      // A script that did not end by itself has no result, whatever it had written by then.
      const unfinished = (): WorkflowStepRunLog => ({
        ...log,
        stdout: cut(result.stdoutPreview).text
      });
      if (result.timeoutKind) {
        return {
          kind: "ended",
          outcome: failed(
            WORKFLOW_CODE_ERRORS.timeout,
            `The script did not end within ${staged.timeoutSeconds} seconds and was stopped`
          ),
          log: unfinished()
        };
      }
      if (result.exitCode === EXIT_KILLED) {
        return {
          kind: "ended",
          outcome: failed(
            WORKFLOW_CODE_ERRORS.outOfMemory,
            `The script was ended because it needed more memory than a code step gets (${limits.memoryBytes} bytes)`
          ),
          log: unfinished()
        };
      }
      if (result.exitCode !== 0) {
        return {
          kind: "ended",
          outcome: failed(
            WORKFLOW_CODE_ERRORS.failed,
            `The script ended with the exit code ${result.exitCode}`
          ),
          log: unfinished()
        };
      }
      if ("tooLarge" in written || (printed && result.truncated.stdout)) {
        return ended(
          failed(
            WORKFLOW_CODE_ERRORS.tooLarge,
            `The result of the script is larger than ${outputMaxBytes} bytes`
          )
        );
      }
      const text = "text" in written ? written.text : result.stdoutPreview;
      if (text.trim() === "") {
        return ended(
          failed(
            WORKFLOW_CODE_ERRORS.noOutput,
            `The script ended without a result: it wrote no '${CODE_STEP_OUTPUT_FILE}' and printed nothing`
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
  };
}
