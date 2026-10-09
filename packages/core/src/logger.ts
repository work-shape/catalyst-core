/** Structured process logging, supplied by the client assembly. */
export interface Logger {
  debug(input: unknown, message?: string): void;
  info(input: unknown, message?: string): void;
  warn(input: unknown, message?: string): void;
  error(input: unknown, message?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}
