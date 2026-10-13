import {
  WORKFLOW_STEP_FILES_FOLDER,
  type OperationEffect,
  type WorkflowManifest,
  type WorkflowStep
} from "@vivd-catalyst/core";

// The `code` step: one script file of a Workflow's step files folder, run on the step's input
// in a container of the command runner. This file holds what a definition is checked against;
// the run in the sandbox is in `code-sandbox.ts` and the job that makes it in `code-job.ts`.

/**
 * The languages of the runner image a script may be written in, by the ending of its file,
 * each with the command that runs it. A script of another ending is refused on save.
 */
export const WORKFLOW_CODE_LANGUAGES: Readonly<
  Record<string, { language: string; command: string }>
> = {
  py: { language: "python", command: "python3" },
  js: { language: "javascript", command: "node" },
  mjs: { language: "javascript", command: "node" }
};

/** How large the script of a code step may be, as UTF-8. */
export const WORKFLOW_CODE_FILE_MAX_BYTES = 256 * 1_024;

/** How much of each of a script's two streams the step run keeps as its log. */
export const WORKFLOW_CODE_LOG_MAX_BYTES = 16 * 1_024;

/**
 * What a code step does to the world: nothing. Its container has no network, no credential
 * and no file but its own, so the step run is marked as a reading one and the step is run
 * again where an attempt was cut: by a worker that stopped, a lease that ran out or a runner
 * that could not start the container. It carries no idempotency key because it needs none.
 */
export const WORKFLOW_CODE_STEP_EFFECT: OperationEffect = "reading";

/** The codes a code step fails with. None of them is retried: another run ends the same. */
export const WORKFLOW_CODE_ERRORS = {
  /** The script ended with an exit code other than 0. */
  failed: "code_failed",
  /** The script ran longer than the time a code step may take. */
  timeout: "code_timeout",
  /** The container was ended because the script needed more memory than a code step gets. */
  outOfMemory: "code_out_of_memory",
  /** The script ended without a result: no `output.json` and nothing on its output stream. */
  noOutput: "code_output_missing",
  notJson: "code_output_not_json",
  tooLarge: "code_output_too_large",
  /** The result does not fit the step's `outputSchema`. */
  outputInvalid: "code_output_invalid",
  /** The input does not fit the step's `inputSchema`. */
  inputInvalid: "code_input_invalid",
  fileMissing: "code_file_missing",
  fileTooLarge: "code_file_too_large",
  fileInvalid: "code_file_invalid",
  /** The instance runs no sandbox, or every attempt to start the container failed. */
  runnerUnavailable: "code_runner_unavailable"
} as const;

const FILE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/u;

/** The language of a script by the ending of its file, or nothing where the image has none. */
export function codeLanguageOf(file: string): { language: string; command: string } | undefined {
  const ending = /\.([A-Za-z0-9]+)$/u.exec(file)?.[1]?.toLowerCase();
  return ending === undefined ? undefined : WORKFLOW_CODE_LANGUAGES[ending];
}

/**
 * Why the `file` of a code step names no script that can be run, or nothing. It is a path
 * inside the step files folder, written without that folder, and it never leaves it.
 */
export function codeFileIssue(file: string): string | undefined {
  if (file.length > 200 || !FILE_PATH.test(file) || file.split("/").includes("..")) {
    return `'${file}' is no path of a file in '${WORKFLOW_STEP_FILES_FOLDER}/': letters, digits, '_', '-' and '.', with '/' between folders`;
  }
  if (!codeLanguageOf(file)) {
    return `'${file}' is in no language of the runner image: a script ends in ${Object.keys(
      WORKFLOW_CODE_LANGUAGES
    )
      .map((ending) => `'.${ending}'`)
      .join(", ")}`;
  }
  return undefined;
}

/** The path of a script in its Workflow's folder. */
function codeFilePath(file: string): string {
  return `${WORKFLOW_STEP_FILES_FOLDER}/${file}`;
}

/**
 * Where the engine reads the script of a code step: the files of one revision of a Workflow.
 * The assembly fills it from wherever definitions are stored. A revision's files never
 * change, so a run that started on a revision reads the script that revision was saved with,
 * whatever was published since.
 */
export interface WorkflowStepFiles {
  /** The bytes of one file of a revision, or nothing where the revision has no such file. */
  readStepFile(input: {
    workflow: string;
    revisionId: string;
    /** The path in the Workflow's folder, such as `steps/check.py`. */
    path: string;
  }): Promise<Uint8Array | undefined>;
}

/** A source that has no file: what an instance has until definitions are stored with theirs. */
export const noWorkflowStepFiles: WorkflowStepFiles = {
  readStepFile: () => Promise.resolve(undefined)
};

/** The script of a code step as text, or why it cannot be run. */
export async function readCodeFile(
  files: WorkflowStepFiles,
  revision: { workflow: string; revisionId: string },
  file: string
): Promise<{ source: string } | { code: string; message: string }> {
  const bytes = await files.readStepFile({ ...revision, path: codeFilePath(file) });
  if (!bytes) {
    return {
      code: WORKFLOW_CODE_ERRORS.fileMissing,
      message: `The Workflow has no file '${codeFilePath(file)}'`
    };
  }
  if (bytes.byteLength > WORKFLOW_CODE_FILE_MAX_BYTES) {
    return {
      code: WORKFLOW_CODE_ERRORS.fileTooLarge,
      message: `The file '${codeFilePath(file)}' is larger than ${WORKFLOW_CODE_FILE_MAX_BYTES} bytes`
    };
  }
  try {
    return { source: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return {
      code: WORKFLOW_CODE_ERRORS.fileInvalid,
      message: `The file '${codeFilePath(file)}' is no text in UTF-8`
    };
  }
}

/**
 * What keeps the code steps of a revision from being run, beside what the parser checks: each
 * script exists in the revision's files, is text and is not too large. It is asked when a run
 * is started, and by whoever saves or publishes a definition.
 */
export async function codeStepIssues(
  revision: { revisionId: string; manifest: Pick<WorkflowManifest, "id" | "steps"> },
  files: WorkflowStepFiles
): Promise<{ path: string; code: string; message: string }[]> {
  const issues: { path: string; code: string; message: string }[] = [];
  const walk = async (steps: readonly WorkflowStep[]): Promise<void> => {
    for (const step of steps) {
      if (step.type === "loop") await walk(step.steps);
      if (step.type !== "code") continue;
      const read = await readCodeFile(
        files,
        { workflow: revision.manifest.id, revisionId: revision.revisionId },
        step.file
      );
      if ("code" in read) issues.push({ path: `steps.${step.id}.file`, ...read });
    }
  };
  await walk(revision.manifest.steps);
  return issues;
}
