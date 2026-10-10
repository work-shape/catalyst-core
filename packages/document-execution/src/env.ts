export const DOCUMENT_EXECUTION_ENV_NAMES = {
  PATH: "PATH",
  HOME: "HOME",
  TMPDIR: "TMPDIR",
  LANG: "LANG"
} as const;

/** Native tools inherit only these host variables; caller values override or extend them. */
export function readDocumentExecutionEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of Object.values(DOCUMENT_EXECUTION_ENV_NAMES)) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}
