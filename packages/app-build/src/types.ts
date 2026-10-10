import type { PageBuildError } from "./errors";
import type { BuiltPageManifest } from "./manifest";

export type { PageBuildError, PageBuildErrorCode } from "./errors";

/** One file of a Page as its author wrote it, or as the build made it. */
export interface PageFile {
  /** Relative to the Page's folder, with `/` between segments. */
  path: string;
  bytes: Uint8Array;
}

/** One page of a React Page, derived from its route files. */
export interface PageRoute {
  path: string;
}

export type PageBuildResult =
  | {
      status: "built";
      /** The validated manifest with what the build derived: `entry` and, for routes, `pages`. */
      manifest: BuiltPageManifest;
      kitVersion: string;
      files: PageFile[];
    }
  | { status: "errors"; errors: PageBuildError[] };

/** Why a build gave no result that is about the Page's files. */
export type PageBuildFailure =
  "timeout" | "out_of_memory" | "command_missing" | "output_refused" | "crashed" | "stopped";

export type PageBuildOutcome =
  | PageBuildResult
  | {
      status: "failed";
      reason: PageBuildFailure;
      message: string;
      /** What the build wrote as an error, for the log of the worker. Never shown. */
      detail?: string;
    };
