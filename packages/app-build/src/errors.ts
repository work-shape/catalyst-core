/** Why a build refused a file, where the reason has a name a caller can act on. */
export const PAGE_BUILD_ERROR_CODES = [
  "manifest_invalid",
  "file_invalid",
  "inline_event_handler",
  "external_resource",
  "import_unavailable",
  "syntax",
  "runtime_rule",
  "routes_invalid",
  "action_invalid",
  "connection_not_declared",
  "data_store_not_declared",
  "cache_not_available",
  "sql_target_not_available",
  "sql_statement_not_allowed",
  "key_reserved",
  "output_too_large"
] as const;

export type PageBuildErrorCode = (typeof PAGE_BUILD_ERROR_CODES)[number];

/** One thing the author has to change, with the file and, where known, the place in it. */
export interface PageBuildError {
  file: string;
  /** Counts from 1. */
  line?: number;
  /** Counts from 1. */
  column?: number;
  message: string;
  /** The authoring rule and its repair, for runtime_rule refusals. */
  rule?: string;
  sentence?: string;
  fix?: string;
  code?: PageBuildErrorCode;
  /** The tag name, for an error about one element of an HTML file. */
  element?: string;
  /** The attribute name, for an error about one attribute. */
  attribute?: string;
}
