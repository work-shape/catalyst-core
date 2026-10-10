/** One file of a Page as its author wrote it, or as the build made it. */
export interface PageFile {
  /** Relative to the Page's folder, with `/` between segments. */
  path: string;
  bytes: Uint8Array;
}

/** Why a build refused a file, where the reason has a name a caller can act on. */
export type PageBuildErrorCode =
  | "manifest_invalid"
  | "file_invalid"
  | "inline_event_handler"
  | "external_resource"
  | "import_unavailable"
  | "syntax"
  | "routes_invalid"
  | "output_too_large";

/** One thing the author has to change, with the file and, where known, the place in it. */
export interface PageBuildError {
  file: string;
  /** Counts from 1. */
  line?: number;
  /** Counts from 1. */
  column?: number;
  message: string;
  code?: PageBuildErrorCode;
  /** The tag name, for an error about one element of an HTML file. */
  element?: string;
  /** The attribute name, for an error about one attribute. */
  attribute?: string;
}

/** One page of a React Page, derived from its route files. */
export interface PageRoute {
  path: string;
}

export type PageBuildResult =
  | {
      status: "built";
      /** The validated manifest with what the build derived: `entry` and, for routes, `pages`. */
      manifest: Record<string, unknown>;
      kitVersion: string;
      files: PageFile[];
    }
  | { status: "errors"; errors: PageBuildError[] };
