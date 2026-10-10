// What the worker and the tools need of a Page build: its names, limits and types, and the
// reader of what a build left behind. Nothing here loads the bundler or the route generator;
// those are reached through `@vivd-catalyst/app-build/build` and run in the sandbox only.
export {
  APP_KIT_PACKAGE,
  KIT_IMPORT_NAMES,
  KIT_RUNTIME_PATH,
  RELEASED_KIT_VERSIONS,
  kitFilePath,
  kitImportPath
} from "./kit";
export {
  DEFAULT_PAGE_BUILD_LIMITS,
  PAGE_BUILD_COMMAND,
  PAGE_BUILD_FILES_DIRECTORY,
  PAGE_BUILD_INPUT_DIRECTORY,
  PAGE_BUILD_MAX_ERRORS,
  PAGE_BUILD_MAX_OUTPUT_BYTES,
  PAGE_BUILD_MAX_OUTPUT_DEPTH,
  PAGE_BUILD_MAX_OUTPUT_ENTRIES,
  PAGE_BUILD_MAX_OUTPUT_FILES,
  PAGE_BUILD_MAX_RESULT_BYTES,
  PAGE_BUILD_OUTPUT_DIRECTORY,
  PAGE_BUILD_RESULT_FILE,
  PAGE_BUILD_TIMEOUT_MS,
  type PageBuildLimits
} from "./limits";
export { PAGE_MANIFEST_FILE, type BuiltPageManifest, type PageManifest } from "./manifest";
export { readPageBuildOutput, type PageBuildResultFile } from "./output";
export { pageBuildCommandFile } from "./command-file";
export type {
  PageBuildError,
  PageBuildErrorCode,
  PageBuildFailure,
  PageBuildOutcome,
  PageBuildResult,
  PageFile,
  PageRoute
} from "./types";
