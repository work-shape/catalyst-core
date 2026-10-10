/**
 * Native tools inherit the whole environment of this process. Which variables a child may see
 * is a decision of its own; this module only keeps the read in one place.
 */
export function readDocumentExecutionEnv(): NodeJS.ProcessEnv {
  return process.env;
}
