// A Page is built by a command in the sandbox the instance runs agent commands in: a container
// without a network, with a read-only root and one writable directory. The worker writes the
// Page's files into `in/` of that directory, the command writes the built files and a result
// into `out/`, and the worker reads `out/` back as data it does not trust.

/** The command of the build, as the runner image installs it on its path. */
export const PAGE_BUILD_COMMAND = "catalyst-page-build";
/** Where the worker puts the files of the Page, below the build's directory. */
export const PAGE_BUILD_INPUT_DIRECTORY = "in";
/** Where the build writes, below the build's directory. */
export const PAGE_BUILD_OUTPUT_DIRECTORY = "out";
/** The built files, below the output directory. */
export const PAGE_BUILD_FILES_DIRECTORY = "files";
/** What the build says about its outcome, below the output directory. */
export const PAGE_BUILD_RESULT_FILE = "result.json";

/** How long one build may take. After it the container is removed and the save fails. */
export const PAGE_BUILD_TIMEOUT_MS = 60_000;
/** What the built files of one Page may weigh in all. */
export const PAGE_BUILD_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
/** How many built files one Page may have. A file set holds 500 files, source and built. */
export const PAGE_BUILD_MAX_OUTPUT_FILES = 500;
/** The largest `result.json` that is read. It holds a manifest or at most 50 errors. */
export const PAGE_BUILD_MAX_RESULT_BYTES = 256 * 1024;
/** How deep the built files may be nested. A path has at most 512 characters. */
export const PAGE_BUILD_MAX_OUTPUT_DEPTH = 32;
/**
 * How many names the worker looks at in a build's output, files and directories together.
 * Directories hold no bytes, so the limit on files alone would let a build make the worker
 * walk any number of them.
 */
export const PAGE_BUILD_MAX_OUTPUT_ENTRIES = 2000;
/** How many errors one build reports. */
export const PAGE_BUILD_MAX_ERRORS = 50;
/** How long one reported error message may be. */
export const PAGE_BUILD_MAX_MESSAGE_CHARS = 2000;

export interface PageBuildLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxOutputFiles: number;
}

export const DEFAULT_PAGE_BUILD_LIMITS: PageBuildLimits = {
  timeoutMs: PAGE_BUILD_TIMEOUT_MS,
  maxOutputBytes: PAGE_BUILD_MAX_OUTPUT_BYTES,
  maxOutputFiles: PAGE_BUILD_MAX_OUTPUT_FILES
};
