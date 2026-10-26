import { WorkflowStepFailure } from "./step-failure";
import {
  AppError,
  WORKFLOW_STEP_FILES_FOLDER,
  isStorableText,
  fileSetPathIssue,
  type OperationEffect,
  type WorkflowManifest,
  type WorkflowStep
} from "@work-shape/catalyst-core";

// A code step runs one entry from an immutable Workflow tree. Validation lives here;
// the worker's materialisation and sandbox are in source-cache.ts and code-sandbox.ts.

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

/** How much of each of a script's two streams the step run keeps as its log. */
export const WORKFLOW_CODE_LOG_MAX_BYTES = 16 * 1_024;

/**
 * What a code step does to the world: nothing. Its container has no network, no credential
 * and only its Workflow tree, so the step run is marked as a reading one and the step is run
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
  /** The step files of a revision are larger together than a revision may hold. */
  filesTooLarge: "code_files_too_large",
  /** The instance runs no sandbox, or every attempt to start the container failed. */
  runnerUnavailable: "code_runner_unavailable",
  /**
   * The result names a dataset by a path that is not one file directly in the output
   * directory, or holds a value at a dataset's place that is no `{ path }`.
   */
  datasetPathInvalid: "code_dataset_path_invalid",
  /** The file a result names is no regular file: missing, a link, a pipe or a directory. */
  datasetFileInvalid: "code_dataset_file_invalid",
  /** The script wrote more to its output directory than one code step may. */
  diskLimit: "code_disk_limit"
} as const;

/** How much a code step may write to its output directory unless release config sets it. */
export const WORKFLOW_CODE_DISK_BYTES = 2 * 1_024 ** 3;

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
  const issue = sourcePathIssue(file);
  if (issue) return issue;
  if (!codeLanguageOf(file)) {
    return `'${file}' is in no language of the runner image: a script ends in ${Object.keys(
      WORKFLOW_CODE_LANGUAGES
    )
      .map((ending) => `'.${ending}'`)
      .join(", ")}`;
  }
  return undefined;
}

/** The deprecated `file` field is relative to steps/; entry is relative to the tree. */
export function codeEntry(step: { entry?: string; file?: string }): string {
  return step.entry ?? `${WORKFLOW_STEP_FILES_FOLDER}/${step.file ?? ""}`;
}

export function sourcePathIssue(path: string): string | undefined {
  return (
    fileSetPathIssue(path) ??
    (path.split("/").some((part) => part.toLowerCase() === ".git")
      ? "A Workflow tree holds no .git component"
      : undefined)
  );
}

export interface WorkflowSourceLimits {
  fileBytes: number;
  files: number;
  treeBytes: number;
  historyBytes: number;
  cacheBytes: number;
}
export const WORKFLOW_SOURCE_DEFAULTS: WorkflowSourceLimits = {
  fileBytes: 2 * 1024 ** 2,
  files: 2000,
  treeBytes: 50 * 1024 ** 2,
  historyBytes: 100 * 1024 ** 2,
  cacheBytes: 512 * 1024 ** 2
};

export interface WorkflowSourceTree {
  hash: string;
  files: readonly { path: string; bytes: number }[];
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
}

/** An immutable revision's tree export. Implementations never read git. */
export interface WorkflowStepFiles {
  readTree(input: {
    workflow: string;
    revisionId: string;
  }): Promise<WorkflowSourceTree | undefined>;
}
export const noWorkflowStepFiles: WorkflowStepFiles = {
  readTree: () => Promise.resolve(undefined)
};

export function workflowSourceIssues(
  files: readonly { path: string; bytes: number }[],
  limits: WorkflowSourceLimits = WORKFLOW_SOURCE_DEFAULTS
): WorkflowStepFileIssue[] {
  const issues: WorkflowStepFileIssue[] = [];
  const bound = (setting: string, actual: number, limit: number, path: string) => {
    if (actual > limit)
      issues.push({
        path,
        code: WORKFLOW_CODE_ERRORS.filesTooLarge,
        message: `${path} has ${actual}; workflows.source.${setting} allows ${limit}`
      });
  };
  bound("files", files.length, limits.files, "files");
  bound(
    "treeBytes",
    files.reduce((sum, file) => sum + file.bytes, 0),
    limits.treeBytes,
    "files"
  );
  const seen = new Set<string>();
  for (const file of files) {
    const issue =
      !Number.isSafeInteger(file.bytes) || file.bytes < 0
        ? "Source byte sizes are nonnegative safe integers"
        : sourcePathIssue(file.path);
    const key = file.path.toLowerCase();
    if (
      issue ||
      seen.has(key) ||
      [...seen].some((path) => key.startsWith(`${path}/`) || path.startsWith(`${key}/`))
    ) {
      issues.push({
        path: file.path,
        code: WORKFLOW_CODE_ERRORS.fileInvalid,
        message: issue ?? `Duplicate or conflicting tree path '${file.path}'`
      });
    }
    seen.add(key);
    bound("fileBytes", file.bytes, limits.fileBytes, file.path);
  }
  return issues;
}

/** Published trees keep their approved capacity; reads recheck paths and size integrity. */
export function workflowSourcePathIssues(
  files: readonly { path: string; bytes: number }[]
): WorkflowStepFileIssue[] {
  return workflowSourceIssues(files).filter(
    (issue) => issue.code === WORKFLOW_CODE_ERRORS.fileInvalid
  );
}

export async function readCodeFile(
  files: WorkflowStepFiles,
  revision: { workflow: string; revisionId: string },
  entry: string,
  inlineSource = false
): Promise<
  | { source: string; tree: { workflow: string; revisionId: string; hash: string } }
  | { code: string; message: string }
> {
  let tree: WorkflowSourceTree | undefined;
  try {
    tree = await files.readTree(revision);
  } catch (error) {
    if (!(error instanceof WorkflowStepFailure)) throw error;
    return error.toRunError();
  }
  if (!tree?.files.some((file) => file.path === entry))
    return {
      code: WORKFLOW_CODE_ERRORS.fileMissing,
      message: `The Workflow has no file '${entry}'`
    };
  const reference = { ...revision, hash: tree.hash };
  if (!inlineSource) return { source: "", tree: reference };
  let bytes: Uint8Array | undefined;
  try {
    bytes = await tree.readFile(entry);
  } catch (error) {
    if (!(error instanceof WorkflowStepFailure)) throw error;
    return error.toRunError();
  }
  if (!bytes)
    return {
      code: WORKFLOW_CODE_ERRORS.fileMissing,
      message: `The Workflow has no file '${entry}'`
    };
  try {
    return {
      source: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      tree: { ...revision, hash: tree.hash }
    };
  } catch {
    return {
      code: WORKFLOW_CODE_ERRORS.fileInvalid,
      message: `The file '${entry}' is no text in UTF-8`
    };
  }
}

/** One thing that keeps the step files of a revision from being run or stored. */
export interface WorkflowStepFileIssue {
  path: string;
  code: string;
  message: string;
}

/** The code steps of a definition, those of its loops among them. */
function codeStepsOf(
  steps: readonly WorkflowStep[]
): { id: string; file: string; field: "entry" | "file" }[] {
  return steps.flatMap((step) =>
    step.type === "loop"
      ? codeStepsOf(step.steps)
      : step.type === "code"
        ? [
            {
              id: step.id,
              file: codeEntry(step),
              field: step.entry === undefined ? ("file" as const) : ("entry" as const)
            }
          ]
        : []
  );
}

/**
 * What keeps the code steps of a revision from being run, beside what the parser checks: each
 * script exists in the revision's files, is text and is not too large. It is asked when a run
 * is started, and by whoever saves or publishes a definition.
 */
export async function codeStepIssues(
  revision: { revisionId: string; manifest: Pick<WorkflowManifest, "id" | "steps"> },
  files: WorkflowStepFiles
): Promise<WorkflowStepFileIssue[]> {
  const issues: WorkflowStepFileIssue[] = [];
  for (const step of codeStepsOf(revision.manifest.steps)) {
    const read = await readCodeFile(
      files,
      { workflow: revision.manifest.id, revisionId: revision.revisionId },
      step.file
    );
    if ("code" in read) issues.push({ path: `steps.${step.id}.${step.field}`, ...read });
  }
  return issues;
}

/** One step file as a revision holds it: its path in the Workflow's folder and its text. */
export interface WorkflowStepFile {
  /** Such as `steps/check.py`. */
  path: string;
  content: string;
}

/** The bytes of one of a revision's step files, or nothing where it holds none of that path. */
export function stepFileBytes(
  files: readonly WorkflowStepFile[],
  path: string
): Uint8Array | undefined {
  const file = files.find((candidate) => candidate.path === path);
  return file === undefined ? undefined : new TextEncoder().encode(file.content);
}

/** Inline source validation: bounded bytes, safe distinct paths, storable text and entries. */
export function workflowStepFileIssues(
  manifest: Pick<WorkflowManifest, "steps">,
  files: readonly WorkflowStepFile[],
  limits: WorkflowSourceLimits = WORKFLOW_SOURCE_DEFAULTS
): WorkflowStepFileIssue[] {
  const issues = workflowSourceIssues(
    files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, "utf8") })),
    limits
  );
  for (const { path, content } of files) {
    if (!isStorableText(content))
      issues.push({
        path,
        code: WORKFLOW_CODE_ERRORS.fileInvalid,
        message: `The file '${path}' is no storable text`
      });
  }
  for (const step of codeStepsOf(manifest.steps)) {
    if (!files.some((file) => file.path === step.file))
      issues.push({
        path: `steps.${step.id}.${step.field}`,
        code: WORKFLOW_CODE_ERRORS.fileMissing,
        message: `The Workflow has no file '${step.file}'`
      });
  }
  return issues;
}

/** The refusal of step files that cannot be run, for a save, a publish and a start alike. */
export function workflowStepFilesRefusal(
  workflow: string,
  issues: readonly WorkflowStepFileIssue[]
): AppError {
  return new AppError(
    "VALIDATION_FAILED",
    `The definition of the Workflow '${workflow}' cannot be run: ${issues[0]?.message ?? ""}`,
    { reason: issues[0]?.code ?? "definition_invalid", issues: [...issues] }
  );
}
