/** The variables this package reads by a fixed name. */
interface NamedConfigCliEnv {
  CATALYST_API_KEY?: string | undefined;
  CHAT_UI_ORIGIN?: string | undefined;
}

// Local auth seeding also reads the email variable that the instance configuration names.
export type ConfigCliEnv = Readonly<NamedConfigCliEnv & Record<string, string | undefined>>;

export function readConfigCliEnv(env?: ConfigCliEnv): ConfigCliEnv {
  return env ?? process.env;
}
