/** The variables this package reads by a fixed name. */
export interface ConfigCliEnv {
  readonly CATALYST_API_KEY?: string | undefined;
}

export function readConfigCliEnv(env?: ConfigCliEnv): ConfigCliEnv {
  return env ?? process.env;
}
