/** Why a build refused a file, where the reason has a name a caller can act on. */
export type PageBuildErrorCode =
  | "manifest_invalid"
  | "file_invalid"
  | "inline_event_handler"
  | "external_resource"
  | "import_unavailable"
  | "syntax"
  | "routes_invalid"
  | "action_invalid"
  | "connection_not_declared"
  | "cache_not_available"
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
