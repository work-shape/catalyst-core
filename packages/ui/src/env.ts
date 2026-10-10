// The library has no Node types. A bundler replaces the expression; without one there is no
// `process`, and the library behaves as in production.
declare const process: { env: { NODE_ENV?: string } };

/** True in a development build. The one place this package reads the environment. */
export function isDevelopment(): boolean {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}
