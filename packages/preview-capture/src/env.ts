/** The service never loads a deployment env file. Its Compose environment is explicit. */
export function readCaptureEnvironment(): Record<string, string | undefined> {
  return process.env;
}
