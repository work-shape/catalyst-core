/** Structured process logging, supplied by the client assembly. */
export interface Logger {
  debug(input: unknown, message?: string): void;
  info(input: unknown, message?: string): void;
  warn(input: unknown, message?: string): void;
  error(input: unknown, message?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * The mark of a value no log may hold. A logger writes an object that carries this key as the
 * string under it and never walks into it, wherever the object sits in a record: as a field,
 * in a list, or inside an error and its cause. The mark is a property of the object itself,
 * so a copy of the object's entries does not carry it and is written as it is.
 */
export const LOG_REDACTION: unique symbol = Symbol.for("vivd-catalyst.log-redaction");
