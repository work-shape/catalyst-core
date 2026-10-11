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

/**
 * The fixed reason code an error carries in its details, for a log beside its class and code:
 * `egress_denied`, `egress_unresolved`, `connection_unavailable`. Only a short word of lower
 * case letters, digits and underscores is a code. Anything else is left out, so no sentence
 * is written.
 *
 * The check is of the shape, not of a fixed set: it cannot tell a code from other text of
 * that shape. So `details.reason` is a contract. Whoever throws puts a code constant there
 * and nothing else, never text of a caller and never text an outside system sent.
 */
export function reasonCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("details" in error)) return undefined;
  const { details } = error;
  if (typeof details !== "object" || details === null || !("reason" in details)) return undefined;
  const { reason } = details;
  return typeof reason === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(reason) ? reason : undefined;
}
