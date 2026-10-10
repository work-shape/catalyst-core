/**
 * The class and the code of an error, for a log. Its message is left out: a database error
 * quotes the values of its statement there, and a connection error names the host and the
 * account.
 */
export function describeWithoutMessage(error: unknown): { errorClass: string; code?: string } {
  const errorClass = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return code === undefined ? { errorClass } : { errorClass, code };
}
